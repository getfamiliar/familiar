/**
 * One model HTTP call outcome.
 *
 * - `success`  — the upstream returned a 2xx the runner accepted.
 * - `retryable` — the upstream returned 408/429/5xx or otherwise signalled
 *   transient failure; AgentRunner postponed the agentrun.
 * - `fatal`    — non-retryable upstream error (auth, malformed request,
 *   unknown model id) that immediately settled the agentrun as `failed`.
 */
export type InferenceOutcome = "success" | "retryable" | "fatal";

/** Persisted shape of an `inference_events` row. */
export interface InferenceEventRow {
    readonly id: string;
    readonly provider: string;
    readonly model: string;
    readonly agentRunId: string | null;
    readonly outcome: InferenceOutcome;
    readonly statusCode: number | null;
    readonly errorExcerpt: string | null;
    readonly occurredAt: Date;
}

/** Insert shape — `id` and `occurredAt` are filled by the DB. */
export interface NewInferenceEvent {
    readonly provider: string;
    readonly model: string;
    readonly agentRunId?: string | null;
    readonly outcome: InferenceOutcome;
    readonly statusCode?: number | null;
    readonly errorExcerpt?: string | null;
}
