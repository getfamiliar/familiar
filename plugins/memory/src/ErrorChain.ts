/** Upper bound on how many nested causes {@link describeErrorChain} follows. */
const MAX_CHAIN_DEPTH = 6;

/**
 * Render an error together with everything nested inside it, so a network
 * failure shows its actual reason. The AI SDK wraps a failed fetch as
 * `RetryError.lastError` → `APICallError.cause` → the undici/system error,
 * and Node's happy-eyeballs connect failure is an `AggregateError` with an
 * empty message whose detail only lives in `code` and `errors[]` — so the
 * top-level message alone reads "Cannot connect to API: " with nothing
 * after it.
 *
 * @param err Anything that was thrown.
 * @returns The top-level message followed by one `caused by: …` line per
 *   nested error (`[CODE] message`, aggregate members joined with `; `).
 */
export function describeErrorChain(err: unknown): string {
    const lines = [describeOne(err)];
    let current = nestedError(err);
    for (let depth = 0; current !== undefined && depth < MAX_CHAIN_DEPTH; depth++) {
        lines.push(`caused by: ${describeOne(current)}`);
        current = nestedError(current);
    }
    return lines.join("\n");
}

/**
 * Pick the next error down the chain: `RetryError.lastError` first (it has
 * no `cause`), then the standard `cause`.
 *
 * @param err The error to look inside.
 * @returns The nested error, or `undefined` at the end of the chain.
 */
function nestedError(err: unknown): unknown {
    if (typeof err !== "object" || err === null) {
        return undefined;
    }
    const candidate = err as { lastError?: unknown; cause?: unknown };
    return candidate.lastError ?? candidate.cause ?? undefined;
}

/**
 * Format one error as `[CODE] message`, expanding `AggregateError` members.
 *
 * @param err The error to format.
 * @returns A single-line description.
 */
function describeOne(err: unknown): string {
    if (!(err instanceof Error)) {
        return String(err);
    }
    const code = (err as { code?: unknown }).code;
    const prefix = typeof code === "string" ? `[${code}] ` : "";
    const members =
        err instanceof AggregateError
            ? err.errors.map((member) => describeOne(member)).join("; ")
            : "";
    const message = err.message || members || err.name;
    return `${prefix}${message}`;
}
