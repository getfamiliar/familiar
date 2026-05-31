/**
 * Tool-call runner: the shared machinery every agent-facing tool uses
 * to package its result. Three flavors — JSON object, JSON Lines, free
 * text — picked by the tool's `execute` based on what shape it wants
 * the agent to see.
 *
 * Two responsibilities only:
 *
 *   - **Truncation / offloading.** When the serialized result exceeds
 *     {@link ToolRunContext.limit} bytes, the runner spills the *full*
 *     result to a scratch file via {@link ToolRunContext.spill} and
 *     returns either a sentinel ({@link OffloadedJson} for the JSON
 *     runner) or a partial-with-marker (JSONL / text runners). The
 *     spilled file always carries the complete content so the agent
 *     can `fs_read` it for the missing portion.
 *   - **Letting throws propagate.** Failure is signalled by throwing.
 *     The Vercel AI SDK turns any throw into a `tool-error` block;
 *     tools that want a clean message catch and re-throw a
 *     {@link ToolError} inside their own body. The runners do not
 *     transform errors.
 *
 * Note: success bodies are *not* wrapped in `{ok:true,...}`. The agent
 * receives the bare value (object, JSONL string, or text string).
 */

import { Buffer } from "node:buffer";

/** Default byte budget when no config override and no frontmatter override is set. */
export const DEFAULT_TOOL_CALL_OFFLOADING_LIMIT = 10000;

/**
 * Convenience throwable for tool bodies that want to attach a stable
 * machine-readable `code` (e.g. `"ErrorItemNotFound"`) and optional
 * HTTP-flavored `status` alongside the human message. The Vercel SDK
 * doesn't surface these fields in `tool-error` blocks, but the gateway
 * transports them across HTTP so transcripts and tests can match on
 * `code` instead of fuzzy-matching on `message`.
 *
 * Plain `Error` throws work too — they propagate verbatim with
 * `code = "ToolError"` synthesized at the wire boundary.
 */
export class ToolError extends Error {
    constructor(
        public readonly code: string,
        message: string,
        public readonly status?: number,
    ) {
        super(message);
        this.name = "ToolError";
    }
}

/**
 * Per-call context handed to every runner. Constructed by whichever
 * side (host gateway / container tool wrapper) owns the agentrun.
 *
 *   - `limit`: byte budget for the inline response. Resolved per-call
 *     from handler frontmatter → env var / config → default.
 *   - `spill`: writes the full result under `/scratch/<event-id>/` and
 *     returns the absolute path the agent can later `fs_read`.
 *     Implementations dedupe basenames so concurrent calls don't
 *     clobber each other.
 */
export interface ToolRunContext {
    readonly limit: number;
    spill(suggestedName: string, contents: Buffer): Promise<string>;
}

/**
 * Sentinel returned by {@link runJsonTool} when the serialized result
 * exceeds the byte budget. The agent should `fs_read` the path for
 * the actual content.
 */
export interface OffloadedJson {
    readonly truncated: true;
    readonly fullResultAt: string;
    readonly reason: string;
}

/**
 * Run a tool whose result is a single JSON object. If the
 * `JSON.stringify`'d size is at or below the limit, returns the object
 * verbatim. Otherwise spills the full JSON to scratch and returns
 * {@link OffloadedJson}.
 *
 * No partial JSON is exposed — an oversized result is either fully
 * inline or fully offloaded. The body is expected to throw on failure;
 * the runner does not catch.
 */
export async function runJsonTool(
    body: () => Promise<object>,
    ctx: ToolRunContext,
): Promise<object> {
    const result = await body();
    const serialized = JSON.stringify(result);
    if (Buffer.byteLength(serialized, "utf8") <= ctx.limit) {
        return result;
    }
    const fullResultAt = await ctx.spill("result.json", Buffer.from(serialized, "utf8"));
    return {
        truncated: true,
        fullResultAt,
        reason: `result exceeded ${ctx.limit} bytes — fs_read the path (it's paginated)`,
    } satisfies OffloadedJson;
}

/**
 * Run a tool whose result is a stream of JSON objects, serialized as
 * newline-delimited JSON. If the total fits within the limit, returns
 * all lines joined with `\n`. Otherwise spills the full JSONL to
 * scratch and returns the leading whole lines that fit, followed by a
 * marker line:
 *
 *   `{"truncated":true,"fullResultAt":"<path>","omittedLines":<N>}`
 *
 * Edge case: when even the first line plus the marker exceeds the
 * limit, only the marker is returned (`omittedLines` then equals the
 * total line count).
 */
export async function runJsonLinesTool(
    body: () => Promise<Iterable<object> | AsyncIterable<object>>,
    ctx: ToolRunContext,
): Promise<string> {
    const source = await body();
    const serialized: string[] = [];
    for await (const item of asAsyncIterable(source)) {
        serialized.push(JSON.stringify(item));
    }

    const inline = serialized.join("\n");
    if (Buffer.byteLength(inline, "utf8") <= ctx.limit) {
        return inline;
    }

    const fullText = inline;
    const fullResultAt = await ctx.spill("result.jsonl", Buffer.from(fullText, "utf8"));

    // Budget the marker assuming worst-case omittedLines (the total
    // line count). Marker can only get shorter as `omittedLines`
    // shrinks, so this is a safe upper bound.
    const upperBoundMarker = JSON.stringify({
        truncated: true,
        fullResultAt,
        omittedLines: serialized.length,
    });
    const markerBudget = Buffer.byteLength(upperBoundMarker, "utf8");

    const kept: string[] = [];
    let usedBytes = 0;
    for (const line of serialized) {
        const separator = kept.length > 0 ? 1 : 0; // newline before this line
        const newlineBeforeMarker = 1; // newline between last kept line and marker
        const addBytes = separator + Buffer.byteLength(line, "utf8");
        if (usedBytes + addBytes + newlineBeforeMarker + markerBudget > ctx.limit) {
            break;
        }
        kept.push(line);
        usedBytes += addBytes;
    }

    const omittedLines = serialized.length - kept.length;
    const marker = JSON.stringify({ truncated: true, fullResultAt, omittedLines });

    if (kept.length === 0) {
        return marker;
    }
    return `${kept.join("\n")}\n${marker}`;
}

/**
 * Run a tool whose result is free text. If the text fits the limit,
 * returns it verbatim. Otherwise spills the full text to scratch and
 * returns a truncated prefix followed by a footer pointing at the
 * scratch path:
 *
 *   `<truncated text>\n\n[truncated; full result at <path>]`
 *
 * The truncation respects UTF-8 code-point boundaries so multi-byte
 * characters never get split.
 */
export async function runTextTool(
    body: () => Promise<string>,
    ctx: ToolRunContext,
): Promise<string> {
    const text = await body();
    if (Buffer.byteLength(text, "utf8") <= ctx.limit) {
        return text;
    }

    const fullResultAt = await ctx.spill("result.txt", Buffer.from(text, "utf8"));
    const footer = `\n\n[truncated; full result at ${fullResultAt}]`;
    const footerBytes = Buffer.byteLength(footer, "utf8");
    const prefixBudget = Math.max(0, ctx.limit - footerBytes);
    const prefix = truncateUtf8(text, prefixBudget);
    return `${prefix}${footer}`;
}

/**
 * Truncate `str` to at most `maxBytes` UTF-8 bytes without splitting a
 * code point. Surrogate pairs (code points beyond the BMP) are kept
 * together.
 */
export function truncateUtf8(str: string, maxBytes: number): string {
    if (maxBytes <= 0) {
        return "";
    }
    let bytes = 0;
    let charIdx = 0;
    while (charIdx < str.length) {
        const cp = str.codePointAt(charIdx);
        if (cp === undefined) {
            break;
        }
        const cpBytes = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
        if (bytes + cpBytes > maxBytes) {
            break;
        }
        bytes += cpBytes;
        charIdx += cp >= 0x10000 ? 2 : 1;
    }
    return str.slice(0, charIdx);
}

/** Lift a sync iterable into an async one so we can `for await` over both. */
async function* asAsyncIterable<T>(source: Iterable<T> | AsyncIterable<T>): AsyncIterable<T> {
    if (Symbol.asyncIterator in source) {
        yield* source as AsyncIterable<T>;
        return;
    }
    yield* source as Iterable<T>;
}
