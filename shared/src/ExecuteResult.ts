import type { RateLimitInfo, StreamEvent, UsageCounters } from "./StreamEvent";

/**
 * Aggregate figures extracted from the terminal `result` event, plus the
 * most recent rate-limit state seen on the stream (if any).
 */
export interface ExecuteSummary {
    readonly durationMs: number;
    readonly durationApiMs: number;
    readonly numTurns: number;
    readonly totalCostUsd: number;
    readonly usage: UsageCounters;
    readonly isError: boolean;
    readonly rateLimit?: RateLimitInfo;
}

/**
 * Result of a single `AgentClient.execute` call: the session id to resume
 * with, the final assistant text, the full event trace, and a summary of
 * the run's duration/cost/token usage.
 */
export interface ExecuteResult {
    readonly sessionId: string;
    readonly result: string;
    readonly events: readonly StreamEvent[];
    readonly summary: ExecuteSummary;
}
