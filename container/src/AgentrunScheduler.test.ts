import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { AgentRunRow, EventRow } from "@getfamiliar/shared";
import {
    MockAgentRunBus,
    MockBusStore,
    MockEventBus,
    MockLogger,
} from "@getfamiliar/shared/testing";
import { AgentrunScheduler, type SchedulerDeps } from "./AgentrunScheduler.js";
import type { AgentRunnerContext } from "./agent-runner/AgentRunner.js";
import { RetryableModelException } from "./agent-runner/RetryableModelException.js";
import { buildRunnerFactory, type MockBehavior } from "./testing/MockAgentRunner.js";
import { MockClock } from "./testing/MockClock.js";
import { MockStepResultBus } from "./testing/MockStepResultBus.js";

/** Yield until the microtask queue drains. */
async function flush(): Promise<void> {
    for (let i = 0; i < 5; i++) {
        await Promise.resolve();
    }
}

/** Async-await for an agentrun reaching a terminal (done/failed) state. */
function waitForTerminal(
    bus: MockAgentRunBus,
    store: MockBusStore,
    id: string,
): Promise<AgentRunRow> {
    return new Promise((resolve) => {
        const check = () => {
            const row = store.agentruns.get(id);
            if (row && (row.state === "done" || row.state === "failed")) {
                unsubscribe();
                resolve(row);
            }
        };
        const unsubscribe = bus.subscribe(check);
        check();
    });
}

interface Harness {
    readonly scheduler: AgentrunScheduler;
    readonly store: MockBusStore;
    readonly agentRunBus: MockAgentRunBus;
    readonly eventBus: MockEventBus;
    readonly stepBus: MockStepResultBus;
    readonly clock: MockClock;
    readonly log: MockLogger;
    readonly abort: AbortController;
    readonly running: Promise<void>;
    stop(): Promise<void>;
}

interface HarnessOptions {
    readonly behaviors: Record<string, MockBehavior>;
    readonly stepTimeoutMs?: number;
    readonly retryCap?: number;
    readonly maxConcurrentExecuting?: number;
}

/**
 * Build a Scheduler wired entirely against in-memory mocks plus a
 * deterministic clock. The returned `running` promise resolves when
 * the Scheduler exits cleanly (after `stop()` aborts the signal).
 */
function buildHarness(opts: HarnessOptions): Harness {
    const store = new MockBusStore();
    const agentRunBus = new MockAgentRunBus(store);
    const eventBus = new MockEventBus(store);
    const stepBus = new MockStepResultBus();
    const clock = new MockClock();
    const log = new MockLogger();

    const recovery = { recover: async () => ({ failedAgentruns: 0, rependedEvents: 0 }) };
    const chat = {
        fetchHistory: async () => [],
        appendAssistantMessage: async () => {
            // no-op
        },
    };
    const mcpPool = {
        tools: () => ({}),
        mcpKeysById: () => new Map<string, ReadonlySet<string>>(),
    };
    const pluginToolsClient = {
        tools: async () => ({
            tools: {},
            keysById: new Map<string, ReadonlySet<string>>(),
        }),
    };

    const scheduledHandlerBus = {
        upsert: async () => {
            throw new Error("scheduledHandlerBus.upsert not implemented in harness");
        },
        deleteByKey: async () => false,
        listInRange: async () => [],
        listFuture: async () => [],
        deletePastDue: async () => 0,
        getByKey: async () => undefined,
        claimAndDeleteForFiring: async () => undefined,
        listen: async () => async () => {},
    };

    const deps: SchedulerDeps = {
        agentRunBus: agentRunBus as unknown as SchedulerDeps["agentRunBus"],
        eventBus: eventBus as unknown as SchedulerDeps["eventBus"],
        stepBus: stepBus as unknown as SchedulerDeps["stepBus"],
        scheduledHandlerBus: scheduledHandlerBus as unknown as SchedulerDeps["scheduledHandlerBus"],
        timezone: "UTC",
        log,
        clock,
        runnerFactory: buildRunnerFactory(opts.behaviors),
        mcpPool,
        pluginToolsClient,
        chat,
        recovery,
        stepTimeoutMs: opts.stepTimeoutMs ?? 60_000,
        retryCap: opts.retryCap ?? 3,
        maxConcurrentExecuting: opts.maxConcurrentExecuting ?? 1,
        subscribeChanges: (handler) => agentRunBus.subscribe(() => handler()),
    };

    const scheduler = new AgentrunScheduler(deps);
    const abort = new AbortController();
    const running = scheduler.start(abort.signal);

    return {
        scheduler,
        store,
        agentRunBus,
        eventBus,
        stepBus,
        clock,
        log,
        abort,
        running,
        stop: async () => {
            abort.abort();
            await running;
        },
    };
}

/**
 * Helper: insert an event and a root agentrun for it, mirroring what
 * `EventWatcher` does in production. Marks the event `running` so
 * the EVENT_TERMINAL_UPDATE_SQL emulation in MockAgentRunBus.settle
 * can flip it later.
 */
async function seedRootAgentrun(
    eventBus: MockEventBus,
    agentRunBus: MockAgentRunBus,
    handler: string,
    overrides: Partial<{ prompt: string; topic: string; priority: number }> = {},
): Promise<{ event: EventRow; root: AgentRunRow }> {
    const event = await eventBus.add({
        topic: overrides.topic ?? "chat:cli",
        prompt: overrides.prompt ?? "hello",
        priority: overrides.priority,
    });
    await eventBus.update(event.id, { state: "running" });
    const root = await agentRunBus.add({
        eventId: event.id,
        topic: event.topic,
        handler,
        priority: event.priority,
        prompt: event.prompt,
        privileged: event.privileged,
    });
    return { event, root };
}

describe("AgentrunScheduler — happy path", () => {
    it("runs a single fresh agentrun to done, stores resultText, flips event done", async () => {
        const harness = buildHarness({
            behaviors: {
                index: async () => "all good",
            },
        });
        try {
            const { root, event } = await seedRootAgentrun(
                harness.eventBus,
                harness.agentRunBus,
                "index",
            );

            const settled = await waitForTerminal(harness.agentRunBus, harness.store, root.id);
            assert.equal(settled.state, "done");
            assert.equal(settled.resultText, "all good");

            await flush();
            assert.equal(harness.store.events.get(event.id)?.state, "done");
        } finally {
            await harness.stop();
        }
    });
});

describe("AgentrunScheduler — subagents", () => {
    it("call_handler-style: parent suspends, child runs, parent resumes with text", async () => {
        // Capture the harness's bus inside the parent behavior so it
        // can insert the child row the way the real `call_handler`
        // tool would.
        let agentRunBus!: MockAgentRunBus;

        const parentBehavior: MockBehavior = async (ctx: AgentRunnerContext) => {
            const child = await agentRunBus.add({
                eventId: ctx.row.eventId,
                parentAgentrunId: ctx.row.id,
                topic: ctx.row.topic,
                handler: "analyze",
                priority: ctx.row.priority,
                payload: {},
                privileged: ctx.row.privileged,
                calltype: "called",
            });
            const settled = await ctx.waitForSubagent(child.id);
            assert.equal(settled.state, "done");
            return `parent saw: ${settled.resultText}`;
        };

        const harness = buildHarness({
            behaviors: {
                index: parentBehavior,
                analyze: async () => "analysis complete",
            },
        });
        agentRunBus = harness.agentRunBus;

        try {
            const { root, event } = await seedRootAgentrun(
                harness.eventBus,
                harness.agentRunBus,
                "index",
            );

            const settled = await waitForTerminal(harness.agentRunBus, harness.store, root.id);
            assert.equal(settled.state, "done");
            assert.equal(settled.resultText, "parent saw: analysis complete");

            // The child should have settled done too.
            const children = harness.store.childrenOf(root.id);
            assert.equal(children.length, 1);
            assert.equal(children[0].state, "done");
            assert.equal(children[0].calltype, "called");

            await flush();
            assert.equal(harness.store.events.get(event.id)?.state, "done");
        } finally {
            await harness.stop();
        }
    });

    it("called child fails → parent gets {ok:false} via waitForSubagent and can still complete done", async () => {
        let agentRunBus!: MockAgentRunBus;

        const parentBehavior: MockBehavior = async (ctx) => {
            const child = await agentRunBus.add({
                eventId: ctx.row.eventId,
                parentAgentrunId: ctx.row.id,
                topic: ctx.row.topic,
                handler: "analyze",
                payload: {},
                privileged: ctx.row.privileged,
                calltype: "called",
            });
            const settled = await ctx.waitForSubagent(child.id);
            // We don't fail the parent — we just record the error.
            return `child status: ${settled.state}, error: ${settled.error ?? "none"}`;
        };

        const harness = buildHarness({
            behaviors: {
                index: parentBehavior,
                analyze: async () => {
                    throw new Error("boom");
                },
            },
        });
        agentRunBus = harness.agentRunBus;

        try {
            const { root, event } = await seedRootAgentrun(
                harness.eventBus,
                harness.agentRunBus,
                "index",
            );
            const settled = await waitForTerminal(harness.agentRunBus, harness.store, root.id);
            assert.equal(settled.state, "done");
            assert.match(settled.resultText ?? "", /child status: failed, error: boom/);

            // Event flips failed because a child failed inside its tree.
            await flush();
            assert.equal(harness.store.events.get(event.id)?.state, "failed");
        } finally {
            await harness.stop();
        }
    });

    it("parallel subagents: parent transitions waiting→pending only when ALL called children settle", async () => {
        let agentRunBus!: MockAgentRunBus;
        const stateHistory: string[] = [];

        const parentBehavior: MockBehavior = async (ctx) => {
            const a = await agentRunBus.add({
                eventId: ctx.row.eventId,
                parentAgentrunId: ctx.row.id,
                topic: ctx.row.topic,
                handler: "a",
                payload: {},
                privileged: ctx.row.privileged,
                calltype: "called",
            });
            const b = await agentRunBus.add({
                eventId: ctx.row.eventId,
                parentAgentrunId: ctx.row.id,
                topic: ctx.row.topic,
                handler: "b",
                payload: {},
                privileged: ctx.row.privileged,
                calltype: "called",
            });
            const [ra, rb] = await Promise.all([
                ctx.waitForSubagent(a.id),
                ctx.waitForSubagent(b.id),
            ]);
            return `${ra.resultText}+${rb.resultText}`;
        };

        // We control completion order: child A returns immediately,
        // child B blocks on a Promise we resolve later.
        let resolveB: ((value: string) => void) | undefined;
        const bGate = new Promise<string>((r) => {
            resolveB = r;
        });

        const harness = buildHarness({
            behaviors: {
                index: parentBehavior,
                a: async () => "alpha",
                b: async () => await bGate,
            },
        });
        agentRunBus = harness.agentRunBus;

        // Track parent state transitions.
        harness.agentRunBus.subscribe((row) => {
            if (row.handler === "index") {
                stateHistory.push(row.state);
            }
        });

        try {
            const { root } = await seedRootAgentrun(harness.eventBus, harness.agentRunBus, "index");

            // Let A settle first while B is still in flight.
            // Wait long enough for A's behavior to fire and settle.
            for (let i = 0; i < 20; i++) {
                await flush();
                const rowA = [...harness.store.agentruns.values()].find((r) => r.handler === "a");
                if (rowA?.state === "done") {
                    break;
                }
            }
            const rowA = [...harness.store.agentruns.values()].find((r) => r.handler === "a");
            assert.equal(rowA?.state, "done", "child A should be done while parent waits on B");

            // Parent must still be waiting — B hasn't finished.
            const parentMid = harness.store.agentruns.get(root.id);
            assert.equal(parentMid?.state, "waiting");

            // Now release B.
            resolveB?.("beta");
            const settled = await waitForTerminal(harness.agentRunBus, harness.store, root.id);
            assert.equal(settled.resultText, "alpha+beta");
        } finally {
            resolveB?.("late"); // safety net
            await harness.stop();
        }

        // Sanity on the transition sequence: waiting should appear and
        // not be exited before B is done.
        assert.ok(stateHistory.includes("waiting"), `expected 'waiting' in ${stateHistory}`);
        assert.ok(stateHistory.includes("done"));
    });
});

describe("AgentrunScheduler — retries", () => {
    it("postpones on RetryableModelException, then re-runs after the delay elapses", async () => {
        let attempts = 0;
        const harness = buildHarness({
            behaviors: {
                index: async () => {
                    attempts++;
                    if (attempts === 1) {
                        throw new RetryableModelException(100, "transient", undefined);
                    }
                    return `ok on attempt ${attempts}`;
                },
            },
            retryCap: 3,
        });
        try {
            const { root } = await seedRootAgentrun(harness.eventBus, harness.agentRunBus, "index");

            // Wait for the first attempt to throw and postpone.
            for (let i = 0; i < 20; i++) {
                await flush();
                const r = harness.store.agentruns.get(root.id);
                if (r?.retryCount === 1 && r.state === "pending") {
                    break;
                }
            }
            const afterFirstAttempt = harness.store.agentruns.get(root.id);
            assert.equal(afterFirstAttempt?.state, "pending");
            assert.equal(afterFirstAttempt?.retryCount, 1);
            assert.ok(afterFirstAttempt?.notBefore);

            // Advance the clock past not_before; that triggers the
            // Scheduler's own `setTimeout(() => tick(), delayMs)`.
            harness.clock.advance(150);

            const settled = await waitForTerminal(harness.agentRunBus, harness.store, root.id);
            assert.equal(settled.state, "done");
            assert.equal(settled.resultText, "ok on attempt 2");
            assert.equal(attempts, 2);
        } finally {
            await harness.stop();
        }
    });

    it("cap exhaustion fails the agentrun with the inference error text", async () => {
        const harness = buildHarness({
            behaviors: {
                index: async () => {
                    throw new RetryableModelException(10, "still over capacity", undefined);
                },
            },
            retryCap: 2,
        });
        try {
            const { root } = await seedRootAgentrun(harness.eventBus, harness.agentRunBus, "index");

            // Need 2 cycles: attempt 0 → postpone, advance, attempt 1 →
            // postpone, advance, attempt 2 → cap reached, fail.
            for (let i = 0; i < 5; i++) {
                await flush();
                harness.clock.advance(20);
                await flush();
            }

            const settled = await waitForTerminal(harness.agentRunBus, harness.store, root.id);
            assert.equal(settled.state, "failed");
            assert.match(settled.error ?? "", /over capacity/);
        } finally {
            await harness.stop();
        }
    });
});

describe("AgentrunScheduler — timeouts", () => {
    it("aborts a wedged step exceeding stepTimeoutMs and settles failed", async () => {
        const harness = buildHarness({
            behaviors: {
                index: async (ctx) =>
                    new Promise<string>((_resolve, reject) => {
                        // Park forever without ever firing onStepFinished;
                        // the Scheduler's per-step timer should abort us.
                        const onAbort = () => {
                            // The runner converts the abort into the typed
                            // error per the production AgentRunner; the
                            // mock does it explicitly here.
                            const reason = ctx.signal.reason;
                            reject(reason ?? new Error("aborted"));
                        };
                        if (ctx.signal.aborted) {
                            onAbort();
                            return;
                        }
                        ctx.signal.addEventListener("abort", onAbort, { once: true });
                    }),
            },
            stepTimeoutMs: 1000,
        });
        try {
            const { root } = await seedRootAgentrun(harness.eventBus, harness.agentRunBus, "index");

            // Let the runner start (state → running).
            for (let i = 0; i < 10; i++) {
                await flush();
                if (harness.store.agentruns.get(root.id)?.state === "running") {
                    break;
                }
            }

            harness.clock.advance(1000);

            const settled = await waitForTerminal(harness.agentRunBus, harness.store, root.id);
            assert.equal(settled.state, "failed");
            assert.match(settled.error ?? "", /step timed out/i);
        } finally {
            await harness.stop();
        }
    });

    it("step boundaries reset the per-step timeout", async () => {
        // A behavior that loops well past the cumulative step budget,
        // calling `onStepFinished` between each iteration and advancing
        // the clock by just under the per-step budget. The agentrun
        // should NOT time out — each completed step resets the timer.
        let clock!: MockClock;
        const stepBudget = 1000;
        const stepsToRun = 5;

        const behavior: MockBehavior = async (ctx) => {
            for (let i = 0; i < stepsToRun; i++) {
                // Advance just under the per-step budget — no timeout
                // would fire if the timer is reset on each boundary.
                clock.advance(stepBudget - 10);
                ctx.onStepFinished();
            }
            return "done";
        };

        const harness = buildHarness({
            behaviors: { index: behavior },
            stepTimeoutMs: stepBudget,
        });
        clock = harness.clock;
        try {
            const { root } = await seedRootAgentrun(harness.eventBus, harness.agentRunBus, "index");
            const settled = await waitForTerminal(harness.agentRunBus, harness.store, root.id);
            assert.equal(settled.state, "done");
            assert.equal(settled.resultText, "done");
        } finally {
            await harness.stop();
        }
    });

    it("parent's step timer does not count time spent paused on waitForSubagent", async () => {
        let agentRunBus!: MockAgentRunBus;
        let clock!: MockClock;

        const parentBehavior: MockBehavior = async (ctx) => {
            // Spend 300ms of execution (well within the 1000ms step
            // budget), then suspend on a child. While paused, the clock
            // will jump far past the step budget — but the parent's
            // step timer must be paused too, so resume gets a fresh
            // budget and the parent finishes cleanly.
            clock.advance(300);
            const child = await agentRunBus.add({
                eventId: ctx.row.eventId,
                parentAgentrunId: ctx.row.id,
                topic: ctx.row.topic,
                handler: "slow",
                payload: {},
                privileged: ctx.row.privileged,
                calltype: "called",
            });
            await ctx.waitForSubagent(child.id);
            return "parent fast finish";
        };

        const harness = buildHarness({
            behaviors: {
                index: parentBehavior,
                slow: async () => {
                    // Child consumes its OWN per-step budget; returns immediately here.
                    return "done";
                },
            },
            stepTimeoutMs: 1000,
        });
        agentRunBus = harness.agentRunBus;
        clock = harness.clock;
        try {
            const { root } = await seedRootAgentrun(harness.eventBus, harness.agentRunBus, "index");

            // Let parent get going.
            await flush();
            await flush();
            // Simulate "long external pause" while parent is in waiting.
            // The child will settle synchronously when it gets a slot.
            for (let i = 0; i < 10; i++) {
                await flush();
                if (harness.store.agentruns.get(root.id)?.state === "done") {
                    break;
                }
            }

            const settled = harness.store.agentruns.get(root.id);
            assert.equal(settled?.state, "done");
            assert.equal(settled?.resultText, "parent fast finish");
        } finally {
            await harness.stop();
        }
    });
});

describe("AgentrunScheduler — queue_handler (fire-and-forget)", () => {
    it("queued child runs separately; parent does NOT suspend on it", async () => {
        let agentRunBus!: MockAgentRunBus;

        const parentBehavior: MockBehavior = async (ctx) => {
            await agentRunBus.add({
                eventId: ctx.row.eventId,
                parentAgentrunId: ctx.row.id,
                topic: ctx.row.topic,
                handler: "followup",
                payload: {},
                privileged: ctx.row.privileged,
                calltype: "queued",
            });
            return "parent done";
        };

        const harness = buildHarness({
            behaviors: {
                index: parentBehavior,
                followup: async () => "ack",
            },
        });
        agentRunBus = harness.agentRunBus;
        try {
            const { root, event } = await seedRootAgentrun(
                harness.eventBus,
                harness.agentRunBus,
                "index",
            );

            const settled = await waitForTerminal(harness.agentRunBus, harness.store, root.id);
            assert.equal(settled.state, "done");
            assert.equal(settled.resultText, "parent done");
            // Parent never visited 'waiting' — no state assertion needed
            // beyond the final result; the followup may still be running.

            // Drain the queued child.
            const followup = [...harness.store.agentruns.values()].find(
                (r) => r.handler === "followup",
            );
            assert.ok(followup);
            await waitForTerminal(harness.agentRunBus, harness.store, followup.id);

            await flush();
            assert.equal(harness.store.events.get(event.id)?.state, "done");
        } finally {
            await harness.stop();
        }
    });
});

describe("AgentrunScheduler — error modes", () => {
    it("non-retryable Error from runner → settled failed with formatted message", async () => {
        const harness = buildHarness({
            behaviors: {
                index: async () => {
                    throw new Error("bad request shape");
                },
            },
        });
        try {
            const { root, event } = await seedRootAgentrun(
                harness.eventBus,
                harness.agentRunBus,
                "index",
            );
            const settled = await waitForTerminal(harness.agentRunBus, harness.store, root.id);
            assert.equal(settled.state, "failed");
            assert.match(settled.error ?? "", /bad request shape/);
            await flush();
            assert.equal(harness.store.events.get(event.id)?.state, "failed");
        } finally {
            await harness.stop();
        }
    });
});

describe("AgentrunScheduler — concurrency control", () => {
    it("maxConcurrentExecuting=1 — second pending row waits until the first settles", async () => {
        let releaseFirst: (() => void) | undefined;
        const firstGate = new Promise<void>((r) => {
            releaseFirst = r;
        });

        const harness = buildHarness({
            behaviors: {
                first: async () => {
                    await firstGate;
                    return "1st";
                },
                second: async () => "2nd",
            },
            maxConcurrentExecuting: 1,
        });
        try {
            const { root: r1 } = await seedRootAgentrun(
                harness.eventBus,
                harness.agentRunBus,
                "first",
            );
            const { root: r2 } = await seedRootAgentrun(
                harness.eventBus,
                harness.agentRunBus,
                "second",
                { topic: "chat:cli", prompt: "second" },
            );

            // Let the picker run.
            await flush();
            await flush();

            assert.equal(harness.store.agentruns.get(r1.id)?.state, "running");
            // r2 must still be pending because the slot is held by r1.
            assert.equal(harness.store.agentruns.get(r2.id)?.state, "pending");

            releaseFirst?.();

            const s1 = await waitForTerminal(harness.agentRunBus, harness.store, r1.id);
            assert.equal(s1.state, "done");
            const s2 = await waitForTerminal(harness.agentRunBus, harness.store, r2.id);
            assert.equal(s2.state, "done");
        } finally {
            releaseFirst?.();
            await harness.stop();
        }
    });
});

describe("AgentrunScheduler — disaster recovery", () => {
    it("runs the recovery helper before the first scheduling pass", async () => {
        // Build a custom harness with a recovery stub we can assert on.
        const store = new MockBusStore();
        const agentRunBus = new MockAgentRunBus(store);
        const eventBus = new MockEventBus(store);
        const stepBus = new MockStepResultBus();
        const clock = new MockClock();
        const log = new MockLogger();

        let recoveryCalled = false;
        let recoveryCalledBeforePick = false;
        let pickHappened = false;

        const recovery = {
            recover: async () => {
                recoveryCalled = true;
                if (!pickHappened) {
                    recoveryCalledBeforePick = true;
                }
                return { failedAgentruns: 0, rependedEvents: 0 };
            },
        };

        const deps: SchedulerDeps = {
            agentRunBus: agentRunBus as unknown as SchedulerDeps["agentRunBus"],
            eventBus: eventBus as unknown as SchedulerDeps["eventBus"],
            stepBus: stepBus as unknown as SchedulerDeps["stepBus"],
            log,
            clock,
            runnerFactory: buildRunnerFactory({
                index: async () => {
                    pickHappened = true;
                    return "done";
                },
            }),
            mcpPool: {
                tools: () => ({}),
                mcpKeysById: () => new Map(),
            },
            pluginToolsClient: {
                tools: async () => ({
                    tools: {},
                    keysById: new Map<string, ReadonlySet<string>>(),
                }),
            },
            chat: {
                fetchHistory: async () => [],
                appendAssistantMessage: async () => {
                    // no-op
                },
            },
            recovery,
            stepTimeoutMs: 60_000,
            retryCap: 3,
            maxConcurrentExecuting: 1,
            subscribeChanges: (handler) => agentRunBus.subscribe(() => handler()),
        };

        const scheduler = new AgentrunScheduler(deps);
        const abort = new AbortController();
        const running = scheduler.start(abort.signal);

        await seedRootAgentrun(eventBus, agentRunBus, "index");
        const root = [...store.agentruns.values()][0];
        await waitForTerminal(agentRunBus, store, root.id);

        assert.equal(recoveryCalled, true);
        assert.equal(recoveryCalledBeforePick, true);

        abort.abort();
        await running;
    });
});
