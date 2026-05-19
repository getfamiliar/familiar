/**
 * Thrown by {@link AgentRunner.run} when a retryable inference error
 * (e.g. Featherless `503 over capacity`) interrupted the agent loop.
 *
 * The runner carries no DB knowledge: instead of writing the postpone
 * itself, it bubbles this exception up to the {@link AgentrunScheduler},
 * which decides — based on the row's `retry_count` and the configured
 * `inference.maxRetries` cap — whether to postpone the row or settle
 * it as `failed`.
 *
 * - `delayMs` comes from `computeRetryDelay` — either the provider's
 *   `retry-after[-ms]` header when present and reasonable, else
 *   exponential backoff capped at 5 minutes.
 * - `errorText` is `formatInferenceError(originalError)` so the
 *   Scheduler can write it verbatim onto `agentruns.error` for the
 *   in-flight attempt without having to re-format.
 */
export class RetryableModelException extends Error {
    readonly delayMs: number;
    readonly errorText: string;
    /**
     * Per-handler `maxRetries` override read from the handler's
     * frontmatter, or `undefined` when the handler didn't set one.
     * The Scheduler falls back to its configured default
     * (`inference.maxRetries`) when this is `undefined`.
     */
    readonly handlerMaxRetriesOverride: number | undefined;

    constructor(delayMs: number, errorText: string, handlerMaxRetriesOverride?: number) {
        super(errorText);
        this.name = "RetryableModelException";
        this.delayMs = delayMs;
        this.errorText = errorText;
        this.handlerMaxRetriesOverride = handlerMaxRetriesOverride;
    }
}
