/** Fetches a bearer token for the call. */
export type TokenProvider = () => Promise<string>;

/** Options for {@link graphFetch}. */
export interface GraphFetchOptions {
    /** Extra request headers. */
    readonly headers?: Record<string, string>;
    /** JSON body (serialized, sets Content-Type). */
    readonly jsonBody?: unknown;
    /** Raw body (bytes or a web stream; streams need `duplex: "half"`). */
    readonly body?: BodyInit;
    /** Send `Authorization: Bearer` (default true). Upload-session URLs must not carry it. */
    readonly authenticate?: boolean;
    /** Statuses to hand back instead of throwing (e.g. 404 for "not found → null"). */
    readonly acceptStatuses?: readonly number[];
    /** `redirect` mode for fetch (default "follow"). */
    readonly redirect?: RequestRedirect;
    readonly signal?: AbortSignal;
}

/** Statuses that mean "try again later" and are safe to retry for any method. */
const RETRYABLE_STATUSES = new Set([429, 503, 504]);
/** Retries after the first attempt. */
const MAX_RETRIES = 3;
/** Upper bound for one wait, whatever `Retry-After` says. */
const MAX_RETRY_DELAY_MS = 60_000;

/**
 * One Microsoft Graph HTTP call with throttling handling: 429 / 503 /
 * 504 are retried up to {@link MAX_RETRIES} times, waiting for
 * `Retry-After` when present (capped) and exponential backoff
 * otherwise. Graph rejects throttled requests without processing them,
 * so retrying non-idempotent methods is safe. Raw bodies can only be
 * retried when they are not streams — callers streaming a body must
 * handle retries themselves (the chunked upload does).
 *
 * @param tokenProvider - Supplies the bearer token.
 * @param method - HTTP method.
 * @param url - Absolute URL.
 * @param options - See {@link GraphFetchOptions}.
 * @returns The (ok or accepted) response; the body is not consumed.
 * @throws GraphError on any other non-2xx status (after retries).
 */
export async function graphFetch(
    tokenProvider: TokenProvider,
    method: string,
    url: string,
    options: GraphFetchOptions = {},
): Promise<Response> {
    const isStreamBody = options.body instanceof ReadableStream;
    for (let attempt = 0; ; attempt++) {
        const headers: Record<string, string> = {
            Accept: "application/json",
            ...(options.headers ?? {}),
        };
        if (options.authenticate !== false) {
            headers.Authorization = `Bearer ${await tokenProvider()}`;
        }
        let body: BodyInit | undefined = options.body;
        if (options.jsonBody !== undefined) {
            headers["Content-Type"] = "application/json";
            body = JSON.stringify(options.jsonBody);
        }
        const init: RequestInit & { duplex?: "half" } = {
            method,
            headers,
            body,
            redirect: options.redirect ?? "follow",
            signal: options.signal,
        };
        if (isStreamBody) {
            init.duplex = "half";
        }
        const response = await fetch(url, init);
        if (response.ok || options.acceptStatuses?.includes(response.status)) {
            return response;
        }
        if (RETRYABLE_STATUSES.has(response.status) && attempt < MAX_RETRIES && !isStreamBody) {
            await response.body?.cancel().catch(() => undefined);
            await sleep(retryDelayMs(response, attempt), options.signal);
            continue;
        }
        const text = await response.text().catch(() => "");
        throw new GraphError(response.status, url, text);
    }
}

/**
 * Delay before the next attempt: `Retry-After` (seconds or HTTP date)
 * when present and sane, else 1 s, 2 s, 4 s, … Always capped.
 */
export function retryDelayMs(response: Response, attempt: number): number {
    const header = response.headers.get("retry-after");
    if (header !== null) {
        const seconds = Number(header);
        if (Number.isFinite(seconds) && seconds >= 0) {
            return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
        }
        const date = Date.parse(header);
        if (!Number.isNaN(date)) {
            return Math.min(Math.max(0, date - Date.now()), MAX_RETRY_DELAY_MS);
        }
    }
    return Math.min(1000 * 2 ** attempt, MAX_RETRY_DELAY_MS);
}

/**
 * Sleep, rejecting early when `signal` aborts.
 *
 * @throws The signal's abort reason.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason);
            return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                reject(signal.reason);
            },
            { once: true },
        );
    });
}

/**
 * Thrown when Graph returns a non-2xx response. The host-side log
 * still carries the full URL + raw body for diagnosis; the
 * agent-facing tool layer catches this and converts it into a
 * structured `{ok:false, error:{...}}` payload before returning to
 * the model (see `MailTools.ts`).
 *
 * 410 Gone on a delta URL is the documented "delta link expired,
 * start over" signal — the poll loop catches it and drops the cursor.
 */
export class GraphError extends Error {
    readonly status: number;
    readonly url: string;
    readonly body: string;
    /** Graph's `error.code` if the body decoded as JSON; `null` otherwise. */
    readonly code: string | null;
    /** Graph's `error.message` if the body decoded as JSON; the raw text otherwise. */
    readonly graphMessage: string;

    constructor(status: number, url: string, body: string) {
        const decoded = decodeGraphErrorBody(body);
        super(
            `Graph ${status} ${decoded.code ?? "error"}: ${decoded.message.slice(0, 500)} ` +
                `(${url})`,
        );
        this.status = status;
        this.url = url;
        this.body = body;
        this.code = decoded.code;
        this.graphMessage = decoded.message;
    }
}

/**
 * Pull `{code, message}` out of a Graph error body if possible. Falls
 * back to the raw body string when the response isn't JSON-shaped —
 * Graph occasionally returns HTML on gateway errors.
 */
function decodeGraphErrorBody(body: string): { code: string | null; message: string } {
    try {
        const parsed = JSON.parse(body) as {
            error?: { code?: unknown; message?: unknown };
        };
        const code = typeof parsed.error?.code === "string" ? parsed.error.code : null;
        const message = typeof parsed.error?.message === "string" ? parsed.error.message : body;
        return { code, message };
    } catch {
        return { code: null, message: body };
    }
}
