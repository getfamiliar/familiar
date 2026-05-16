import { APICallError } from "@ai-sdk/provider";
import { type ModelMessage, stepCountIs, ToolLoopAgent, type ToolSet } from "ai";
import {
    AgentRunBus,
    type AgentRunRow,
    ChatMessageBus,
    EventBus,
    type Logger,
    type PostgresConnection,
    StepResultBus,
} from "@getfamiliar/shared";
import { ChatManager } from "../chat/ChatManager.js";
import { optionalEnvBool, optionalEnvInt } from "../env.js";
import { HandlerFile } from "../HandlerFile.js";
import type { McpClientPool } from "../mcp/McpClientPool.js";
import { ModelFactory } from "../models/ModelFactory.js";
import { buildPrompt, buildScratchListing, buildSystemPrompt } from "../PromptBuilder.js";
import type { PluginToolsClient } from "../plugins/ToolsClient.js";
import { createGroupLookup } from "../tools/ToolGroupLoader.js";
import { ToolsFactory } from "../tools/ToolsFactory.js";
import { fetchAncestorChain } from "./AgentRunLineage.js";
import { computeRetryDelay } from "./computeRetryDelay.js";
import { formatInferenceError } from "./formatInferenceError.js";
import { synthesizeResultText } from "./synthesizeResultText.js";

/**
 * When `true`, every step's full SDK result object is JSON-encoded
 * into `stepresults.raw_result`. Read once at module load — the host
 * sets the env var from `inference.captureRawStepResultToDatabase`,
 * so a daemon restart is required to flip it. Off by default.
 */
const CAPTURE_RAW_STEP_RESULT = optionalEnvBool("INFERENCE_CAPTURE_RAW_STEP_RESULT");

/**
 * When `true`, every agentrun's resolved system prompt is persisted
 * onto the row so the report layer can surface it in the Agentrun
 * Start section under `--details`. Driven by `core.logSystemPrompt`
 * in `config.yml`. Off by default — system prompts are several KB
 * each and only helpful while debugging.
 */
const LOG_SYSTEM_PROMPT = optionalEnvBool("INFERENCE_LOG_SYSTEM_PROMPT");

/**
 * Sentinel returned from {@link AgentRunner.run} when the agent
 * call hit a retryable inference error (e.g. Featherless 503 "over
 * capacity") and the row was put back into `pending` with a future
 * `not_before`. AgentrunWatcher checks for this and skips the
 * normal `settle("done", ...)` path.
 */
export const POSTPONED = Symbol("agentrun-postponed");
export type RunOutcome = string | typeof POSTPONED;

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
    private readonly events: EventBus;
    private readonly log: Logger;
    private readonly mcpPool: McpClientPool;
    private readonly pluginToolsClient: PluginToolsClient;
    private stepStartedAt = 0;

    constructor(
        row: AgentRunRow,
        connection: PostgresConnection,
        log: Logger,
        mcpPool: McpClientPool,
        pluginToolsClient: PluginToolsClient,
    ) {
        this.row = row;
        this.steps = new StepResultBus(connection);
        this.chat = new ChatManager(new ChatMessageBus(connection));
        this.bus = new AgentRunBus(connection, log);
        this.events = new EventBus(connection);
        this.log = log;
        this.mcpPool = mcpPool;
        this.pluginToolsClient = pluginToolsClient;
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
    async run(signal?: AbortSignal): Promise<RunOutcome> {
        const handler = HandlerFile.load(this.row.topic, this.row.handler);
        const { model, label: modelLabel } = ModelFactory.build(handler.header.model);
        // Plugin tools are fetched per-agentrun: the catalog is small,
        // the request is one loopback HTTP call, and lazy fetch dodges
        // the boot-order race between the container coming up and host
        // plugins finishing their `start(ctx)` hooks.
        const pluginToolset = await this.pluginToolsClient.tools(this.row.eventId, this.row.id);
        const tools = ToolsFactory.build({
            chat: this.chat,
            eventId: this.row.eventId,
            toolsExpression: handler.header.tools,
            groups: createGroupLookup(),
            bus: this.bus,
            parent: this.row,
            mcpTools: this.mcpPool.tools(),
            mcpKeysById: this.mcpPool.mcpKeysById(),
            pluginTools: pluginToolset.tools,
            pluginKeysById: pluginToolset.keysById,
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
        // Stamp the resolved model — and, when the operator opted in
        // via core.logSystemPrompt, the resolved system prompt — on
        // the row before invoking the agent. One UPDATE keeps the row
        // honest (even if generate() throws) without a second write.
        // Patch's `undefined` skip means the SQL only touches
        // system_prompt when LOG_SYSTEM_PROMPT is on.
        await this.bus.update(this.row.id, {
            model: modelLabel,
            systemPrompt: LOG_SYSTEM_PROMPT ? systemPrompt : undefined,
        });

        const agent = new ToolLoopAgent<never, ToolSet>({
            model,
            tools,
            instructions: systemPrompt,
            temperature: handler.header.temperature,
            maxOutputTokens: handler.header.maxOutputTokens,
            // Disable the SDK's blocking retry loop — we own retry
            // policy via postpone() so a 5-minute backoff doesn't
            // park the watcher slot. See the catch around `generate`
            // below for the postpone-or-fail decision.
            maxRetries: 0,
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

        // Gate context assembly on the originating event's `isChat`
        // flag. Chat events feed prior turns from `chatmessages`; every
        // other event (cron firings, mail ingestion, jira webhooks,
        // queue_run descendants of those) feeds the agentrun lineage
        // instead. Default-stamping put a chat channel on those events
        // for `send_chat` routing, so the channel column alone is no
        // longer a reliable "is this a chat" signal — `events.is_chat`
        // is. A missing event row (shouldn't happen for a claimed
        // agentrun) is treated as non-chat to fail safer.
        const event = await this.events.getById(this.row.eventId);
        const isChat = event?.isChat === true;
        const scratchListing = buildScratchListing(this.row.eventId);

        let messages: ModelMessage[];
        let historyMessages = 0;
        let ancestorCount = 0;
        let prompt: string;

        if (isChat) {
            const history = await this.chat.fetchHistory(this.row.eventId);
            // `chatmessages` carries rows linked to chat events, so a
            // non-empty history is the unambiguous signal that the
            // user's trailing turn is already in `messages` via that
            // channel. EventWatcher writes the same text onto
            // `row.prompt` for inspection purposes, but feeding it
            // through buildPrompt as a user message here would inject
            // it twice. Skip the seed prompt in that case; payload
            // rendering still goes through either way, so structured
            // supplementary data remains visible to the model.
            const seedPrompt = history.length > 0 ? null : this.row.prompt;
            prompt = buildPrompt(seedPrompt, this.row.payload, scratchListing);
            messages = [...history];
            if (prompt.length > 0) {
                messages.push({ role: "user", content: prompt });
            }
            historyMessages = history.length;
        } else {
            // Non-chat: synthesise prior turns from the agentrun
            // lineage. Both `prompt` and `resultText` of each ancestor
            // are assistant-side artifacts here — the prompt was
            // written by the host emitter (cron, mail plugin) or by
            // the parent agent's `queue_run`, never by a literal user.
            // Tagging it `user` would falsely imply user authorship.
            // Reasoning text from `stepresults` is intentionally
            // omitted in v1; fold it in later (inline block or
            // structured `reasoning` part) once it proves useful.
            const ancestors = await fetchAncestorChain(this.bus, this.row.parentAgentrunId);
            messages = [];
            for (const ancestor of ancestors) {
                if (ancestor.prompt !== null && ancestor.prompt.trim().length > 0) {
                    messages.push({ role: "assistant", content: ancestor.prompt });
                }
                if (ancestor.resultText !== null && ancestor.resultText.trim().length > 0) {
                    messages.push({ role: "assistant", content: ancestor.resultText });
                }
            }
            // The current run's prompt stays `user`-roled even though
            // it too is host- or parent-assistant-generated: the
            // conversational protocol expects a user turn last to cue
            // the model to respond. This is a protocol convention, not
            // a claim about authorship.
            prompt = buildPrompt(this.row.prompt, this.row.payload, scratchListing);
            if (prompt.length > 0) {
                messages.push({ role: "user", content: prompt });
            }
            ancestorCount = ancestors.length;
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
                contextSource: isChat ? "chat-history" : "agentrun-lineage",
                historyMessages,
                ancestorCount,
                promptLength: prompt.length,
            },
            "agent starting",
        );

        // The SDK's blocking retry is already disabled via the
        // ToolLoopAgent constructor (`maxRetries: 0` above). The
        // catch below catches retryable errors and postpones the
        // agentrun via `not_before`, freeing the slot for other rows;
        // the watcher re-claims when the window opens. Cap
        // precedence: handler YAML override → INFERENCE_MAX_RETRIES
        // env (set by host from `inference.maxRetries`) → hardcoded
        // fallback of 3.
        const retryCap = handler.header.maxRetries ?? optionalEnvInt("INFERENCE_MAX_RETRIES") ?? 3;

        // Hard timeout on a single generate() call. Three layers of
        // defense, because empirical experience says the SDK's own
        // abort handling can wedge:
        //
        //   1. `timeout: { totalMs }` to the SDK so it races its own
        //      AbortController against its scheduler.
        //   2. A linked AbortController of our own — fires when the
        //      timeout elapses, signals the SDK to clean up.
        //   3. `Promise.race` against a hard timeout-rejection
        //      promise so the AWAIT itself rejects even if the SDK
        //      never honours the abort. This is the load-bearing
        //      guarantee: regardless of what the SDK does, the
        //      catch below runs and the agentrun fails cleanly
        //      after `core.agentTimeout` seconds.
        //
        // The orphaned generate continues in the background until it
        // unwinds; the AbortController gives it a chance to do so
        // gracefully, and the agentrun is already settled by then so
        // its outcome doesn't matter.
        const timeoutMs = (optionalEnvInt("AGENT_TIMEOUT_SECONDS") ?? 60) * 1000;
        const timeoutController = new AbortController();
        const linkedSignal = signal
            ? AbortSignal.any([signal, timeoutController.signal])
            : timeoutController.signal;
        let timedOut = false;
        let timer: NodeJS.Timeout | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                timedOut = true;
                const err = new Error(
                    `agent generate timed out after ${timeoutMs} ms (configure via core.agentTimeout)`,
                );
                timeoutController.abort(err);
                reject(err);
            }, timeoutMs);
        });

        let result: Awaited<ReturnType<typeof agent.generate>>;
        try {
            try {
                result = await Promise.race([
                    agent.generate({
                        messages,
                        abortSignal: linkedSignal,
                        timeout: { totalMs: timeoutMs },
                        onStepFinish: (step) => this.recordStep(step),
                    }),
                    timeoutPromise,
                ]);
            } finally {
                if (timer !== undefined) {
                    clearTimeout(timer);
                }
            }
        } catch (err) {
            if (timedOut) {
                throw new Error(
                    `agent generate timed out after ${timeoutMs} ms (configure via core.agentTimeout)`,
                );
            }
            if (APICallError.isInstance(err) && err.isRetryable === true) {
                if (this.row.retryCount < retryCap) {
                    const delayMs = computeRetryDelay(err, this.row.retryCount);
                    const runAfter = new Date(Date.now() + delayMs);
                    const errorText = formatInferenceError(err);
                    await this.bus.postpone(this.row.id, runAfter, errorText);
                    this.log.warn(
                        {
                            retryAfterMs: delayMs,
                            attempt: this.row.retryCount + 1,
                            cap: retryCap,
                            statusCode: err.statusCode,
                            url: err.url,
                        },
                        "agentrun postponed, retryable inference error",
                    );
                    return POSTPONED;
                }
                this.log.warn(
                    { cap: retryCap, statusCode: err.statusCode },
                    "agentrun retry cap reached, failing",
                );
            }
            throw err;
        }

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
        readonly usage: {
            readonly inputTokens?: number;
            readonly outputTokens?: number;
            readonly inputTokenDetails?: {
                readonly noCacheTokens?: number;
                readonly cacheReadTokens?: number;
                readonly cacheWriteTokens?: number;
            };
            readonly outputTokenDetails?: {
                readonly textTokens?: number;
                readonly reasoningTokens?: number;
            };
        };
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
            inputTokensNoCache: step.usage.inputTokenDetails?.noCacheTokens ?? null,
            inputTokensCacheRead: step.usage.inputTokenDetails?.cacheReadTokens ?? null,
            inputTokensCacheWrite: step.usage.inputTokenDetails?.cacheWriteTokens ?? null,
            outputTokensText: step.usage.outputTokenDetails?.textTokens ?? null,
            outputTokensReasoning: step.usage.outputTokenDetails?.reasoningTokens ?? null,
            toolCalls: step.toolCalls,
            toolResults: step.toolResults,
            rawResult: CAPTURE_RAW_STEP_RESULT ? safeJsonClone(step) : undefined,
        });
    }
}

/**
 * JSON-serialize a step result defensively. The SDK's step object
 * is normally plain data (numbers, strings, arrays, objects), but
 * provider-specific extensions occasionally carry non-serializable
 * values (Date, BigInt, circular refs). Catch and replace with an
 * informative marker so capture never poisons the INSERT.
 */
function safeJsonClone(step: unknown): unknown {
    try {
        return JSON.parse(JSON.stringify(step));
    } catch (err) {
        return { rawCaptureError: err instanceof Error ? err.message : String(err) };
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
