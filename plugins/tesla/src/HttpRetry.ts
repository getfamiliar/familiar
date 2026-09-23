import { describeError } from "./ErrorText.js";

/**
 * Connection-level failures worth another go. These never reached
 * Tesla — DNS, the TCP connect, or the socket itself failed — so
 * retrying them is *not* the auto-retry-against-the-WAF that gets a
 * login flagged. Any HTTP answer, refusals included, is returned to
 * the caller untouched and never retried here.
 */
const RETRYABLE_CONNECT_CODES = new Set([
    "ETIMEDOUT",
    "ECONNRESET",
    "ECONNREFUSED",
    "ENOTFOUND",
    "EAI_AGAIN",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "EPIPE",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_SOCKET",
]);

/** How many extra attempts a connection-level failure gets. */
const CONNECT_RETRIES = 3;
/** Base delay between connection retries; grows linearly with the attempt. */
const CONNECT_RETRY_DELAY_MS = 600;

/**
 * Whether a thrown value is a connection-level failure rather than an
 * HTTP-level one.
 *
 * Three wrappers have to be seen through, because each layer hides the
 * real code somewhere different:
 *
 * - `AggregateError` — raised when a host resolves to several
 *   addresses and every attempt fails; its own `code` may be absent
 *   and its `message` is empty.
 * - `cause` — `fetch` reports every transport failure as the same
 *   opaque `TypeError: fetch failed`, with the real error underneath.
 * - a bare `ErrnoException` from `node:https`.
 *
 * @param err The caught value.
 * @returns True when another attempt is worth making.
 */
export function isConnectionError(err: unknown): boolean {
    if (!(err instanceof Error)) {
        return false;
    }
    const code = (err as NodeJS.ErrnoException).code;
    if (typeof code === "string" && RETRYABLE_CONNECT_CODES.has(code)) {
        return true;
    }
    if (err instanceof AggregateError && (err.errors ?? []).some(isConnectionError)) {
        return true;
    }
    return err.cause !== undefined && isConnectionError(err.cause);
}

/**
 * Run an operation, retrying it while it fails for connection-level
 * reasons.
 *
 * Intended for a flaky link (mobile tethering, a train), where a single
 * dropped connection should not turn into a failed tool call. Anything
 * that is not a connection failure propagates on the first throw.
 *
 * @param operation The request to run; called once per attempt.
 * @returns Whatever `operation` resolves with.
 * @throws The last connection error after the final attempt, or any
 *   non-connection error immediately.
 */
export async function withConnectionRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= CONNECT_RETRIES; attempt += 1) {
        try {
            return await operation();
        } catch (err) {
            if (!isConnectionError(err)) {
                throw err;
            }
            lastError = err;
            if (attempt < CONNECT_RETRIES) {
                await sleep(CONNECT_RETRY_DELAY_MS * (attempt + 1));
            }
        }
    }
    throw lastError;
}

/**
 * `fetch` with {@link withConnectionRetry} around it. The single entry
 * point for the plugin's two REST clients, so a flaky link is handled
 * once rather than per call site.
 *
 * @param url Absolute URL.
 * @param init Standard fetch init.
 * @returns The response, whatever its status — a non-2xx is an answer, not a failure.
 * @throws When every attempt fails to connect.
 */
export async function fetchWithRetry(url: string, init?: RequestInit): Promise<Response> {
    try {
        return await withConnectionRetry(() => fetch(url, init));
    } catch (err) {
        if (!isConnectionError(err)) {
            throw err;
        }
        // Left alone, this surfaces to the user as the bare string
        // "fetch failed", which says nothing about what was being
        // reached or why. Name the host and the underlying code.
        throw new Error(
            `could not reach ${hostOf(url)} after ${CONNECT_RETRIES + 1} attempts: ` +
                describeError(err),
            { cause: err },
        );
    }
}

/**
 * Host portion of a URL, for an error message.
 *
 * @param url The URL that could not be reached.
 * @returns Its host, or the whole string when it does not parse.
 */
function hostOf(url: string): string {
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
}

/**
 * Promise-based delay.
 *
 * @param ms Milliseconds to wait.
 * @returns A promise resolving after the delay.
 */
export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
