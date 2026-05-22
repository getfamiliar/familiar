/**
 * Thrown by {@link AgentRunner.run} (or surfaced via the Scheduler's
 * AbortSignal) when the per-*step* timeout expired before the current
 * `agent.generate()` step could finish.
 *
 * The {@link AgentrunScheduler} owns the timeout — it builds the
 * AbortController, arms `clock.setTimeout` for the configured per-step
 * budget, resets the timer on every completed step (via the
 * `onStepFinished` callback the runner fires from the SDK's
 * `onStepFinish`), and pauses the timer while the runner is parked on
 * `waitForSubagent` (so a slow child handler does not consume the
 * parent's step budget). When the budget is exhausted, the Scheduler
 * aborts via the signal; the runner converts the abort into this typed
 * error so the Scheduler can settle the row with a clear message.
 */
export class AgentRunTimeoutError extends Error {
    readonly elapsedMs: number;

    constructor(elapsedMs: number) {
        super(`agentrun step timed out after ${elapsedMs} ms of execution`);
        this.name = "AgentRunTimeoutError";
        this.elapsedMs = elapsedMs;
    }
}
