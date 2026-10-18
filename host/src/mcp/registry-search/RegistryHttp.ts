/** Per-request timeout for registry and popularity lookups. */
export const REGISTRY_HTTP_TIMEOUT_MS = 15_000;

/** GitHub's API rejects requests without a User-Agent. */
const USER_AGENT = "familiar-mcp-registry-search";

/** Error for a non-2xx response, carrying the status for callers that branch on it. */
export class HttpStatusError extends Error {
    readonly status: number;

    /**
     * @param url The requested URL.
     * @param status The HTTP status.
     * @param statusText The status text.
     */
    constructor(url: string, status: number, statusText: string) {
        super(`${url} answered ${status} ${statusText}`.trim());
        this.name = "HttpStatusError";
        this.status = status;
    }
}

/**
 * GET a URL with a timeout and the search's User-Agent.
 *
 * @param url Absolute URL.
 * @param headers Extra request headers.
 * @param timeoutMs Abort after this many milliseconds.
 * @returns The response (any status).
 * @throws Error on network failure or timeout, naming the URL.
 */
export async function fetchWithTimeout(
    url: string,
    headers: Readonly<Record<string, string>> = {},
    timeoutMs: number = REGISTRY_HTTP_TIMEOUT_MS,
): Promise<Response> {
    const send = (): Promise<Response> =>
        fetch(url, {
            headers: { "user-agent": USER_AGENT, ...headers },
            signal: AbortSignal.timeout(timeoutMs),
        });
    try {
        return await send();
    } catch (firstErr) {
        // A dropped connection ("fetch failed") is often transient under
        // parallel lookups — retry once; a timeout is not retried.
        if (firstErr instanceof Error && firstErr.name === "TimeoutError") {
            throw new Error(`request to ${url} failed: ${firstErr.message}`);
        }
        try {
            return await send();
        } catch (err) {
            const cause = err instanceof Error ? err.message : String(err);
            throw new Error(`request to ${url} failed: ${cause}`);
        }
    }
}

/**
 * GET a URL and parse its JSON body.
 *
 * @param url Absolute URL.
 * @param headers Extra request headers.
 * @param timeoutMs Abort after this many milliseconds.
 * @returns The parsed body.
 * @throws HttpStatusError on a non-2xx response; Error on network or parse failure.
 */
export async function fetchJson(
    url: string,
    headers: Readonly<Record<string, string>> = {},
    timeoutMs: number = REGISTRY_HTTP_TIMEOUT_MS,
): Promise<unknown> {
    const response = await fetchWithTimeout(url, headers, timeoutMs);
    if (!response.ok) {
        throw new HttpStatusError(url, response.status, response.statusText);
    }
    try {
        return await response.json();
    } catch (err) {
        const cause = err instanceof Error ? err.message : String(err);
        throw new Error(`${url} returned invalid JSON: ${cause}`);
    }
}

/**
 * Run `worker` over `items` with at most `limit` in flight.
 *
 * @param items Inputs.
 * @param limit Maximum parallelism (≥ 1).
 * @param worker Async mapper.
 * @returns The results in input order.
 */
export async function mapWithConcurrency<T, R>(
    items: readonly T[],
    limit: number,
    worker: (item: T) => Promise<R>,
): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const index = next;
            next += 1;
            results[index] = await worker(items[index] as T);
        }
    });
    await Promise.all(lanes);
    return results;
}

/** Type guard for plain JSON/YAML mappings. */
export function isMapping(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A non-empty string, or undefined. */
export function optionalString(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** A finite number, or undefined. */
export function optionalNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
