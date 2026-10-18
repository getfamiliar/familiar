/**
 * Characters that render invisibly (or reorder text) and can hide
 * instructions from a human reviewer while the model still reads them:
 * C0/C1 controls except tab and newline, soft hyphen, zero-width and
 * bidi controls, word joiners / invisible operators, BOM, variation
 * selectors, and Unicode tag characters.
 */
const INVISIBLE_PATTERN =
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the purpose.
    /[\u{0}-\u{8}\u{B}-\u{1F}\u{7F}-\u{9F}\u{AD}\u{200B}-\u{200F}\u{202A}-\u{202E}\u{2060}-\u{2064}\u{2066}-\u{2069}\u{FEFF}\u{E0000}-\u{E007F}]|[\u{FE00}-\u{FE0F}]|[\u{E0100}-\u{E01EF}]/gu;

/** Named HTML entities worth decoding; anything else stays verbatim. */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    ndash: "–",
    mdash: "—",
    hellip: "…",
    copy: "©",
    reg: "®",
    trade: "™",
};

/**
 * Remove invisible and bidi-control characters (see {@link INVISIBLE_PATTERN})
 * and normalize line endings to `\n`.
 *
 * @param text Untrusted text.
 * @returns The text without invisible characters.
 */
export function stripInvisibleText(text: string): string {
    return text.replace(/\r\n?/g, "\n").replace(INVISIBLE_PATTERN, "");
}

/**
 * Baseline cleaning for every piece of external text that reaches the
 * agent (registry descriptions, tool texts, config files): invisible
 * characters and HTML comments — including an unterminated one, which
 * would hide everything after it in a rendered view — are removed.
 *
 * @param text Untrusted text.
 * @returns The cleaned text.
 */
export function sanitizeExternalText(text: string): string {
    return stripInvisibleText(text)
        .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
        .trim();
}

/**
 * Turn an external markdown/HTML document (a README) into plain text:
 * {@link sanitizeExternalText}, then images, badges and `<picture>` /
 * `<svg>` blocks out, remaining HTML tags stripped (their text kept,
 * block tags become line breaks), entities decoded, links rendered as
 * `text (url)`. Headings, lists and code fences stay — they are plain
 * text already.
 *
 * @param markdown Untrusted markdown.
 * @returns Plain text.
 */
export function markdownToPlainText(markdown: string): string {
    let text = sanitizeExternalText(markdown);
    text = text
        .replace(/<(picture|svg|video|audio|script|style)\b[\s\S]*?<\/\1\s*>/gi, "")
        .replace(/<img\b[^>]*>/gi, "")
        // Linked images / badges: [![alt](img)](link) — drop entirely.
        .replace(/\[\s*!\[[^\]]*\]\([^)]*\)\s*\]\([^)]*\)/g, "")
        .replace(/\[\s*!\[[^\]]*\]\[[^\]]*\]\s*\]\[[^\]]*\]/g, "")
        // Plain images: ![alt](src) and ![alt][ref].
        .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
        .replace(/!\[[^\]]*\]\[[^\]]*\]/g, "")
        // Inline links: [text](url "title") → text (url).
        .replace(/\[([^\]]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, "$1 ($2)")
        .replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi, "$2 ($1)")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(
            /<\/?(p|div|h[1-6]|li|ul|ol|table|tr|details|summary|blockquote|pre)\b[^>]*>/gi,
            "\n",
        )
        .replace(/<\/?[a-z][a-z0-9-]*\b[^>]*>/gi, "");
    text = decodeEntities(text);
    // Entity decoding can produce invisible characters again (&#8203;).
    text = stripInvisibleText(text);
    return text
        .split("\n")
        .map((line) => line.trimEnd())
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

/**
 * Decode numeric and a small set of named HTML entities.
 *
 * @param text Text with entities.
 * @returns The decoded text.
 */
function decodeEntities(text: string): string {
    return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, body: string) => {
        if (body.startsWith("#")) {
            const isHex = body[1] === "x" || body[1] === "X";
            const code = Number.parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10);
            return Number.isFinite(code) && code > 0 && code <= 0x10ffff
                ? String.fromCodePoint(code)
                : match;
        }
        return NAMED_ENTITIES[body.toLowerCase()] ?? match;
    });
}
