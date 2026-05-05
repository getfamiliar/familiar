import { type ModelMessage, stepCountIs, ToolLoopAgent, type ToolSet } from "ai";
import {
    AgentRunBus,
    type AgentRunRow,
    ChatMessageBus,
    type Logger,
    type PostgresConnection,
    StepResultBus,
} from "effective-assistant-shared";
import { ChatManager } from "../chat/ChatManager.js";
import { HandlerFile } from "../HandlerFile.js";
import { ModelFactory } from "../models/ModelFactory.js";
import { buildPrompt, buildSystemPrompt } from "../PromptBuilder.js";
import { ToolsFactory } from "../tools/ToolsFactory.js";

/**
 * One-shot runner for a single agentrun row.
 *
 * Construction is cheap and per-row by design: the runner reads the
 * handler markdown, builds a {@link ToolLoopAgent} configured from the
 * file's YAML header, runs it once, and is then thrown away. The
 * underlying `ToolLoopAgent` is itself a lightweight settings holder;
 * the heavier work (HTTP client, provider config) lives on the
 * `LanguageModel` returned by {@link ModelFactory.build}, which can be
 * cached behind that factory once a hot path emerges.
 *
 * Call site: {@link AgentrunWatcher.handle} does
 * `await new AgentRunner(row).run()` per claimed agentrun.
 */
/**
 * Hard cap on the number of steps the agent loop may take per agentrun.
 * Prevents runaway tool-call loops with weak-tool-adherence models. The
 * SDK's own default is 20; we lower it to 15 until per-handler control
 * lands as a YAML frontmatter field.
 */
const MAX_STEPS_PER_RUN = 15;

export class AgentRunner {
    private readonly row: AgentRunRow;
    private readonly steps: StepResultBus;
    private readonly chat: ChatManager;
    private readonly bus: AgentRunBus;
    private readonly log: Logger;
    private stepStartedAt = 0;

    constructor(row: AgentRunRow, connection: PostgresConnection, log: Logger) {
        this.row = row;
        this.steps = new StepResultBus(connection);
        this.chat = new ChatManager(new ChatMessageBus(connection));
        this.bus = new AgentRunBus(connection, log);
        this.log = log;
    }

    /**
     * Resolve and parse the handler markdown for this agentrun, build a
     * {@link ToolLoopAgent} per the parsed header (model, temperature,
     * allowedTools), and run it once. Returns the agent's final text.
     *
     * The handler body is passed as the agent's `instructions` (system
     * prompt). The per-call user prompt is derived from the agentrun's
     * `prompt` and `payload` fields.
     *
     * @param signal Optional abort signal threaded into
     *   `ToolLoopAgent.generate` so an in-flight model call is
     *   interrupted when the container shuts down.
     * @throws If the handler file is missing or malformed, the model
     *   cannot be constructed (e.g. unset env vars), or the agent loop
     *   itself fails (including abort).
     */
    async run(signal?: AbortSignal): Promise<string> {
        const handler = HandlerFile.load(this.row.topic, this.row.handler);
        const model = ModelFactory.build(handler.header.model);
        const tools = ToolsFactory.build({
            chat: this.chat,
            eventId: this.row.eventId,
            allowed: handler.header.allowedTools,
            bus: this.bus,
            parent: this.row,
        });
        const toolNames = Object.keys(tools);
        const systemPrompt = buildSystemPrompt(
            handler,
            toolNames,
            this.row.topic,
            this.row.privileged,
        );

        const agent = new ToolLoopAgent<never, ToolSet>({
            model,
            tools,
            instructions: systemPrompt,
            temperature: handler.header.temperature,
            maxOutputTokens: handler.header.maxOutputTokens,
            stopWhen: stepCountIs(MAX_STEPS_PER_RUN),
            prepareStep: ({ stepNumber, messages }) => {
                this.stepStartedAt = Date.now();
                this.log.debug(
                    {
                        stepNumber,
                        messageCount: messages.length,
                    },
                    "step starting",
                );
                return {};
            },
        });

        const history = await this.chat.fetchHistory(this.row.eventId);
        const taskBrief = buildPrompt(this.row.prompt);

        // The agent's `instructions` (system prompt — SOUL.md,
        // ENVIRONMENT.md, CONTEXT.md, handler body, tool list) is
        // attached at construction time. `messages` carries everything
        // that varies per-call: prior chat turns (empty for non-chat
        // events) plus the current task brief (the agentrun's seed
        // prompt) appended as the trailing user message when non-empty.
        const messages: ModelMessage[] = [...history];
        if (taskBrief.length > 0) {
            messages.push({ role: "user", content: taskBrief });
        }

        const runStartedAt = Date.now();
        this.log.debug(
            {
                model: handler.header.model,
                temperature: handler.header.temperature,
                maxOutputTokens: handler.header.maxOutputTokens,
                systemPrompt: systemPrompt,
                taskBrief: taskBrief,
                prompt: this.row.prompt,
                tools: toolNames,
                historyMessages: history.length,
                taskBriefLength: taskBrief.length,
            },
            "agent starting",
        );

        const result = await agent.generate({
            messages,
            abortSignal: signal,
            onStepFinish: (step) => this.recordStep(step),
        });

        this.log.debug(
            {
                durationMs: Date.now() - runStartedAt,
                steps: result.steps.length,
                finishReason: result.finishReason,
                inputTokens: result.usage?.inputTokens,
                outputTokens: result.usage?.outputTokens,
                resultTextLength: result.text.length,
            },
            "agent done",
        );

        // outputChat: handlers can opt to surface the model's plain
        // text reply as an assistant chat message — useful for models
        // that reliably reply as text rather than calling `send_chat`.
        // Skip empty text (e.g. tool-only steps).
        if (handler.header.outputChat === true && result.text.trim().length > 0) {
            await this.chat.appendAssistantMessage(this.row.eventId, result.text);
        }

        return result.text;
    }

    /**
     * Persist one step into `stepresults`. Awaited inside the SDK's
     * `onStepFinish` so step writes are sequential and any insert
     * failure aborts the current `generate` call.
     */
    private async recordStep(step: {
        readonly stepNumber: number;
        readonly finishReason: string;
        readonly text: string;
        readonly reasoningText: string | undefined;
        readonly usage: { readonly inputTokens?: number; readonly outputTokens?: number };
        readonly toolCalls: unknown;
        readonly toolResults: unknown;
    }): Promise<void> {
        const durationMs = this.stepStartedAt > 0 ? Date.now() - this.stepStartedAt : null;
        this.log.debug(
            {
                stepNumber: step.stepNumber,
                durationMs,
                finishReason: step.finishReason,
                inputTokens: step.usage.inputTokens ?? null,
                outputTokens: step.usage.outputTokens ?? null,
                reasoning: step.reasoningText ?? null,
                text: step.text || null,
                toolCalls: summarizeToolCalls(step.toolCalls),
                toolResults: step.toolResults,
            },
            "step finished",
        );
        await this.steps.add({
            agentRunId: this.row.id,
            eventId: this.row.eventId,
            stepNumber: step.stepNumber,
            finishReason: step.finishReason,
            resultText: step.text || null,
            reasoningText: step.reasoningText ?? null,
            inputTokens: step.usage.inputTokens ?? null,
            outputTokens: step.usage.outputTokens ?? null,
            toolCalls: step.toolCalls,
            toolResults: step.toolResults,
        });
    }
}

/**
 * Reduce a step's `toolCalls` to a compact `{name, input}` array for
 * logging. The SDK shape is `{ toolName, input, ... }`; we strip
 * provider/internal fields so the debug line is readable. Returns the
 * raw value if it isn't an array (defensive — shouldn't happen).
 */
function summarizeToolCalls(toolCalls: unknown): unknown {
    if (!Array.isArray(toolCalls)) {
        return toolCalls;
    }
    return toolCalls.map((call) => {
        const c = call as { toolName?: unknown; input?: unknown };
        return { name: c.toolName, input: c.input };
    });
}
