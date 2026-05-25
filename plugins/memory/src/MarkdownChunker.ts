/**
 * One indexable slice of a markdown file. The {@link MarkdownChunker}
 * produces one of these per heading at level h1–h3.
 *
 * The three text fields are kept separate in the index so search hits
 * can be rendered with their full headline hierarchy; the embedding
 * vector is computed over their concatenation (see
 * `MemoryStore.buildEmbeddingInput`).
 */
export interface Chunk {
    /**
     * Full headline trail leading to this chunk, joined with ` > `.
     * Example: `# Adam Smith > ## Meetings > ### Atlanta 2026-05-12`.
     * Each segment includes its `#` markers so the level survives
     * round-tripping into the report renderer.
     */
    readonly headlines: string;
    /**
     * Document-wide framing paragraph — the first plain paragraph that
     * follows the document's leading h1, copied verbatim onto every
     * chunk derived from that file. Empty string when the file has no
     * h1, or when the first non-heading child of the h1 is a list,
     * heading, or code fence.
     */
    readonly context: string;
    /**
     * Raw markdown body of this section, **excluding** the heading
     * line itself. Spans every block-level child of the chunk's
     * heading up to (but not including) the next h1/h2/h3.
     * Whitespace-trimmed; whitespace-only chunks are dropped.
     */
    readonly content: string;
}

/**
 * Heading regex: matches an ATX heading at the start of a logical
 * line. Limits to 1–3 `#`s so the chunker leaves h4+ inside a chunk's
 * body (they read as section sub-points, not memory boundaries). The
 * intentional `^` + `m` flag ensures we don't match `#` characters
 * that appear inside a line of prose.
 */
const HEADING_RE = /^(#{1,3})[ \t]+(.+?)[ \t]*$/gm;

/**
 * Opening or closing fence regex. Used to mask out fenced code blocks
 * before scanning for headings — otherwise a `# foo` line inside a
 * shell script example would split a chunk. Matches triple-backtick or
 * triple-tilde fences with optional info-string on the opener.
 */
const FENCE_RE = /^(?:```|~~~)[^\n]*$/gm;

/**
 * Cut a markdown document into {@link Chunk}s, one per h1/h2/h3.
 *
 * Pure function — no I/O, no logging. The caller is the indexer
 * (`MemoryStore.updateFile`) and the unit tests.
 *
 * Behavior summary:
 *  - Pre-h1 content is dropped (rare in practice — every shipped
 *    template starts with an h1).
 *  - The first plain paragraph after the document's leading h1 becomes
 *    that document's `context` and is attached to every chunk. Lists,
 *    sub-headings, or code fences sitting directly under the h1
 *    suppress this — context stays empty.
 *  - Headings inside fenced code blocks are not treated as headings.
 *  - Chunks whose body trims to the empty string are dropped (so an
 *    `index.md` whose only content is heading lines does not bloat
 *    the index with placeholder rows).
 *  - **Headerless files** (no h1/h2/h3 anywhere) are still indexable:
 *    the whole body becomes a single chunk with a synthesized headline
 *    derived from {@link relativePath}. Without this, files like
 *    `mail/rules/adam@weeklyfoo.com.md` — typically just a paragraph
 *    of prose — would silently produce zero chunks and never surface
 *    in search.
 */
export function chunkMarkdown(source: string, relativePath: string): Chunk[] {
    const masked = maskFencedCode(source);

    interface RawHeading {
        readonly depth: 1 | 2 | 3;
        readonly title: string;
        /** Offset in the ORIGINAL source where the heading line starts. */
        readonly start: number;
        /** Offset where the heading line ends (start of the body that follows). */
        readonly bodyStart: number;
    }
    const headings: RawHeading[] = [];
    HEADING_RE.lastIndex = 0;
    for (;;) {
        const match = HEADING_RE.exec(masked);
        if (!match) {
            break;
        }
        const depth = match[1].length as 1 | 2 | 3;
        const title = match[2].trim();
        const start = match.index;
        // The body starts right after the heading's newline (or end of
        // string for a heading that closes the file). `match[0]` is
        // the full heading line, no terminator.
        const lineEnd = start + match[0].length;
        const bodyStart = masked.charAt(lineEnd) === "\n" ? lineEnd + 1 : lineEnd;
        headings.push({ depth, title, start, bodyStart });
    }
    if (headings.length === 0) {
        return chunkHeaderless(source, relativePath);
    }

    const docH1 = headings.find((h) => h.depth === 1);
    const context = docH1 ? extractContextParagraph(source, headings, docH1) : "";

    const chunks: Chunk[] = [];
    const stack: { depth: 1 | 2 | 3; line: string }[] = [];
    for (let i = 0; i < headings.length; i++) {
        const head = headings[i];
        while (stack.length > 0 && stack[stack.length - 1].depth >= head.depth) {
            stack.pop();
        }
        stack.push({
            depth: head.depth,
            line: `${"#".repeat(head.depth)} ${head.title}`,
        });
        const trail = stack.map((s) => s.line).join(" > ");
        const next = headings[i + 1];
        const bodyEnd = next ? next.start : source.length;
        const body = source.slice(head.bodyStart, bodyEnd).trim();
        if (body.length === 0) {
            continue;
        }
        chunks.push({ headlines: trail, context, content: body });
    }
    return chunks;
}

/**
 * Look for the first paragraph sitting directly under the document's
 * leading h1. Returns its text trimmed, or `""` if the slot is held by
 * a non-paragraph block (list, sub-heading, code fence, blockquote, hr,
 * table). Uses the original source so the returned paragraph carries
 * its original markdown markup; the only normalisation is a `trim()`.
 */
function extractContextParagraph(
    source: string,
    headings: readonly {
        readonly depth: number;
        readonly start: number;
        readonly bodyStart: number;
    }[],
    docH1: { readonly bodyStart: number },
): string {
    const nextHeading = headings.find((h) => h.start > docH1.bodyStart);
    const region = source.slice(docH1.bodyStart, nextHeading ? nextHeading.start : source.length);
    // Skip leading blank lines.
    const blockStart = region.search(/\S/);
    if (blockStart < 0) {
        return "";
    }
    const trimmedFromStart = region.slice(blockStart);
    // Disqualifying first-block markers (each anchored to the first
    // non-blank line). Lists, blockquote, fenced code, hr, table row,
    // setext underline — any of these means the author chose a
    // non-paragraph opener, so we leave context empty.
    const firstLineEnd = trimmedFromStart.indexOf("\n");
    const firstLine = firstLineEnd < 0 ? trimmedFromStart : trimmedFromStart.slice(0, firstLineEnd);
    if (
        /^[-*+] /.test(firstLine) ||
        /^\d+[.)] /.test(firstLine) ||
        /^>/.test(firstLine) ||
        /^```|^~~~/.test(firstLine) ||
        /^---+$|^\*\*\*+$|^___+$/.test(firstLine) ||
        firstLine.startsWith("|") ||
        firstLine.startsWith("    ")
    ) {
        return "";
    }
    // Paragraph ends at the first blank line.
    const blankAt = trimmedFromStart.search(/\n[ \t]*\n/);
    const paragraph = blankAt < 0 ? trimmedFromStart : trimmedFromStart.slice(0, blankAt);
    return paragraph.trim();
}

/**
 * Replace the *contents* of every fenced code block with non-newline
 * filler so {@link HEADING_RE} cannot match inside a fence. Length is
 * preserved character-for-character so heading offsets resolved on the
 * mask align with the original source. Fence opener/closer lines are
 * preserved verbatim — heading regex would not match them anyway
 * (they begin with `` ` `` or `~`).
 */
function maskFencedCode(source: string): string {
    const fences: { readonly start: number; readonly end: number }[] = [];
    FENCE_RE.lastIndex = 0;
    let openerEnd: number | undefined;
    for (;;) {
        const m = FENCE_RE.exec(source);
        if (!m) {
            break;
        }
        if (openerEnd === undefined) {
            // Opener — record where its line ends (after the newline).
            const lineEnd = m.index + m[0].length;
            openerEnd = source.charAt(lineEnd) === "\n" ? lineEnd + 1 : lineEnd;
        } else {
            // Closer — content runs from after the opener line to the
            // closer's start.
            fences.push({ start: openerEnd, end: m.index });
            openerEnd = undefined;
        }
    }
    if (fences.length === 0) {
        return source;
    }
    const chars = source.split("");
    for (const fence of fences) {
        for (let i = fence.start; i < fence.end; i++) {
            if (chars[i] !== "\n") {
                chars[i] = " ";
            }
        }
    }
    return chars.join("");
}

/**
 * Headerless-file fallback. Returns one chunk covering the full body,
 * with a synthesized h1 derived from the relative path so the chunk
 * still carries a meaningful headline trail into the embedding and the
 * search-result render. The whole-path stem (`mail/rules/adam@…`) is
 * used rather than the bare basename because the directory segments
 * carry useful context (mail rule, person, etc.).
 *
 * Returns `[]` (still) if the body is empty after trimming — an empty
 * file is genuinely not indexable.
 */
function chunkHeaderless(source: string, relativePath: string): Chunk[] {
    const body = source.trim();
    if (body.length === 0) {
        return [];
    }
    const stem = relativePath.replace(/\.md$/i, "");
    return [
        {
            headlines: `# ${stem}`,
            context: "",
            content: body,
        },
    ];
}
