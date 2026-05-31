/**
 * Parse the id-spec accepted by `cli.sh events replay`.
 *
 * Accepts a comma-separated list of either single event ids or inclusive
 * spans. Whitespace around commas and the dash is ignored.
 *
 *     "4711"            → ["4711"]
 *     "123-126"         → ["123", "124", "125", "126"]
 *     "123-125, 555"    → ["123", "124", "125", "555"]
 *
 * Ids are returned as decimal strings, preserving the bigint-as-string
 * convention the rest of the bus uses. Duplicates that appear multiple
 * times in the spec are kept in their first-seen position; the same
 * event is never replayed twice in one invocation.
 *
 * @throws If any segment is not a positive integer, or if a span's low
 *   bound is greater than its high bound.
 */
export function parseEventIdSpec(spec: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();

    const segments = spec
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    if (segments.length === 0) {
        throw new Error(`Empty id spec: ${JSON.stringify(spec)}`);
    }

    for (const segment of segments) {
        const dashIndex = segment.indexOf("-");
        if (dashIndex < 0) {
            const id = parsePositiveBigInt(segment);
            pushOnce(out, seen, id.toString());
            continue;
        }
        const lowRaw = segment.slice(0, dashIndex).trim();
        const highRaw = segment.slice(dashIndex + 1).trim();
        const low = parsePositiveBigInt(lowRaw);
        const high = parsePositiveBigInt(highRaw);
        if (low > high) {
            throw new Error(`Invalid span ${segment}: low (${low}) > high (${high})`);
        }
        for (let i = low; i <= high; i++) {
            pushOnce(out, seen, i.toString());
        }
    }

    return out;
}

/**
 * Parse a non-empty decimal string into a positive `bigint`.
 *
 * @throws If the input is empty, contains non-digit characters, or is zero.
 */
function parsePositiveBigInt(raw: string): bigint {
    if (raw.length === 0 || !/^\d+$/.test(raw)) {
        throw new Error(`Invalid event id ${JSON.stringify(raw)}: expected positive integer`);
    }
    const value = BigInt(raw);
    if (value <= 0n) {
        throw new Error(`Invalid event id ${raw}: must be positive`);
    }
    return value;
}

function pushOnce(out: string[], seen: Set<string>, id: string): void {
    if (seen.has(id)) {
        return;
    }
    seen.add(id);
    out.push(id);
}
