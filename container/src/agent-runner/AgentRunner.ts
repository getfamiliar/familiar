import { APICallError } from "@ai-sdk/provider";
import {
    type AgentRunBus,
    type AgentRunRow,
    DEFAULT_TOOL_CALL_OFFLOADING_LIMIT,
    type EventBus,
    estimateTokens,
    type Logger,
    type NewInferenceEvent,
    type NewStepResult,
} from "@getfamiliar/shared";
import { type ModelMessage, stepCountIs, ToolLoopAgent, type ToolSet } from "ai";
import type { ChatManager } from "../chat/ChatManager.js";
import { HandlerFile } from "../HandlerFile.js";
import { ModelFactory } from "../models/ModelFactory.js";
import { fetchModelMetaData } from "../models/ModelMetadataClient.js";
import {
    type BuiltSystemPrompt,
    buildPrompt,
    buildRuntimeContextBlock,
    buildScratchListing,
    buildSystemPrompt,
} from "../PromptBuilder.js";
import { PassedConfig, requireConfig } from "../utils/PassedConfig.js";
import { fetchAncestorChain } from "./AgentRunLineage.js";
import { AgentRunTimeoutError } from "./AgentRunTimeoutError.js";
import { ContextManager } from "./ContextManager.js";
import { computeRetryDelay } from "./computeRetryDelay.js";
import {
    DEFAULT_OUTPUT_FALLBACK_FRACTION,
    deriveMaxOutputTokens,
    resolveModelCeiling,
} from "./deriveMaxOutputTokens.js";
import { formatInferenceError } from "./formatInferenceError.js";
import { mergeToolErrorsIntoResults } from "./mergeToolErrorsIntoResults.js";
import { RetryableModelException } from "./RetryableModelException.js";
import { StepLimitReachedError } from "./StepLimitReachedError.js";
import { buildStepBudgetNotice } from "./stepBudgetNotice.js";
import { synthesizeResultText } from "./synthesizeResultText.js";

/**
 * When `true`, every step's full SDK result object is JSON-encoded
 * into `stepresults.raw_result`. Read once at module load from the
 * passed config key `inference.captureRawStepResultToDatabase`, so a
 * daemon restart is required to flip it. Off by default.
 */
const CAPTURE_RAW_STEP_RESULT =
    PassedConfig.get<boolean>("inference.captureRawStepResultToDatabase") ?? false;

/**
 * When `true`, the assembled initial model-message array (prior history
 * + the run's leading user turn) is JSON-encoded onto
 * `agentruns.initial_messages` right before the first `agent.generate()`
 * call. Read once at module load from the passed config key
 * `inference.captureInitialMessageHistory`, so a daemon restart is
 * required to flip it. Off by default.
 */
const CAPTURE_INITIAL_MESSAGE_HISTORY =
    PassedConfig.get<boolean>("inference.captureInitialMessageHistory") ?? false;

/**
 * Fraction of a model's context window used as the per-step output
 * ceiling when the model's metadata declares no explicit `outputLimit`.
 * Read once at module load from the passed config key
 * `inference.outputFallbackPercentage`, so a daemon restart is required
 * to change it. Defaults to {@link DEFAULT_OUTPUT_FALLBACK_FRACTION}.
 */
const OUTPUT_FALLBACK_FRACTION =
    PassedConfig.get<number>("inference.outputFallbackPercentage") ??
    DEFAULT_OUTPUT_FALLBACK_FRACTION;

/** Default number of recent steps whose tool results are kept verbatim. */
const DEFAULT_KEPT_TOOL_RESULT_COUNT = 3;

/** Default sliding-window trigger fraction of the model's context window. */
const DEFAULT_SLIDING_WINDOW_PERCENTAGE = 0.7;

/**
 * Number of recent steps whose tool results survive {@link ContextManager}
 * eviction. Read once at module load from the passed config key
 * `inference.contextManagement.keptToolResultCount`. A daemon restart is
 * required to change it. Defaults to {@link DEFAULT_KEPT_TOOL_RESULT_COUNT}.
 */
const KEPT_TOOL_RESULT_COUNT =
    PassedConfig.get<number>("inference.contextManagement.keptToolResultCount") ??
    DEFAULT_KEPT_TOOL_RESULT_COUNT;

/**
 * Clamp the configured sliding-window fraction into `(0.3, 1.0)`. Out-of-
 * range or unset values fall back to {@link DEFAULT_SLIDING_WINDOW_PERCENTAGE}
 * — the host's config linter already warns at boot, so this is the runtime
 * safety net rather than the primary signal.
 *
 * @param raw The passed config value, or `undefined` when unset.
 * @returns A fraction strictly inside `(0.3, 1.0)`.
 */
function clampSlidingWindow(raw: number | undefined): number {
    if (raw !== undefined && raw > 0.3 && raw < 1.0) {
        return raw;
    }
    return DEFAULT_SLIDING_WINDOW_PERCENTAGE;
}

/**
 * Fraction of the model's context window at which {@link ContextManager}
 * starts dropping the oldest messages. Read once at module load from the
 * passed config key `inference.contextManagement.slidingWindowPercentage`.
 * Clamped to `(0.3, 1.0)`.
 */
const SLIDING_WINDOW_PERCENTAGE = clampSlidingWindow(
    PassedConfig.get<number>("inference.contextManagement.slidingWindowPercentage"),
);

/**
 * Fraction of the model's context window used as the upper bound for an
 * inline tool result before it is offloaded to scratch. Hardcoded — the
 * tunable part is the absolute cap (see {@link TOOL_OFFLOAD_TOKEN_CAP}).
 */
const TOOL_OFFLOAD_CONTEXT_FRACTION = 0.25;

/**
 * Absolute token cap for an inline tool result, used as the ceiling in
 * `min(0.25 * contextLimit, cap)` and as the whole threshold when the
 * model's context window is unknown. Read once at module load from the
 * passed config key `core.toolCallOffloadingLimit`. Per-handler
 * `toolCallOffloadingLimit` frontmatter overrides it per run. Defaults to
 * {@link DEFAULT_TOOL_CALL_OFFLOADING_LIMIT}.
 */
const TOOL_OFFLOAD_TOKEN_CAP =
    PassedConfig.get<number>("core.toolCallOffloadingLimit") ?? DEFAULT_TOOL_CALL_OFFLOADING_LIMIT;

/**
 * Compute the per-result offload token threshold: the smaller of a
 * fraction of the model's context window and the configured cap. When the
 * context window is unknown (metadata miss) the threshold is just the cap.
 *
 * @param contextLimit The model's context window in tokens, or `undefined`.
 * @param cap The configured / per-handler token cap.
 * @returns The token threshold above which a tool result is offloaded.
 */
function computeOffloadTokenThreshold(contextLimit: number | undefined, cap: number): number {
    if (contextLimit === undefined) {
        return cap;
    }
    return Math.min(Math.ceil(TOOL_OFFLOAD_CONTEXT_FRACTION * contextLimit), cap);
}

/**
 * Pick which variant of the just-built system prompt to persist onto
 * `agentruns.system_prompt`, based on the passed config key
 * `core.logSystemPrompt`:
 *
 *   "off" / unset / unknown → `null` (no stamping).
 *   "full"                  → the verbatim prompt.
 *   "non-static"            → the variant with SOUL.md / CONTEXT.md
 *                             replaced by `<content of file …>`
 *                             placeholders.
 *
 * Unknown values fall back to `null` (no stamping) rather than throwing
 * — the lint pass has already flagged anything malformed, and the
 * audit-log knob shouldn't be able to fail an agentrun.
 */
function selectLoggedSystemPrompt(built: BuiltSystemPrompt): string | null {
    const mode = PassedConfig.get<string>("core.logSystemPrompt");
    if (mode === "full") {
        return built.full;
    }
    if (mode === "non-static") {
        return built.redacted;
    }
    return null;
}

/**
 * Hard cap on the number of steps the agent loop may take per agentrun.
 * Prevents runaway tool-call loops with weak-tool-adherence models. The
 * SDK's own default is 20; we lower it to 15 until per-handler control
 * lands as a YAML frontmatter field.
 */
const MAX_STEPS_PER_RUN = 15;

/** Max chars of an upstream error body to persist on `inference_events.error_excerpt`. */
const INFERENCE_ERROR_EXCERPT_CHARS = 200;

/** Truncate an error body for `inference_events.error_excerpt`. */
function excerpt(text: string): string {
    const trimmed = text.replace(/\s+/g, " ").trim();
    if (trimmed.length <= INFERENCE_ERROR_EXCERPT_CHARS) {
        return trimmed;
    }
    return `${trimmed.slice(0, INFERENCE_ERROR_EXCERPT_CHARS)}…`;
}

/**
 * Narrow read-only view of {@link EventBus}. The runner only needs
 * `getById` for the `isChat` gating in {@link PromptBuilder}.
 */
export type EventsView = Pick<EventBus, "getById">;

/**
 * Narrow read-only view of {@link AgentRunBus}. The runner only needs
 * `getById` for {@link fetchAncestorChain}.
 */
export type AgentRunsView = Pick<AgentRunBus, "getById">;

/**
 * Per-run context the {@link AgentrunScheduler} supplies on every
 * invocation of {@link AgentRunner.run}. Every effect that crosses
 * the runner boundary (DB writes, parent suspension, step persistence,
 * model stamping) goes through one of these callbacks; the runner
 * itself stays pure and unaware of postgres.
 */
export interface AgentRunnerContext {
    /** The agentrun this invocation is for. State is already `running`. */
    readonly row: AgentRunRow;
    /**
     * Scheduler-owned abort signal. Fires on shutdown or per-step
     * timeout (the Scheduler arms a per-step budget and resets it on
     * every completed step). The runner threads it into `agent.generate`.
     * When `signal.aborted` and `signal.reason instanceof AgentRunTimeoutError`,
     * the runner rethrows the timeout typed; for other reasons (e.g.
     * a generic shutdown abort) the underlying SDK error is rethrown
     * for the Scheduler to classify.
     */
    readonly signal: AbortSignal;
    /**
     * Build the tool set for this run from the handler's `tools:`
     * entries. The Scheduler-provided closure threads in `bus`,
     * `parent`, `mcpPool`, `pluginToolsClient`, and the per-row
     * `waitForSubagent` callback so `call_handler` is wired with
     * the right Scheduler hooks. The runner reads `handler.header.tools`,
     * computes the offload token threshold from model metadata, and
     * calls this once. The threshold flows into both the container-side
     * tool-run context and (over the gateway) the host-side plugin tools.
     */
    readonly buildTools: (
        tools: readonly string[] | undefined,
        offloadTokenThreshold: number,
        handlerPath: string,
        contextLimit: number | undefined,
    ) => Promise<ToolSet>;
    /**
     * Suspend the current run until the named child agentrun (and
     * every other `calltype='called'` sibling) has settled. The real
     * runner reaches this hook through the `call_handler` tool that
     * `buildTools` returns; it's also exposed on the context so
     * test runners can drive the same suspend semantics without
     * going through the SDK + tool plumbing.
     */
    readonly waitForSubagent: (childId: string) => Promise<AgentRunRow>;
    /** Read-only event lookup (for chat-vs-non-chat context assembly). */
    readonly eventsView: EventsView;
    /** Read-only agentrun lookup (for ancestor chain replay). */
    readonly agentRunsView: AgentRunsView;
    /** Chat-history facade for prompt assembly and `outputChat` reply. */
    readonly chat: Pick<ChatManager, "fetchHistory" | "appendAssistantMessage">;
    /**
     * Persist one step. Called from the SDK's `onStepFinish`. The
     * Scheduler's implementation forwards to `StepResultBus.add`.
     */
    readonly recordStep: (step: NewStepResult) => Promise<void>;
    /**
     * Fires after every SDK step the runner completes (right after
     * {@link recordStep} resolves). The Scheduler uses it to reset
     * the per-step timeout: each finished step is evidence the runner
     * is still making progress, so the cap restarts for the next step.
     */
    readonly onStepFinished: () => void;
    /**
     * Stamp resolved model id (and optionally the system prompt) onto
     * the agentrun row right after `ModelFactory.build`. The Scheduler
     * forwards to `AgentRunBus.update`. Done before the first
     * `agent.generate` call so the row is honest even if generate
     * throws.
     */
    readonly stampModel: (model: string, systemPrompt: string | null) => Promise<void>;
    /**
     * Stamp the assembled initial model-message array onto the agentrun
     * row, just before the first `agent.generate()`. The Scheduler
     * forwards to `AgentRunBus.update`. Only invoked when the operator
     * opted in via `inference.captureInitialMessageHistory`; otherwise
     * the column stays `null`. Kept separate from {@link stampModel}
     * because the message array is only assembled after the chat /
     * non-chat branch, well after the model is stamped.
     */
    readonly stampInitialMessages: (messages: unknown) => Promise<void>;
    /**
     * Record one inference-call outcome (success / retryable / fatal)
     * into the `inference_events` audit table. The Scheduler swallows
     * any error this raises — an audit-write failure must not be allowed
     * to turn a successful generate into a failed agentrun. Fire-and-
     * forget from the runner's perspective.
     */
    readonly recordInferenceEvent: (event: NewInferenceEvent) => Promise<void>;
    /**
     * Per-run logger child, pre-tagged with agentrun id / topic /
     * handler. The runner adds further bindings for SDK-step diagnostics.
     */
    readonly log: Logger;
}

/**
 * One-shot runner for a single agentrun row. Pure-ish: every effect
 * that touches the database, the parent's lifecycle, or per-run
 * scheduling state is delegated through the {@link AgentRunnerContext}
 * callbacks. The runner itself reads the handler markdown, builds the
 * `ToolLoopAgent`, drives one `agent.generate`, and returns the
 * synthesised final text (or throws).
 *
 * Failure modes:
 *
 * - {@link RetryableModelException} — wraps a retryable inference
 *   error (`APICallError.isRetryable === true`). Carries the
 *   computed `delayMs` plus the per-handler `maxRetries` override
 *   so the Scheduler can decide postpone-vs-fail.
 * - {@link AgentRunTimeoutError} — `ctx.signal` was aborted with a
 *   per-step timeout reason; the SDK's abort path translates to this
 *   typed exception so the Scheduler can settle with a clear message.
 * - {@link StepLimitReachedError} — the tool loop hit its hard step
 *   budget (`MAX_STEPS_PER_RUN`) before the model produced a final
 *   reply; the Scheduler settles `failed` with the message.
 * - Other `Error` — anything non-retryable: handler load failures,
 *   model construction errors, 4xx from the provider, SDK bugs.
 *   The Scheduler settles `failed` with the formatted message.
 */
export class AgentRunner {
    /**
     * Resolve and parse the handler markdown for this agentrun, build a
     * {@link ToolLoopAgent} per the parsed header (model, temperature,
     * allowedTools), and run it once. Returns the agent's final text.
     *
     * @throws {RetryableModelException} for retryable inference errors.
     * @throws {AgentRunTimeoutError} when `ctx.signal` aborts with a
     *   timeout reason.
     * @throws Generic Error for any non-retryable failure.
     */
    async run(ctx: AgentRunnerContext): Promise<string> {
        const handler = HandlerFile.load(ctx.row.topic, ctx.row.handler);
        const {
            model,
            label: modelLabel,
            provider,
            modelId,
        } = ModelFactory.build(handler.header.model);

        // Look the resolved model's capabilities up through the bastion
        // before building tools — the tool-result offload threshold is
        // derived from the context window. Best-effort: a miss or fetch
        // error resolves to `undefined` and never blocks the run; the
        // threshold then falls back to the configured cap and the sliding
        // window becomes a no-op. Also consumed below for the output cap.
        const modelMetaData = await fetchModelMetaData(
            requireConfig<string>("bastionUrl"),
            provider,
            modelId,
            ctx.log,
        );
        if (modelMetaData !== undefined) {
            ctx.log.info(
                {
                    model: modelLabel,
                    contextLimit: modelMetaData.contextLimit,
                    outputLimit: modelMetaData.outputLimit,
                    toolCall: modelMetaData.toolCall,
                    reasoning: modelMetaData.reasoning,
                },
                `model metadata for ${modelLabel}: context=${modelMetaData.contextLimit ?? "?"} output=${modelMetaData.outputLimit ?? "?"} toolCall=${modelMetaData.toolCall ?? "?"} reasoning=${modelMetaData.reasoning ?? "?"}`,
            );
        }

        // The offload cap is the per-handler frontmatter override, else the
        // config/env cap; the effective threshold is that capped by a
        // fraction of the model's context window.
        const offloadTokenCap = handler.header.toolCallOffloadingLimit ?? TOOL_OFFLOAD_TOKEN_CAP;
        const offloadTokenThreshold = computeOffloadTokenThreshold(
            modelMetaData?.contextLimit,
            offloadTokenCap,
        );
        const tools = await ctx.buildTools(
            handler.header.tools,
            offloadTokenThreshold,
            handler.relativePath,
            modelMetaData?.contextLimit,
        );
        const toolNames = Object.keys(tools);
        const toolList =
            toolNames.length === 0
                ? "(no tools)"
                : `${toolNames.length} tools — ${toolNames.join(", ")}`;
        ctx.log.info(`agentrun toolset resolved: ${toolList}`);

        const systemPrompt = buildSystemPrompt(handler, toolNames);

        // The per-run dynamic context (`# Runtime` + plugin-contributed
        // event context such as memories) no longer lives in the system
        // prompt — keeping the system prompt byte-stable per handler is
        // what makes it a cacheable prefix. This block instead leads the
        // current-run user message (see message assembly below).
        const dynamicContextBlock = await buildRuntimeContextBlock(
            handler,
            ctx.row.topic,
            ctx.row.privileged,
            toolNames,
            {
                bastionUrl: requireConfig<string>("bastionUrl"),
                eventId: ctx.row.eventId,
                agentrunId: ctx.row.id,
                log: ctx.log,
            },
        );

        // Stamp the resolved model — and, when the operator opted in
        // via core.logSystemPrompt, the resolved system prompt — on
        // the row before invoking the agent. Done through the Scheduler-
        // owned callback so the runner stays bus-free.
        //
        // Three log modes (passed config `core.logSystemPrompt`):
        //   "off"        → don't stamp.
        //   "full"       → stamp the verbatim prompt.
        //   "non-static" → stamp the variant with SOUL.md / CONTEXT.md
        //                  replaced by `<content of file …>`
        //                  placeholders so the audit log keeps the per-
        //                  run signal without the framing-file noise.
        //
        // The `# Runtime` / event-context block now rides in the user
        // message rather than the system prompt, so append it to the
        // stamped value when stamping is on — the audit record then still
        // reflects everything that was actually sent to the model.
        const loggedSystemPrompt = selectLoggedSystemPrompt(systemPrompt);
        const promptToLog =
            loggedSystemPrompt === null ? null : `${loggedSystemPrompt}\n\n${dynamicContextBlock}`;
        await ctx.stampModel(modelLabel, promptToLog);

        // Derive the per-step output cap. A handler that declares no
        // `maxOutputTokens` inherits the model's true output ceiling
        // (`outputLimit`, else a fraction of `contextLimit`); a declared
        // value is kept but clamped down to that ceiling so a handler
        // can never ask for more than the model / context allows.
        const modelCeiling = resolveModelCeiling(modelMetaData, OUTPUT_FALLBACK_FRACTION);
        const effectiveMaxOutputTokens = deriveMaxOutputTokens(
            modelMetaData,
            handler.header.maxOutputTokens,
            OUTPUT_FALLBACK_FRACTION,
        );
        ctx.log.info(
            {
                model: modelLabel,
                declared: handler.header.maxOutputTokens ?? null,
                outputLimit: modelMetaData?.outputLimit ?? null,
                contextLimit: modelMetaData?.contextLimit ?? null,
                fallbackFraction: OUTPUT_FALLBACK_FRACTION,
                modelCeiling,
                effectiveMaxOutputTokens,
            },
            `output cap for ${modelLabel}: declared=${handler.header.maxOutputTokens ?? "?"} outputLimit=${modelMetaData?.outputLimit ?? "?"} contextLimit=${modelMetaData?.contextLimit ?? "?"} fraction=${OUTPUT_FALLBACK_FRACTION} ceiling=${modelCeiling} → effective=${effectiveMaxOutputTokens}`,
        );

        // Tools only work if the model supports tool calls. Warn on every
        // run whose model isn't *confirmed* to support them — `false`
        // (known not to) and `undefined` (metadata missing or didn't say)
        // both qualify — so a handler relying on tools against an
        // unsuitable model is visible in the system log.
        if (modelMetaData?.toolCall !== true) {
            ctx.log.warn(
                { model: modelLabel, toolCall: modelMetaData?.toolCall ?? null },
                `model ${modelLabel} tool_call capability not confirmed (toolCall=${modelMetaData?.toolCall ?? "unknown"}) — tool calls may fail`,
            );
        }

        // Active context-window management: evict stale tool results and
        // slide a window over the history before each step so a long tool
        // loop doesn't overflow the model's context window.
        const contextManager = new ContextManager({
            contextLimit: modelMetaData?.contextLimit,
            keptToolResultCount: KEPT_TOOL_RESULT_COUNT,
            slidingWindowPercentage: SLIDING_WINDOW_PERCENTAGE,
            systemPromptTokens: estimateTokens(systemPrompt.full),
            log: ctx.log,
        });

        const agent = new ToolLoopAgent<never, ToolSet>({
            model,
            tools,
            instructions: systemPrompt.full,
            temperature: handler.header.temperature,
            maxOutputTokens: effectiveMaxOutputTokens,
            // The Scheduler owns retry policy via the RetryableModelException
            // throw + postpone/settle decision. Disable the SDK's own
            // retry loop so a 5-minute backoff doesn't park us.
            maxRetries: 0,
            stopWhen: stepCountIs(MAX_STEPS_PER_RUN),
            prepareStep: ({ stepNumber, messages }) => {
                const managed = contextManager.prepare(messages);
                // Tell the agent how many steps it has left as it nears
                // the cap (and force a final answer on the last step).
                // Appended after context management so the sliding window
                // can never evict it; ephemeral per step, so the count
                // stays live and nothing lands in the persisted history.
                const budgetNotice = buildStepBudgetNotice(stepNumber, MAX_STEPS_PER_RUN);
                const stepMessages: ModelMessage[] =
                    budgetNotice === null
                        ? managed
                        : [...managed, { role: "user", content: budgetNotice }];
                ctx.log.debug(
                    {
                        stepNumber,
                        messageCount: messages.length,
                        managedMessageCount: managed.length,
                        budgetNotice,
                    },
                    "step starting",
                );
                return { messages: stepMessages };
            },
        });

        // Gate context assembly on the originating event's `isChat`
        // flag AND on this run being the root of its tree. Chat events
        // feed prior turns from `chatmessages` for the root only; every
        // other agentrun (cron firings, mail ingestion, jira webhooks,
        // and any `schedule_handler` / `call_handler` descendant —
        // including descendants of a chat root) feeds the agentrun
        // lineage instead. Root-only is critical for chat events: a
        // subagent spawned mid-conversation must NOT see the live
        // channel history, otherwise the trailing user turn ("call
        // handler X") gets replayed to the subagent and triggers the
        // same call recursively.
        const event = await ctx.eventsView.getById(ctx.row.eventId);
        const isChat = event?.isChat === true && ctx.row.parentAgentrunId === null;
        const scratchListing = buildScratchListing(ctx.row.eventId);

        let messages: ModelMessage[];
        let historyMessages = 0;
        let ancestorCount = 0;
        let prompt: string;

        if (isChat) {
            const history = await ctx.chat.fetchHistory(ctx.row.eventId);
            // A non-empty history means the user's trailing turn is
            // already in `messages` via the chat-history channel.
            // EventWatcher writes the same text onto `row.prompt` for
            // inspection purposes, but feeding it through buildPrompt
            // here would inject it twice. Skip the seed prompt in
            // that case; payload rendering still goes through either
            // way.
            const seedPrompt = history.length > 0 ? null : ctx.row.prompt;
            const userBody = buildPrompt(seedPrompt, ctx.row.payload, scratchListing);
            // The dynamic context block leads the trailing user turn, after
            // the cacheable prior history.
            prompt = [dynamicContextBlock, userBody].filter((s) => s.length > 0).join("\n\n");
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
            // the parent agent's `schedule_handler` / `call_handler`,
            // never by a literal user. Tagging it `user` would falsely
            // imply user authorship.
            const ancestors = await fetchAncestorChain(ctx.agentRunsView, ctx.row.parentAgentrunId);
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
            // the model to respond. The dynamic context block leads it.
            const userBody = buildPrompt(ctx.row.prompt, ctx.row.payload, scratchListing);
            prompt = [dynamicContextBlock, userBody].filter((s) => s.length > 0).join("\n\n");
            if (prompt.length > 0) {
                messages.push({ role: "user", content: prompt });
            }
            ancestorCount = ancestors.length;
        }

        // Capture the fully-assembled message array for the audit log
        // before handing it to the model. Opt-in (off by default) since
        // it can be several KB per run; surfaced by the report layer's
        // -vv view.
        if (CAPTURE_INITIAL_MESSAGE_HISTORY) {
            await ctx.stampInitialMessages(messages);
        }

        const runStartedAt = Date.now();
        ctx.log.debug(
            {
                model: handler.header.model,
                temperature: handler.header.temperature,
                maxOutputTokens: effectiveMaxOutputTokens,
                declaredMaxOutputTokens: handler.header.maxOutputTokens ?? null,
                systemPrompt: systemPrompt.full,
                prompt,
                runPrompt: ctx.row.prompt,
                tools: toolNames,
                contextSource: isChat ? "chat-history" : "agentrun-lineage",
                historyMessages,
                ancestorCount,
                promptLength: prompt.length,
            },
            "agent starting",
        );

        let result: Awaited<ReturnType<typeof agent.generate>>;
        try {
            result = await agent.generate({
                messages,
                abortSignal: ctx.signal,
                onStepFinish: (step) =>
                    this.recordStep(ctx, step as Parameters<AgentRunner["recordStep"]>[1]),
            });
        } catch (err) {
            // Timeout / shutdown classification. The Scheduler aborts
            // the signal with a typed reason: `AgentRunTimeoutError`
            // for budget exhaustion, anything else for shutdown. Either
            // way the outcome is *not* a model-API outcome, so no
            // inference_events row is written for these paths.
            if (ctx.signal.aborted) {
                const reason = ctx.signal.reason;
                if (reason instanceof AgentRunTimeoutError) {
                    throw reason;
                }
                // Shutdown abort: rethrow the SDK error so the
                // Scheduler can classify and settle `failed`.
                throw err;
            }
            if (APICallError.isInstance(err) && err.isRetryable === true) {
                const delayMs = computeRetryDelay(err, ctx.row.retryCount);
                const errorText = formatInferenceError(err);
                ctx.log.warn(
                    {
                        retryAfterMs: delayMs,
                        attempt: ctx.row.retryCount + 1,
                        handlerMaxRetriesOverride: handler.header.maxRetries,
                        statusCode: err.statusCode,
                        url: err.url,
                    },
                    "agent generate returned a retryable inference error",
                );
                await ctx.recordInferenceEvent({
                    provider,
                    model: modelId,
                    agentRunId: ctx.row.id,
                    outcome: "retryable",
                    statusCode: typeof err.statusCode === "number" ? err.statusCode : null,
                    errorExcerpt: excerpt(errorText),
                });
                throw new RetryableModelException(delayMs, errorText, handler.header.maxRetries);
            }
            await ctx.recordInferenceEvent({
                provider,
                model: modelId,
                agentRunId: ctx.row.id,
                outcome: "fatal",
                statusCode:
                    APICallError.isInstance(err) && typeof err.statusCode === "number"
                        ? err.statusCode
                        : null,
                errorExcerpt: excerpt(err instanceof Error ? err.message : String(err)),
            });
            throw err;
        }
        await ctx.recordInferenceEvent({
            provider,
            model: modelId,
            agentRunId: ctx.row.id,
            outcome: "success",
        });

        // Step-budget cut-off. `stopWhen: stepCountIs(MAX_STEPS_PER_RUN)`
        // is a stop *condition*, not an error — the SDK resolves
        // normally when it fires. Since that is the loop's only stop
        // condition, an aggregate `tool-calls` finish reason means the
        // model still wanted to call tools when the loop was halted at
        // the cap. Surface it as a typed failure so the Scheduler
        // settles `failed` instead of marking a truncated run `done`.
        if (result.finishReason === "tool-calls") {
            throw new StepLimitReachedError(result.steps.length, MAX_STEPS_PER_RUN);
        }

        const finalText = synthesizeResultText(result);

        ctx.log.debug(
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
            await ctx.chat.appendAssistantMessage(ctx.row.eventId, finalText);
        }

        return finalText;
    }

    /**
     * Translate one SDK step into a {@link NewStepResult} and hand it
     * to the Scheduler-provided callback. Awaited inside the SDK's
     * `onStepFinish` so any failure in the recording path aborts the
     * current `generate` call.
     */
    private async recordStep(
        ctx: AgentRunnerContext,
        step: {
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
        },
    ): Promise<void> {
        const isInconclusive =
            step.finishReason === "other" ||
            step.finishReason === "error" ||
            step.finishReason === "unknown";
        const logLevel: "warn" | "debug" = isInconclusive ? "warn" : "debug";
        const persistedToolResults = mergeToolErrorsIntoResults(step.toolResults, step.content);
        ctx.log[logLevel](
            {
                stepNumber: step.stepNumber,
                finishReason: step.finishReason,
                rawFinishReason: step.rawFinishReason ?? null,
                inputTokens: step.usage.inputTokens ?? null,
                outputTokens: step.usage.outputTokens ?? null,
                reasoning: step.reasoningText ?? null,
                text: step.text || null,
                toolCalls: summarizeToolCalls(step.toolCalls),
                toolResults: persistedToolResults,
                contentBlocks: isInconclusive ? step.content : undefined,
                warnings: step.warnings ?? undefined,
            },
            "step finished",
        );
        await ctx.recordStep({
            agentRunId: ctx.row.id,
            eventId: ctx.row.eventId,
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
            toolResults: persistedToolResults,
            rawResult: CAPTURE_RAW_STEP_RESULT ? safeJsonClone(step) : undefined,
        });
        ctx.onStepFinished();
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
