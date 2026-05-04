import { type ModelMessage, ToolLoopAgent, type ToolSet } from "ai";
import {
    type AgentRunRow,
    ChatMessageBus,
    type PostgresConnection,
    StepResultBus,
} from "effective-assistant-shared";
import { ChatManager } from "../chat/ChatManager";
import { HandlerFile } from "../HandlerFile";
import { ModelFactory } from "../models/ModelFactory";
import { PromptBuilder } from "../PromptBuilder";
import { ToolsFactory } from "../tools/ToolsFactory";

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
export class AgentRunner {
    private readonly row: AgentRunRow;
    private readonly steps: StepResultBus;
    private readonly chat: ChatManager;

    constructor(row: AgentRunRow, connection: PostgresConnection) {
        this.row = row;
        this.steps = new StepResultBus(connection);
        this.chat = new ChatManager(new ChatMessageBus(connection));
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
        });
        const toolNames = Object.keys(tools);

        const agent = new ToolLoopAgent<never, ToolSet>({
            model,
            tools,
            instructions: PromptBuilder.buildSystem(handler.body, toolNames),
            temperature: handler.header.temperature,
        });

        const history = await this.chat.fetchHistory(this.row.eventId);
        const result = await this.invoke(agent, history, signal);
        return result;
    }

    /**
     * Run the agent loop. When chat history exists for this agentrun's
     * channel, pass it as `messages` so the model has full conversational
     * context. Otherwise fall back to the prompt-string path that wraps
     * the agentrun's `prompt` and `payload` for non-chat handlers.
     */
    private async invoke(
        agent: ToolLoopAgent<never, ToolSet>,
        history: readonly ModelMessage[],
        signal: AbortSignal | undefined,
    ): Promise<string> {
        if (history.length > 0) {
            const result = await agent.generate({
                messages: [...history],
                abortSignal: signal,
                onStepFinish: (step) => this.recordStep(step),
            });
            return result.text;
        }

        const prompt = PromptBuilder.buildPrompt(this.row.prompt, this.row.payload);
        const result = await agent.generate({
            prompt,
            abortSignal: signal,
            onStepFinish: (step) => this.recordStep(step),
        });
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
