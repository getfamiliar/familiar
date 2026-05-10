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
import type { McpClientPool } from "../mcp/McpClientPool.js";
import { ModelFactory } from "../models/ModelFactory.js";
import { buildPrompt, buildSystemPrompt } from "../PromptBuilder.js";
import { createGroupLookup } from "../tools/ToolGroupLoader.js";
import { ToolsFactory } from "../tools/ToolsFactory.js";
import { synthesizeResultText } from "./synthesizeResultText.js";

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
    private readonly mcpPool: McpClientPool;
    private stepStartedAt = 0;

    constructor(
        row: AgentRunRow,
        connection: PostgresConnection,
        log: Logger,
        mcpPool: McpClientPool,
    ) {
        this.row = row;
        this.steps = new StepResultBus(connection);
        this.chat = new ChatManager(new ChatMessageBus(connection));
        this.bus = new AgentRunBus(connection, log);
        this.log = log;
        this.mcpPool = mcpPool;
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
            toolsExpression: handler.header.tools,
            groups: createGroupLookup(),
            bus: this.bus,
            parent: this.row,
            mcpTools: this.mcpPool.tools(),
            mcpKeysById: this.mcpPool.mcpKeysById(),
            log: this.log,
        });
        const toolNames = Object.keys(tools);
        const toolList =
            toolNames.length === 0
                ? "(no tools)"
                : `${toolNames.length} tools — ${toolNames.join(", ")}`;
        this.log.info(`agentrun toolset resolved: ${toolList}`);
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
        // `chatmessages` only carries rows linked to chat events, so a
        // non-empty history is the unambiguous signal that the user's
        // trailing turn is already in `messages` via that channel.
        // EventWatcher writes the same text onto `row.prompt` for
        // inspection purposes, but feeding it through buildPrompt as a
        // user message here would inject it twice. Skip the seed
        // prompt in that case; payload rendering still goes through
        // either way, so structured supplementary data remains visible
        // to the model.
        const seedPrompt = history.length > 0 ? null : this.row.prompt;
        const prompt = buildPrompt(seedPrompt, this.row.payload);

        // The agent's `instructions` (system prompt — SOUL.md,
        // ENVIRONMENT.md, CONTEXT.md, handler body, tool list) is
        // attached at construction time. `messages` carries everything
        // that varies per-call: prior chat turns (non-empty only for
        // chat events) plus, for non-chat events, the agentrun's seed
        // prompt + sanitized payload appended as the trailing user
        // message when non-empty.
        const messages: ModelMessage[] = [...history];
        if (prompt.length > 0) {
            messages.push({ role: "user", content: prompt });
        }

        const runStartedAt = Date.now();
        this.log.debug(
            {
                model: handler.header.model,
                temperature: handler.header.temperature,
                maxOutputTokens: handler.header.maxOutputTokens,
                systemPrompt: systemPrompt,
                prompt,
                runPrompt: this.row.prompt,
                tools: toolNames,
                historyMessages: history.length,
                promptLength: prompt.length,
            },
            "agent starting",
        );

        const result = await agent.generate({
            messages,
            abortSignal: signal,
            onStepFinish: (step) => this.recordStep(step),
        });

        const finalText = synthesizeResultText(result);

        this.log.debug(
            {
                durationMs: Date.now() - runStartedAt,
                steps: result.steps.length,
                finishReason: result.finishReason,
                inputTokens: result.usage?.inputTokens,
                outputTokens: result.usage?.outputTokens,
                resultTextLength: result.text.length,
                synthesized: finalText !== result.text,
            },
            "agent done",
        );

        // outputChat: handlers can opt to surface the model's plain
        // text reply as an assistant chat message — useful for models
        // that reliably reply as text rather than calling `send_chat`.
        // Skip empty text (e.g. tool-only steps on non-targeted finish
        // reasons; targeted reasons get a synthesized diagnostic via
        // synthesizeResultText so they always have something to post).
        if (handler.header.outputChat === true && finalText.trim().length > 0) {
            await this.chat.appendAssistantMessage(this.row.eventId, finalText);
        }

        return finalText;
    }

    /**
     * Persist one step into `stepresults`. Awaited inside the SDK's
     * `onStepFinish` so step writes are sequential and any insert
     * failure aborts the current `generate` call.
     */
    private async recordStep(step: {
        readonly stepNumber: number;
        readonly finishReason: string;
        readonly rawFinishReason?: string;
        readonly text: string;
        readonly reasoningText: string | undefined;
        readonly content?: ReadonlyArray<unknown>;
        readonly warnings?: ReadonlyArray<unknown>;
        readonly usage: { readonly inputTokens?: number; readonly outputTokens?: number };
        readonly toolCalls: unknown;
        readonly toolResults: unknown;
    }): Promise<void> {
        const durationMs = this.stepStartedAt > 0 ? Date.now() - this.stepStartedAt : null;
        // For unsuccessful finish reasons (`other`, `error`, `unknown`)
        // dump the raw provider info at warn level so the operator
        // can diagnose without enabling debug logging on the whole
        // daemon. `content` carries every block the model emitted,
        // including any blocks the SDK couldn't classify into
        // text/tool-call/reasoning — exactly the bucket that turns
        // into "other".
        const isInconclusive =
            step.finishReason === "other" ||
            step.finishReason === "error" ||
            step.finishReason === "unknown";
        const logLevel: "warn" | "debug" = isInconclusive ? "warn" : "debug";
        this.log[logLevel](
            {
                stepNumber: step.stepNumber,
                durationMs,
                finishReason: step.finishReason,
                rawFinishReason: step.rawFinishReason ?? null,
                inputTokens: step.usage.inputTokens ?? null,
                outputTokens: step.usage.outputTokens ?? null,
                reasoning: step.reasoningText ?? null,
                text: step.text || null,
                toolCalls: summarizeToolCalls(step.toolCalls),
                toolResults: step.toolResults,
                contentBlocks: isInconclusive ? step.content : undefined,
                warnings: step.warnings ?? undefined,
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
