import {
    AGENTRUNS_CHANNEL,
    type AgentRunBus,
    type AgentRunRow,
    type EventBus,
    type InferenceEventBus,
    type Logger,
    type NewStepResult,
    type NotificationHandler,
    type PostgresConnection,
    type ScheduledHandlerBus,
    type StepResultBus,
} from "@getfamiliar/shared";
import type { AgentRunner, AgentRunnerContext } from "./agent-runner/AgentRunner.js";
import { AgentRunTimeoutError } from "./agent-runner/AgentRunTimeoutError.js";
import { formatInferenceError } from "./agent-runner/formatInferenceError.js";
import { RetryableModelException } from "./agent-runner/RetryableModelException.js";
import type { ChatManager } from "./chat/ChatManager.js";
import type { McpClientPool } from "./mcp/McpClientPool.js";
import type { PluginToolsClient } from "./plugins/ToolsClient.js";
import type { AgentrunRecovery } from "./recovery/AgentrunRecovery.js";
import type { Clock, TimerHandle } from "./testing/MockClock.js";
import { buildContainerToolRunContext } from "./tools/ContainerToolRunContext.js";
import { createGroupLookup } from "./tools/ToolGroupLoader.js";
import { ToolsFactory } from "./tools/ToolsFactory.js";

/**
 * Deps the {@link AgentrunScheduler} takes from the outside. Production
 * wiring assembles real implementations of each (postgres-backed
 * buses, real clock, etc.); tests pass mocks from `shared/testing` and
 * `container/src/testing`.
 *
 * The Scheduler intentionally does not own any of these — every dep is
 * injected so a single class is exercised end-to-end in unit tests.
 */
export interface SchedulerDeps {
    readonly agentRunBus: AgentRunBus;
    readonly eventBus: EventBus;
    readonly stepBus: StepResultBus;
    /**
     * Audit-table client for `inference_events`. The Scheduler wraps it
     * in `recordInferenceEvent` on the {@link AgentRunnerContext} and
     * swallows any write error — an audit-table outage must not turn
     * a successful agentrun into a failed one.
     */
    readonly inferenceEventBus: InferenceEventBus;
    readonly scheduledHandlerBus: ScheduledHandlerBus;
    /**
     * IANA timezone string — typically `core.timezone` forwarded by
     * the host through `CORE_TIMEZONE` and resolved by
     * `getCoreTimezone()`. Threaded into agent-facing tools that need
     * to convert between wall-clock and UTC (currently
     * `schedule_handler` / `get_scheduled_handlers`).
     */
    readonly timezone: string;
    readonly log: Logger;
    readonly clock: Clock;
    /**
     * Factory for the per-row {@link AgentRunner}. Production returns
     * `new AgentRunner()`; tests slot in `MockAgentRunner` instances.
     * The row is passed in case a future runner implementation wants
     * to vary by handler type.
     */
    readonly runnerFactory: (row: AgentRunRow) => AgentRunner;
    /** Pool used to assemble MCP tools per runner. */
    readonly mcpPool: Pick<McpClientPool, "tools" | "mcpKeysById">;
    /** Bastion client used to fetch plugin tools per runner. */
    readonly pluginToolsClient: Pick<PluginToolsClient, "tools">;
    /** Shared chat manager — methods take `eventId` per call. */
    readonly chat: Pick<ChatManager, "fetchHistory" | "appendAssistantMessage">;
    /** Startup recovery helper. Implementations expose `recover()` only. */
    readonly recovery: Pick<AgentrunRecovery, "recover">;
    /**
     * Per-*step* wall-clock budget for `agent.generate()` progress.
     * The Scheduler arms a single timer with this budget at start,
     * resets it on every completed SDK step (via the
     * `onStepFinished` callback the runner fires from the SDK's
     * `onStepFinish`), and pauses it while a runner is parked on
     * `waitForSubagent` (so a slow child handler does not consume
     * the parent's step budget). The cap catches a single wedged
     * step (hung tool call, stuck model) without penalising
     * long-but-healthy runs of many short steps.
     */
    readonly stepTimeoutMs: number;
    /** Default retry cap; overridden per-handler via YAML frontmatter. */
    readonly retryCap: number;
    /**
     * Maximum number of runners executing (not paused) at once. Today
     * always `1` to match Featherless's single Pro slot; per-model
     * fan-out becomes a future change to the picker, not a new
     * concept.
     */
    readonly maxConcurrentExecuting: number;
    /**
     * Subscribe to "something might have changed, recheck eligibility"
     * signals. Production passes a closure that registers on
     * `agentruns_changed` via {@link PostgresConnection.listen}; tests
     * pass a closure that hooks into `MockAgentRunBus.subscribe`.
     *
     * The Scheduler also wakes itself internally on every run
     * settlement, so this hook is strictly additive (catches inserts
     * the Scheduler didn't perform — root agentruns from the
     * input-event watcher being the main case).
     */
    readonly subscribeChanges: (handler: () => void) => () => void;
}

interface Waiter {
    readonly childId: string;
    readonly resolve: (row: AgentRunRow) => void;
    readonly reject: (err: Error) => void;
}

interface ActiveAgent {
    readonly id: string;
    /** Resolves with the runner's final text or rejects with the runner's error. */
    readonly runPromise: Promise<string>;
    readonly abortController: AbortController;
    /** Parked `waitForSubagent` calls, keyed by the child agentrun id. */
    readonly waiters: Map<string, Waiter>;
    /** `true` while the runner is parked on at least one waiter. */
    paused: boolean;
    /**
     * Active per-step timeout. Re-armed on every completed step via
     * {@link AgentrunScheduler.resetStepTimeout}; cleared during pauses
     * and re-armed (with a fresh full step budget) on resume.
     */
    timeoutHandle: TimerHandle | null;
}

/**
 * Outcome the Scheduler classifies a run-promise resolution into. The
 * settlement code uses these to choose between `settle(done)`,
 * `settle(failed)`, and `postpone`.
 */
type RunOutcome =
    | { readonly kind: "ok"; readonly text: string }
    | { readonly kind: "retryable"; readonly error: RetryableModelException }
    | { readonly kind: "timeout"; readonly error: AgentRunTimeoutError }
    | { readonly kind: "shutdown" }
    | { readonly kind: "failed"; readonly error: Error };

/**
 * Owns the entire agentrun runtime inside the container — replaces
 * the older `AgentrunWatcher`.
 *
 * Responsibilities:
 *
 * 1. **Disaster recovery.** On `start()`, run the recovery helper to
 *    unwind anything left in `running` / `waiting` by a previous
 *    daemon, and re-pend events stuck in `running`.
 * 2. **Single source of truth on what's executing.** Holds an
 *    in-memory map of `ActiveAgent` records. The map distinguishes
 *    *executing* (making progress / model calls) from *paused*
 *    (parked on `waitForSubagent`). Concurrency is gated on the
 *    executing count alone.
 * 3. **Picking next work.** `pickAndDispatch()` reads eligible
 *    pending rows from the bus, prefers ones already in the map
 *    (resume candidates), and starts or resumes them until the
 *    executing limit is reached.
 * 4. **Subagent suspension.** When the call_handler tool calls
 *    `waitForSubagent(childId)` via the per-runner closure, the
 *    Scheduler flips the parent to `waiting`, pauses its timeout,
 *    and parks a promise. When the awaited child settles AND every
 *    `calltype='called'` sibling is also settled, the parent moves
 *    `waiting → pending` and the next pick picks it up as a resume.
 * 5. **Timeouts, retries, failure routing.** Owns the abort
 *    controller, the per-step timer (reset on every completed step
 *    via the runner's `onStepFinished` callback, paused during
 *    `waitForSubagent`), and the classification of run promise
 *    outcomes (ok / retryable / timeout / shutdown / failed). The
 *    runner stays free of any DB / lifecycle plumbing.
 */
export class AgentrunScheduler {
    private readonly active = new Map<string, ActiveAgent>();
    /** Re-entry guard for {@link pickAndDispatch}. */
    private dispatching = false;
    private dispatchAgain = false;
    private isShuttingDown = false;

    constructor(private readonly deps: SchedulerDeps) {}

    /**
     * Long-running entry. Returns when `signal` aborts and all
     * in-flight runners have unwound.
     */
    async start(signal: AbortSignal): Promise<void> {
        const { log } = this.deps;
        log.info("agentrun scheduler starting");

        await this.deps.recovery.recover();

        const unsubscribe = this.deps.subscribeChanges(() => this.tick());

        // Pull whatever the recovery exposed before we register for
        // wake hints — covers the cold-start case where no NOTIFY
        // would arrive (rows already pending from the start).
        this.tick();

        // Block until shutdown.
        await new Promise<void>((resolve) => {
            const onAbort = () => {
                signal.removeEventListener("abort", onAbort);
                resolve();
            };
            if (signal.aborted) {
                resolve();
                return;
            }
            signal.addEventListener("abort", onAbort, { once: true });
        });

        log.info("agentrun scheduler shutting down");
        this.isShuttingDown = true;
        unsubscribe();

        // Abort every active runner. The runners' promises settle with
        // an AbortError; `onRunSettled` short-circuits the DB writes
        // (recovery on next start will sweep). Wait for all of them
        // to unwind before returning.
        for (const active of this.active.values()) {
            active.abortController.abort(new Error("scheduler shutdown"));
            if (active.timeoutHandle !== null) {
                this.deps.clock.clearTimeout(active.timeoutHandle);
                active.timeoutHandle = null;
            }
        }
        const inflight = [...this.active.values()].map((a) =>
            a.runPromise.then(
                () => undefined,
                () => undefined,
            ),
        );
        await Promise.allSettled(inflight);
        this.active.clear();
        log.info("agentrun scheduler stopped");
    }

    /**
     * Public wake hint. Idempotent and re-entrant — concurrent calls
     * coalesce. NOTIFY handlers and the internal "a run just settled"
     * path both end up here.
     */
    tick(): void {
        if (this.dispatching) {
            this.dispatchAgain = true;
            return;
        }
        void this.runPickLoop();
    }

    /**
     * Re-entrant pick loop: each tick triggers at least one
     * `pickAndDispatch` pass. If another tick lands while a pass is
     * in flight, we restart once the current pass completes. This
     * guarantees the picker has seen every state change without
     * stacking parallel picks.
     */
    private async runPickLoop(): Promise<void> {
        this.dispatching = true;
        try {
            do {
                this.dispatchAgain = false;
                await this.pickAndDispatch();
            } while (this.dispatchAgain);
        } finally {
            this.dispatching = false;
        }
    }

    private async pickAndDispatch(): Promise<void> {
        if (this.isShuttingDown) {
            return;
        }
        const eligible = await this.deps.agentRunBus.listEligible();
        if (eligible.length === 0) {
            return;
        }

        // Prefer resume candidates (already in the active map, paused).
        // listEligible returns by (priority desc, id asc); we preserve
        // that order within each partition.
        const resumeCandidates: AgentRunRow[] = [];
        const freshCandidates: AgentRunRow[] = [];
        for (const row of eligible) {
            if (this.active.has(row.id)) {
                resumeCandidates.push(row);
            } else {
                freshCandidates.push(row);
            }
        }
        const candidates = [...resumeCandidates, ...freshCandidates];

        for (const row of candidates) {
            if (this.executingCount() >= this.deps.maxConcurrentExecuting) {
                break;
            }
            if (this.active.has(row.id)) {
                await this.resumePaused(row);
            } else {
                await this.startFresh(row);
            }
        }
    }

    /** Count of runners currently executing (not paused). */
    private executingCount(): number {
        let n = 0;
        for (const a of this.active.values()) {
            if (!a.paused) {
                n++;
            }
        }
        return n;
    }

    /**
     * Begin a fresh runner for `row`. Inserts the map entry, builds
     * the context (including the per-row `waitForSubagent` closure),
     * and launches `runner.run(ctx)` fire-and-forget.
     */
    private async startFresh(row: AgentRunRow): Promise<void> {
        const { agentRunBus, log, runnerFactory } = this.deps;

        await agentRunBus.update(row.id, { state: "running" });

        const abortController = new AbortController();
        const active: ActiveAgent = {
            id: row.id,
            runPromise: undefined as unknown as Promise<string>, // filled below
            abortController,
            waiters: new Map(),
            paused: false,
            timeoutHandle: null,
        };
        active.timeoutHandle = this.armTimeout(active);

        const ctx = await this.buildContext(row, active);
        const runner = runnerFactory(row);
        const parentSuffix = row.parentAgentrunId ? ` (parent=${row.parentAgentrunId})` : "";
        log.info(
            { agentrunId: row.id, topic: row.topic, handler: row.handler },
            `agentrun ${row.id} started [${row.topic}/${row.handler}]${parentSuffix}`,
        );

        const runPromise = runner.run(ctx);
        (active as { runPromise: Promise<string> }).runPromise = runPromise;
        this.active.set(row.id, active);

        // Hook completion / failure asynchronously. No await — startFresh
        // returns once the runner is launched.
        runPromise.then(
            (text) => this.onRunSettled(row.id, { kind: "ok", text }),
            (err) => this.onRunSettled(row.id, this.classifyError(err)),
        );
    }

    /**
     * Resume a paused runner. Flips state `pending → running` (the
     * parent transitions to `pending` when its last called child
     * settled), arms a fresh full per-step timeout for the resumed
     * step (the tool call that triggered `waitForSubagent` is about
     * to return; the SDK continues that step until its next
     * `onStepFinish`), marks the entry executing, and resolves every
     * parked waiter with its corresponding child's settled row. Tool
     * callbacks unblock; the runner's `agent.generate` continues from
     * the next step.
     */
    private async resumePaused(row: AgentRunRow): Promise<void> {
        const { agentRunBus } = this.deps;
        const active = this.active.get(row.id);
        if (!active) {
            // Defensive: pickAndDispatch only routes here when the
            // row is in the active map.
            return;
        }

        await agentRunBus.update(row.id, { state: "running" });

        active.paused = false;
        active.timeoutHandle = this.armTimeout(active);

        // Resolve every parked waiter. Fetch each child's settled row
        // through the bus so the tool callback receives an up-to-date
        // snapshot (including resultText / error).
        const entries = [...active.waiters.entries()];
        active.waiters.clear();
        for (const [childId, waiter] of entries) {
            const child = await agentRunBus.getById(childId);
            if (!child) {
                waiter.reject(new Error(`child agentrun ${childId} disappeared`));
                continue;
            }
            waiter.resolve(child);
        }
    }

    /**
     * The per-runner `waitForSubagent` callback handed into the tools
     * via `ToolsFactoryContext`. Suspends the parent and returns a
     * promise that resolves once the Scheduler decides the parent can
     * resume.
     */
    private async waitForSubagent(parentId: string, childId: string): Promise<AgentRunRow> {
        const { agentRunBus, clock } = this.deps;
        const active = this.active.get(parentId);
        if (!active) {
            throw new Error(`waitForSubagent: parent ${parentId} is not in the active map`);
        }

        // First waiter in this pause window: stop the timer, mark
        // paused, flip DB state. The parent is parked mid-step inside
        // the tool call that triggered this — its step timer must not
        // tick while the child runs through its own (possibly many)
        // steps. On resume we arm a fresh full step budget for the
        // continuation of the suspended step.
        // Subsequent waiters from parallel tool calls skip the
        // bookkeeping — the parent is already paused.
        if (!active.paused) {
            if (active.timeoutHandle !== null) {
                clock.clearTimeout(active.timeoutHandle);
                active.timeoutHandle = null;
            }
            active.paused = true;
            await agentRunBus.update(parentId, { state: "waiting" });
            // Pausing freed our executing slot — let the picker run.
            this.tick();
        }

        return new Promise<AgentRunRow>((resolve, reject) => {
            active.waiters.set(childId, { childId, resolve, reject });
        });
    }

    /**
     * Settle the run-promise outcome. Owns every DB write that
     * follows a runner reaching the end of its `run()` call —
     * `settle(done)`, `settle(failed)`, or `postpone`. After the
     * write, may transition a parent `waiting → pending` (which
     * `pickAndDispatch` will pick up as a resume candidate).
     */
    private async onRunSettled(id: string, outcome: RunOutcome): Promise<void> {
        const { agentRunBus, log } = this.deps;
        const active = this.active.get(id);
        if (active) {
            if (active.timeoutHandle !== null) {
                this.deps.clock.clearTimeout(active.timeoutHandle);
                active.timeoutHandle = null;
            }
            this.active.delete(id);
        }

        if (this.isShuttingDown) {
            // Recovery on next startup will sweep these. Skip the
            // settle write so we don't race the orphan-recovery
            // helper.
            return;
        }

        const row = await agentRunBus.getById(id);
        if (!row) {
            log.warn({ agentrunId: id }, "onRunSettled: row vanished before settle");
            return;
        }

        try {
            switch (outcome.kind) {
                case "ok":
                    await agentRunBus.settle(id, "done", { resultText: outcome.text });
                    log.info({ agentrunId: id }, `agentrun ${id} done`);
                    break;
                case "retryable": {
                    const cap = outcome.error.handlerMaxRetriesOverride ?? this.deps.retryCap;
                    if (row.retryCount + 1 < cap) {
                        const runAfter = new Date(this.deps.clock.now() + outcome.error.delayMs);
                        await agentRunBus.postpone(id, runAfter, outcome.error.errorText);
                        log.warn(
                            {
                                agentrunId: id,
                                retryAfterMs: outcome.error.delayMs,
                                attempt: row.retryCount + 1,
                                cap,
                            },
                            "agentrun postponed, retryable inference error",
                        );
                        // Schedule a wake when the not_before window opens.
                        this.deps.clock.setTimeout(() => this.tick(), outcome.error.delayMs);
                    } else {
                        log.warn({ agentrunId: id, cap }, "agentrun retry cap reached, failing");
                        await agentRunBus.settle(id, "failed", {
                            error: outcome.error.errorText,
                        });
                    }
                    break;
                }
                case "timeout":
                    await agentRunBus.settle(id, "failed", {
                        error: outcome.error.message,
                    });
                    log.warn(
                        { agentrunId: id, elapsedMs: outcome.error.elapsedMs },
                        "agentrun timed out",
                    );
                    break;
                case "shutdown":
                    // Mirror the isShuttingDown short-circuit above for
                    // races where the abort fires just before the flag
                    // flip. Skip settle; recovery handles it.
                    return;
                case "failed":
                    await agentRunBus.settle(id, "failed", {
                        error: formatInferenceError(outcome.error),
                    });
                    log.error(
                        {
                            agentrunId: id,
                            err: outcome.error.message,
                        },
                        `agentrun ${id} failed`,
                    );
                    break;
            }
        } catch (settleErr) {
            log.error(
                {
                    agentrunId: id,
                    err: settleErr instanceof Error ? settleErr.message : String(settleErr),
                },
                "failed to settle agentrun",
            );
        }

        // If this was a called child, check whether the parent can now
        // leave `waiting`. The parent is re-pended (which the picker
        // will resolve as a resume).
        if (row.calltype === "called" && row.parentAgentrunId) {
            const parentId = row.parentAgentrunId;
            const allDone = await agentRunBus.areAllCalledChildrenSettled(parentId);
            if (allDone) {
                const parent = await agentRunBus.getById(parentId);
                if (parent?.state === "waiting") {
                    await agentRunBus.update(parentId, { state: "pending" });
                }
            }
        }

        // A row finishing frees a slot and possibly a parent — kick the
        // picker either way.
        this.tick();
    }

    /**
     * Translate whatever bubbled out of `runner.run` into the
     * Scheduler's outcome union. Shutdown is detected via the abort
     * signal's reason, since the runner just rethrows during a
     * shutdown abort.
     */
    private classifyError(err: unknown): RunOutcome {
        if (err instanceof RetryableModelException) {
            return { kind: "retryable", error: err };
        }
        if (err instanceof AgentRunTimeoutError) {
            return { kind: "timeout", error: err };
        }
        // AbortError caused by shutdown.
        if (
            err instanceof Error &&
            (err.name === "AbortError" || /aborted|cancell?ed/i.test(err.message)) &&
            this.isShuttingDown
        ) {
            return { kind: "shutdown" };
        }
        if (err instanceof Error) {
            return { kind: "failed", error: err };
        }
        return { kind: "failed", error: new Error(String(err)) };
    }

    /** Arm a fresh per-step timeout with the configured budget. */
    private armTimeout(active: ActiveAgent): TimerHandle {
        const start = this.deps.clock.now();
        const budget = this.deps.stepTimeoutMs;
        return this.deps.clock.setTimeout(() => {
            const elapsed = this.deps.clock.now() - start;
            active.abortController.abort(new AgentRunTimeoutError(elapsed));
        }, budget);
    }

    /**
     * Reset the per-step timeout after a successful SDK step. Called
     * from the per-row `onStepFinished` closure threaded into the
     * runner context. No-ops while paused as a defence in depth — the
     * SDK shouldn't be emitting steps while the runner is parked on
     * `waitForSubagent`, but if it did we'd otherwise re-arm a timer
     * the pause path just cleared.
     */
    private resetStepTimeout(active: ActiveAgent): void {
        if (active.paused) {
            return;
        }
        if (active.timeoutHandle !== null) {
            this.deps.clock.clearTimeout(active.timeoutHandle);
            active.timeoutHandle = null;
        }
        active.timeoutHandle = this.armTimeout(active);
    }

    /**
     * Build the {@link AgentRunnerContext} the per-row runner receives.
     * Closures over `active` so `waitForSubagent` and `recordStep` can
     * read / mutate the right map entry.
     */
    private async buildContext(row: AgentRunRow, active: ActiveAgent): Promise<AgentRunnerContext> {
        const {
            agentRunBus,
            eventBus,
            stepBus,
            inferenceEventBus,
            scheduledHandlerBus,
            timezone,
            mcpPool,
            pluginToolsClient,
            chat,
            log,
        } = this.deps;
        const waitForSubagent = (childId: string) => this.waitForSubagent(row.id, childId);

        const runnerLog = log.child({
            component: "agent-runner",
            agentrunId: row.id,
            topic: row.topic,
            handler: row.handler,
        });

        return {
            row,
            signal: active.abortController.signal,
            waitForSubagent,
            buildTools: async (toolsExpression, offloadTokenThreshold) => {
                const toolRunContext = buildContainerToolRunContext(
                    row.eventId,
                    offloadTokenThreshold,
                );
                const pluginToolset = await pluginToolsClient.tools(
                    row.eventId,
                    row.id,
                    offloadTokenThreshold,
                );
                return ToolsFactory.build({
                    chat,
                    eventId: row.eventId,
                    toolsExpression,
                    groups: createGroupLookup(),
                    bus: agentRunBus,
                    scheduledHandlerBus,
                    timezone,
                    parent: row,
                    waitForSubagent,
                    mcpTools: mcpPool.tools(),
                    mcpKeysById: mcpPool.mcpKeysById(),
                    pluginTools: pluginToolset.tools,
                    pluginKeysById: pluginToolset.keysById,
                    pluginGroupKeys: pluginToolset.groupKeys,
                    toolRunContext,
                    log,
                });
            },
            eventsView: eventBus,
            agentRunsView: agentRunBus,
            chat,
            recordStep: async (step: NewStepResult) => {
                await stepBus.add(step);
            },
            onStepFinished: () => this.resetStepTimeout(active),
            stampModel: async (model, systemPrompt) => {
                await agentRunBus.update(row.id, {
                    model,
                    ...(systemPrompt === null ? {} : { systemPrompt }),
                });
            },
            stampInitialMessages: async (messages) => {
                await agentRunBus.update(row.id, { initialMessages: messages });
            },
            recordInferenceEvent: async (event) => {
                try {
                    await inferenceEventBus.add(event);
                } catch (err) {
                    runnerLog.warn(
                        { err: err instanceof Error ? err.message : String(err) },
                        `failed to write inference_events row for agentrun #${row.id} ` +
                            `(${event.provider}/${event.model} ${event.outcome}) — ` +
                            "audit signal will be missing this attempt",
                    );
                }
            },
            log: runnerLog,
        };
    }
}

/**
 * Production wiring helper for the Scheduler's `subscribeChanges`
 * dependency. Subscribes to `agentruns_changed` on the postgres
 * connection and calls `handler` on every NOTIFY (the payload is
 * discarded — the Scheduler only needs the wake hint).
 */
export function subscribeAgentrunsChanges(
    connection: PostgresConnection,
    handler: () => void,
): () => void {
    const wrapper: NotificationHandler = () => handler();
    void connection.listen(AGENTRUNS_CHANNEL, wrapper);
    let disposed = false;
    return () => {
        if (disposed) {
            return;
        }
        disposed = true;
        void connection.unlisten(AGENTRUNS_CHANNEL, wrapper);
    };
}
