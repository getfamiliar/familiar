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
 * Cut a markdown document into {@link Chunk}s, one per h1/h2/h3 —
 * further split when a section would exceed `maxChunkChars` (see
 * {@link splitOversizedChunk}).
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
 *  - **Oversized sections** are split into `(part i/n)` chunks so every
 *    embedding input stays under the provider's token limit.
 *
 * @param source The markdown document.
 * @param relativePath Workspace-relative path of the document.
 * @param maxChunkChars Upper bound for headlines + context + content of
 *   one chunk (the embedding input), in characters.
 * @returns The chunks in document order.
 */
export function chunkMarkdown(
    source: string,
    relativePath: string,
    maxChunkChars: number,
): Chunk[] {
    return chunkBySections(source, relativePath).flatMap((chunk) =>
        splitOversizedChunk(chunk, maxChunkChars),
    );
}

/**
 * Section-level cut behind {@link chunkMarkdown}: one chunk per h1–h3
 * (or one for a headerless file), regardless of size.
 *
 * @param source The markdown document.
 * @param relativePath Workspace-relative path (headline for headerless files).
 * @returns One chunk per non-empty section.
 */
function chunkBySections(source: string, relativePath: string): Chunk[] {
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

/**
 * Characters reserved for the ` (part i/n)` headline suffix and the two
 * `\n\n` separators `MemoryStore.buildEmbeddingInput` puts between
 * headlines, context and content.
 */
const SPLIT_OVERHEAD_CHARS = 24;

/**
 * Floor for the content budget of one part. A pathological headline or
 * context longer than `maxChunkChars` must not drive the budget to zero
 * (endless one-character parts); such parts may then exceed the limit.
 */
const MIN_CONTENT_BUDGET_CHARS = 500;

/** A list item at the start of a line (`- `, `* `, `+ `, `1. `, `1) `). */
const LIST_ITEM_RE = /^(?:[-*+]|\d+[.)])[ \t]/;

/** Opening or closing code fence line. */
const FENCE_LINE_RE = /^(?:```|~~~)/;

/**
 * Split a chunk whose embedding input would exceed `maxChunkChars` into
 * several chunks. Cuts at block boundaries — blank lines and top-level
 * list items, never inside a fenced code block — and packs consecutive
 * blocks greedily. A single block that is still too large is cut at
 * sentence ends, then at whitespace. Each part keeps the headline trail
 * (suffixed ` (part i/n)`) and the document context.
 *
 * @param chunk The section chunk.
 * @param maxChunkChars Upper bound for headlines + context + content.
 * @returns `[chunk]` unchanged when it fits, else the parts in order.
 */
export function splitOversizedChunk(chunk: Chunk, maxChunkChars: number): Chunk[] {
    const fixedChars = chunk.headlines.length + chunk.context.length + SPLIT_OVERHEAD_CHARS;
    if (fixedChars + chunk.content.length <= maxChunkChars) {
        return [chunk];
    }
    const budget = Math.max(maxChunkChars - fixedChars, MIN_CONTENT_BUDGET_CHARS);
    const parts: string[] = [];
    let current = "";
    for (const block of splitIntoBlocks(chunk.content)) {
        if (block.length > budget) {
            if (current.length > 0) {
                parts.push(current);
                current = "";
            }
            parts.push(...hardSplit(block, budget));
            continue;
        }
        const candidate = current.length === 0 ? block : `${current}\n\n${block}`;
        if (candidate.length > budget) {
            parts.push(current);
            current = block;
        } else {
            current = candidate;
        }
    }
    if (current.length > 0) {
        parts.push(current);
    }
    if (parts.length <= 1) {
        return [chunk];
    }
    return parts.map((content, i) => ({
        headlines: `${chunk.headlines} (part ${i + 1}/${parts.length})`,
        context: chunk.context,
        content,
    }));
}

/**
 * Split markdown into blocks: a new block starts after a blank line and
 * at every top-level list item. Fenced code stays one block.
 *
 * @param content Section body.
 * @returns Trimmed, non-empty blocks in order.
 */
function splitIntoBlocks(content: string): string[] {
    const blocks: string[] = [];
    let lines: string[] = [];
    let isInFence = false;
    const flush = (): void => {
        const block = lines.join("\n").trim();
        if (block.length > 0) {
            blocks.push(block);
        }
        lines = [];
    };
    for (const line of content.split("\n")) {
        if (FENCE_LINE_RE.test(line)) {
            if (!isInFence) {
                flush();
            }
            isInFence = !isInFence;
            lines.push(line);
            continue;
        }
        if (!isInFence && (line.trim().length === 0 || LIST_ITEM_RE.test(line))) {
            flush();
        }
        lines.push(line);
    }
    flush();
    return blocks;
}

/**
 * Cut one oversized block into pieces of at most `budget` characters,
 * preferring sentence ends (`. `, `! `, `? `) in the back half of the
 * window, then whitespace, then a hard cut.
 *
 * @param block The block text.
 * @param budget Maximum piece length.
 * @returns Trimmed pieces in order.
 */
function hardSplit(block: string, budget: number): string[] {
    const pieces: string[] = [];
    let rest = block;
    while (rest.length > budget) {
        const window = rest.slice(0, budget);
        const minCut = Math.floor(budget / 2);
        let cut = Math.max(
            window.lastIndexOf(". "),
            window.lastIndexOf("! "),
            window.lastIndexOf("? "),
        );
        if (cut < minCut) {
            cut = window.search(/\s\S*$/);
        }
        const end = cut >= minCut ? cut + 1 : budget;
        pieces.push(rest.slice(0, end).trim());
        rest = rest.slice(end).trim();
    }
    if (rest.length > 0) {
        pieces.push(rest);
    }
    return pieces;
}
