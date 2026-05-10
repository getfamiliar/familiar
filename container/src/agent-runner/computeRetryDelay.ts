import type { APICallError } from "@ai-sdk/provider";

/** Exponential backoff base — first retry waits this many milliseconds. */
const INITIAL_DELAY_MS = 2000;

/** Each subsequent attempt multiplies the previous delay by this factor. */
const BACKOFF_FACTOR = 2;

/** Hard cap — no single wait exceeds this (5 minutes). */
const MAX_DELAY_MS = 5 * 60 * 1000;

/**
 * Decide how long to wait before re-running a postponed agentrun
 * after a retryable inference error. Mirrors the Vercel AI SDK's
 * `retryWithExponentialBackoffRespectingRetryHeaders` helper: prefer
 * provider-supplied `retry-after-ms` (milliseconds) or `retry-after`
 * (seconds, or HTTP-date) when present and reasonable, else fall
 * back to exponential backoff seeded with the current `attempt`
 * count (0 for the first retry).
 *
 * The returned value is always non-negative and capped at
 * {@link MAX_DELAY_MS}.
 */
export function computeRetryDelay(err: APICallError, attempt: number): number {
    const fallback = exponentialBackoff(attempt);
    const headers = err.responseHeaders;
    if (!headers) {
        return fallback;
    }

    const fromMs = readRetryAfterMs(headers["retry-after-ms"]);
    if (fromMs !== null) {
        return clamp(fromMs, fallback);
    }

    const fromSeconds = readRetryAfter(headers["retry-after"]);
    if (fromSeconds !== null) {
        return clamp(fromSeconds, fallback);
    }

    return fallback;
}

/** Exponential backoff for retry attempt `n` (0-indexed). */
function exponentialBackoff(attempt: number): number {
    const safe = attempt < 0 ? 0 : attempt;
    return Math.min(INITIAL_DELAY_MS * BACKOFF_FACTOR ** safe, MAX_DELAY_MS);
}

/** Parse a `retry-after-ms` header: numeric milliseconds. */
function readRetryAfterMs(raw: string | undefined): number | null {
    if (!raw) {
        return null;
    }
    const ms = Number.parseFloat(raw);
    return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/**
 * Parse a `retry-after` header: numeric seconds *or* an HTTP-date
 * (RFC 7231) interpreted as an absolute moment. We follow the SDK's
 * tolerance window — anything > 60 seconds is sanity-checked
 * against the exponential fallback (clamp picks the smaller).
 */
function readRetryAfter(raw: string | undefined): number | null {
    if (!raw) {
        return null;
    }
    const seconds = Number.parseFloat(raw);
    if (Number.isFinite(seconds) && seconds >= 0) {
        return seconds * 1000;
    }
    const dateMs = Date.parse(raw);
    if (Number.isFinite(dateMs)) {
        const offset = dateMs - Date.now();
        return offset > 0 ? offset : 0;
    }
    return null;
}

/**
 * Trust the header when its delay is "reasonable" — under a minute
 * or shorter than the exponential fallback would have been.
 * Otherwise prefer the fallback so a misconfigured upstream can't
 * park us for hours. Identical heuristic to the Vercel SDK's
 * `getRetryDelayInMs`.
 */
function clamp(headerMs: number, fallback: number): number {
    if (headerMs < 60_000 || headerMs < fallback) {
        return Math.min(headerMs, MAX_DELAY_MS);
    }
    return fallback;
}
