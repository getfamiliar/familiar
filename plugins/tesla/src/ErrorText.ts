/**
 * Render any thrown value as a message a human can act on.
 *
 * The motivating case is `AggregateError`, which Node raises when a
 * connection attempt fails across every resolved address (happy
 * eyeballs). Its `message` is the **empty string** and the real
 * information sits in `code` and `errors[]` — so the naive
 * `err instanceof Error ? err.message : String(err)` renders a network
 * blip as `Refresh: FAILED — `, which reads like a dead login and
 * sends the user chasing their credentials instead of their network.
 *
 * @param err The caught value.
 * @returns A non-empty, single-line description.
 */
export function describeError(err: unknown): string {
    if (!(err instanceof Error)) {
        const text = String(err).trim();
        return text.length > 0 ? text : "unknown error";
    }

    const parts: string[] = [];
    if (err.message.trim().length > 0) {
        parts.push(err.message.trim());
    }

    const code = (err as NodeJS.ErrnoException).code;
    if (typeof code === "string" && code.length > 0 && !parts.join(" ").includes(code)) {
        parts.push(code);
    }

    // AggregateError carries one entry per attempted address; the
    // distinct codes are what distinguishes "no route" from "refused".
    if (err instanceof AggregateError) {
        const inner = new Set<string>();
        for (const nested of err.errors ?? []) {
            const nestedCode = (nested as NodeJS.ErrnoException | undefined)?.code;
            if (typeof nestedCode === "string" && nestedCode.length > 0) {
                inner.add(nestedCode);
            } else if (nested instanceof Error && nested.message.trim().length > 0) {
                inner.add(nested.message.trim());
            }
        }
        if (inner.size > 0) {
            parts.push(`[${[...inner].join(", ")}]`);
        }
    }

    // `fetch` reports every transport failure as the same opaque
    // `TypeError: fetch failed` and puts the real error in `cause`.
    if (err.cause !== undefined) {
        const causeText = describeError(err.cause);
        if (causeText.length > 0 && !parts.join(" ").includes(causeText)) {
            parts.push(`(${causeText})`);
        }
    }

    return parts.length > 0 ? parts.join(" ") : err.name;
}
