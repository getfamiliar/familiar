/**
 * Thrown by {@link AgentRunner.run} (or surfaced via the Scheduler's
 * AbortSignal) when the per-agentrun timeout expired before the run
 * could complete.
 *
 * The {@link AgentrunScheduler} owns the timeout — it builds the
 * AbortController, sets `clock.setTimeout` for the configured budget,
 * pauses the timer while a runner is parked on `waitForSubagent`, and
 * aborts via the signal when the budget is exhausted. The runner sees
 * the abort surface through whatever path the SDK propagates (the
 * `signal` passed into `agent.generate`) and converts it into this
 * typed error so the Scheduler can settle the row with a clear
 * message.
 */
export class AgentRunTimeoutError extends Error {
    readonly elapsedMs: number;

    constructor(elapsedMs: number) {
        super(`agentrun timed out after ${elapsedMs} ms of execution`);
        this.name = "AgentRunTimeoutError";
        this.elapsedMs = elapsedMs;
    }
}
