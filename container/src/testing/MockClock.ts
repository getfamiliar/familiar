/**
 * Subset of node's timer surface the Scheduler uses. The mock
 * implementation drives time forward by hand via {@link MockClock.advance}.
 */
export interface Clock {
    now(): number;
    setTimeout(handler: () => void, ms: number): TimerHandle;
    clearTimeout(handle: TimerHandle): void;
}

/**
 * Opaque timer handle. The production clock returns
 * `NodeJS.Timeout`; the mock returns its own id.
 */
export type TimerHandle = unknown;

/**
 * Production clock — thin pass-through around the global timer
 * functions. Used by the Scheduler in real (host-driven) runs.
 */
export const RealClock: Clock = {
    now: () => Date.now(),
    setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as NodeJS.Timeout),
};

interface PendingTimer {
    readonly id: number;
    readonly fireAt: number;
    readonly handler: () => void;
}

/**
 * Deterministic clock for unit tests. Wall-clock time only advances
 * when {@link advance} is called; pending timers whose `fireAt` is
 * reached fire synchronously in deadline order. Multiple timers with
 * the same deadline fire in scheduling order.
 *
 * The clock starts at `0` so timestamps in tests are trivially
 * predictable; the offset can be set via {@link setNow} if a test
 * wants a different epoch (e.g. for `not_before` math against
 * `new Date()`).
 */
export class MockClock implements Clock {
    private current = 0;
    private nextId = 1;
    private timers: PendingTimer[] = [];

    /**
     * Construct a mock clock starting at the given epoch (default 0).
     */
    constructor(startAt = 0) {
        this.current = startAt;
    }

    now(): number {
        return this.current;
    }

    /** Move the clock forward to an absolute moment. */
    setNow(absolute: number): void {
        if (absolute < this.current) {
            throw new Error(
                `MockClock.setNow: cannot go backward (now=${this.current}, requested=${absolute})`,
            );
        }
        this.fireTimersUpTo(absolute);
        this.current = absolute;
    }

    /**
     * Advance the clock by `ms`, firing every timer whose deadline
     * is reached along the way. Synchronous: timer handlers run to
     * completion before this returns.
     *
     * Note: if a fired handler schedules a new timer whose deadline
     * is within the advanced window, that new timer also fires
     * before `advance` returns — matching real timer-loop semantics.
     */
    advance(ms: number): void {
        this.setNow(this.current + ms);
    }

    setTimeout(handler: () => void, ms: number): TimerHandle {
        const id = this.nextId++;
        const fireAt = this.current + ms;
        this.timers.push({ id, fireAt, handler });
        return id;
    }

    clearTimeout(handle: TimerHandle): void {
        const id = handle as number;
        this.timers = this.timers.filter((t) => t.id !== id);
    }

    /** Count of timers currently scheduled. */
    get pendingTimers(): number {
        return this.timers.length;
    }

    private fireTimersUpTo(target: number): void {
        // Fire in deadline order. Re-evaluate on each step so handlers
        // that schedule new timers within the window participate.
        for (;;) {
            this.timers.sort((a, b) => a.fireAt - b.fireAt || a.id - b.id);
            const next = this.timers[0];
            if (!next || next.fireAt > target) {
                return;
            }
            this.current = next.fireAt;
            this.timers.shift();
            next.handler();
        }
    }
}
