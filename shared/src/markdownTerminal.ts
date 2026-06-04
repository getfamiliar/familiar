import chalk from "chalk";
import { highlight } from "cli-highlight";
import Table from "cli-table3";
import { Marked, type Tokens } from "marked";
import { stdout as terminalSupportsHyperlinks } from "supports-hyperlinks";
import wrapAnsi from "wrap-ansi";

/**
 * Render a markdown string to ANSI-styled terminal output. Used by
 * host-side `report` rendering and by the cli-chat plugin so chat
 * replies pick up headings, lists, code blocks, and inline emphasis
 * instead of leaking raw markdown.
 *
 * This is a self-contained renderer built on `marked` (the parser)
 * plus `cli-highlight` (code), `cli-table3` (tables), `chalk` (inline
 * styling), and `wrap-ansi` (wrapping). It replaces `marked-terminal`,
 * whose block-styling-plus-reflow model produced two classes of bug we
 * could not fix from the outside:
 *
 *   1. **Indentation-blind width.** It reflowed each block to the full
 *      width and only then indented it for blockquotes/lists, so nested
 *      prose and tables overflowed the terminal.
 *   2. **ANSI bleed.** It wrapped each block in a single open/close
 *      style pair, then split the block into lines without re-opening
 *      the style per line — so colour state leaked across newlines and
 *      inner resets (a codespan's `ESC[39m`) cancelled the surrounding
 *      block colour.
 *
 * Both are avoided here by (a) tracking the remaining content width
 * (`avail`) as we descend into containers, so every block wraps to the
 * width it will actually occupy, and (b) wrapping with `wrap-ansi`,
 * which emits self-contained lines (styles re-opened at each line start
 * and closed at each line end). Inline spans are never wrapped — all
 * wrapping happens at block boundaries — so an escape sequence is never
 * split mid-line.
 *
 * The output is width-aware per call: every render reads the current
 * terminal width, so a long-lived chat REPL picks up resizes between
 * turns.
 */

/** Upper bound on render width; full-width prose is hard to read on ultra-wide terminals. */
const MAX_WIDTH = 180;

/** Fallback width when stdout is not a TTY (no `columns`). */
const FALLBACK_WIDTH = 100;

/** Floor on the content width at deep nesting, so wrapping never degenerates. */
const MIN_CONTENT_WIDTH = 12;

/** Columns a blockquote reserves for its `│ ` bar. */
const BLOCKQUOTE_RESERVE = 2;

/** cli-table3 reserves one space of padding on each side of a cell; colWidth = content + this. */
const CELL_PADDING = 2;

/** Smallest table `colWidth` we will shrink a column to — one content char plus padding. */
const MIN_COL_WIDTH = CELL_PADDING + 1;

/** Inline and block styles. Kept here so the look is tweakable in one place. */
const STYLE = {
    // Bold gets a dark-gray background (palette index 236 ≈ #303030): plain
    // bold is invisible in monospace fonts without a bold variant, so the
    // block reads as a highlighter on any 256-colour terminal.
    strong: chalk.bgAnsi256(236).bold,
    em: chalk.italic,
    del: chalk.dim.strikethrough,
    codespan: chalk.yellow,
    code: chalk.yellow,
    link: chalk.blue.underline,
    heading: chalk.green.bold,
    firstHeading: chalk.magenta.underline.bold,
    blockquoteBar: chalk.dim("│ "),
    hr: chalk.dim,
    html: chalk.gray,
};

/**
 * The render context marked injects on each renderer method as `this`.
 */
interface RendererThis {
    parser: {
        parse(tokens: Tokens.Generic[], top?: boolean): string;
        parseInline(tokens: Tokens.Generic[]): string;
    };
}

/**
 * Unescape the HTML entities marked emits in text and code spans, so the
 * terminal shows the real characters (`&amp;` → `&`, `&lt;` → `<`, …).
 *
 * @param text - possibly entity-escaped string
 * @returns the string with the common entities resolved
 */
function unescapeEntities(text: string): string {
    return text
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
}

/**
 * Remove OSC 8 terminal-hyperlink escape sequences, keeping the visible
 * link text. The `link` renderer emits these when the terminal supports
 * hyperlinks, but cli-table3's cell wrapping only understands SGR colour
 * codes — a link inside a wrapped table cell would have its width
 * miscounted and its bytes split mid-sequence — so table cells render
 * links as plain (non-clickable) text. The sequence is
 * `ESC ] 8 ; params ; URI ST text ESC ] 8 ; ; ST`, ST = BEL or `ESC \`.
 *
 * @param text - possibly hyperlink-bearing styled string
 * @returns the string with OSC 8 wrappers removed
 */
function stripHyperlinks(text: string): string {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: OSC escapes are control chars by definition.
    return text.replace(/\x1b\]8;[^;]*;[^\x1b\x07]*(?:\x07|\x1b\\)/g, "");
}

/**
 * Wrap an OSC 8 terminal hyperlink around visible (already-styled) text.
 *
 * @param text - the visible, clickable text
 * @param url - the link target
 * @returns the text wrapped in an OSC 8 hyperlink sequence
 */
function hyperlink(text: string, url: string): string {
    return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}

/**
 * Visible length of a cell's raw source text. Slightly over-estimates
 * (markdown markers count), which only hands a column a touch more room
 * — cli-table3 does the exact ANSI-aware wrapping itself.
 *
 * @param text - raw markdown cell text
 * @returns character count
 */
function visibleLength(text: string): number {
    return text.length;
}

/**
 * Decide per-column `colWidths` for a markdown table so it fits the
 * available width. Returns `undefined` when the table's natural size
 * already fits — letting cli-table3 size columns to content with no
 * wrapping. On overflow, distributes the available width across columns
 * proportionally to their natural size, with a per-column floor.
 *
 * @param naturalContent - natural content width of each column (no padding)
 * @param width - width to fit within
 * @returns colWidths array including padding, or `undefined` for natural sizing
 */
function budgetColumns(naturalContent: readonly number[], width: number): number[] | undefined {
    const columnCount = naturalContent.length;
    if (columnCount === 0) {
        return undefined;
    }
    const borders = columnCount + 1;
    const naturalColWidths = naturalContent.map((content) => content + CELL_PADDING);
    const naturalTotal = naturalColWidths.reduce((sum, w) => sum + w, 0) + borders;
    if (naturalTotal <= width) {
        return undefined;
    }
    const available = Math.max(width, MIN_COL_WIDTH * columnCount + borders) - borders;
    const naturalSum = naturalColWidths.reduce((sum, w) => sum + w, 0);
    const widths = naturalColWidths.map((w) =>
        Math.max(MIN_COL_WIDTH, Math.round((available * w) / naturalSum)),
    );
    // Rounding and the floor can push the total back over `available`;
    // trim from the widest column above the floor until it fits.
    let total = widths.reduce((sum, w) => sum + w, 0);
    while (total > available) {
        let widestIndex = -1;
        for (let i = 0; i < widths.length; i += 1) {
            if (
                widths[i] > MIN_COL_WIDTH &&
                (widestIndex === -1 || widths[i] > widths[widestIndex])
            ) {
                widestIndex = i;
            }
        }
        if (widestIndex === -1) {
            break;
        }
        widths[widestIndex] -= 1;
        total -= 1;
    }
    return widths;
}

/**
 * Build the marked renderer. All wrapping and indentation is driven by a
 * mutable `avail` (remaining content width) captured in this closure:
 * container renderers shrink it before parsing their children and
 * restore it after (marked parses depth-first and synchronously, so this
 * is safe), and block renderers wrap to it. The visible left margin is
 * applied per line by the container as the recursion unwinds, so the
 * total margin equals the columns reserved.
 *
 * @param width - the effective terminal width for this render
 * @returns a marked `RendererObject` plus the `avail` accessor it closes over
 */
function buildRenderer(width: number) {
    let avail = width;

    /** Wrap styled text to a width, emitting self-contained lines. */
    const wrap = (styled: string, w: number, trim = true): string =>
        wrapAnsi(styled, Math.max(MIN_CONTENT_WIDTH, w), { hard: true, trim });

    /** Run `render` with `avail` reduced by `reserve`, then restore it. */
    const withReserved = (reserve: number, render: () => string): string => {
        const saved = avail;
        avail = Math.max(MIN_CONTENT_WIDTH, avail - reserve);
        try {
            return render();
        } finally {
            avail = saved;
        }
    };

    /** Prefix the first line with `first`, the rest with `rest` (empty lines stay empty). */
    const prefixLines = (text: string, first: string, rest: string): string =>
        text
            .split("\n")
            .map((line, index) => (line === "" ? "" : (index === 0 ? first : rest) + line))
            .join("\n");

    const parseCell = function (this: RendererThis, cell: Tokens.TableCell): string {
        return stripHyperlinks(this.parser.parseInline(cell.tokens));
    };

    /**
     * Render one list item: render its content at the reduced width, then
     * wrap and prefix the first line with the bullet/number and
     * continuation lines with matching spaces (hanging indent). Nested
     * lists already fit the reduced width, so re-wrapping leaves them
     * untouched while still wrapping the item's own long leading text.
     */
    const renderItem = function (
        this: RendererThis,
        item: Tokens.ListItem,
        marker: string,
        markerWidth: number,
    ): string {
        const contentWidth = Math.max(MIN_CONTENT_WIDTH, avail - markerWidth);
        const saved = avail;
        avail = contentWidth;
        let content: string;
        try {
            content = this.parser.parse(item.tokens, !!item.loose);
        } finally {
            avail = saved;
        }
        let body = content.replace(/\n+$/u, "");
        if (item.task) {
            body = `[${item.checked ? "x" : " "}] ${body}`;
        }
        // trim:false so the leading indentation of nested list lines survives;
        // strip only trailing whitespace that the no-trim wrap leaves behind.
        const wrapped = wrap(body, contentWidth, false).replace(/[^\S\n]+$/gmu, "");
        return `${prefixLines(wrapped, marker, " ".repeat(markerWidth))}\n`;
    };

    const renderer: Record<string, (this: RendererThis, ...args: never[]) => string> = {
        space(): string {
            return "";
        },
        text(this: RendererThis, token: Tokens.Text | Tokens.Escape): string {
            // Block `text` tokens (tight list items) carry inline children; render
            // them and add a trailing newline so a following nested list separates
            // from the item's leading text. Wrapping is the caller's job — never
            // wrap inline content here. Inline `text` tokens have no `.tokens` and
            // hit the plain branch, so this newline is block-only.
            if ("tokens" in token && Array.isArray(token.tokens) && token.tokens.length > 0) {
                return `${this.parser.parseInline(token.tokens)}\n`;
            }
            return unescapeEntities(token.text);
        },
        paragraph(this: RendererThis, token: Tokens.Paragraph): string {
            return `${wrap(this.parser.parseInline(token.tokens), avail)}\n\n`;
        },
        heading(this: RendererThis, token: Tokens.Heading): string {
            const prefix = `${"#".repeat(token.depth)} `;
            const style = token.depth === 1 ? STYLE.firstHeading : STYLE.heading;
            return `${wrap(style(prefix + this.parser.parseInline(token.tokens)), avail)}\n\n`;
        },
        blockquote(this: RendererThis, token: Tokens.Blockquote): string {
            const inner = withReserved(BLOCKQUOTE_RESERVE, () =>
                this.parser.parse(token.tokens),
            ).replace(/\n+$/u, "");
            const bar = STYLE.blockquoteBar;
            const body = inner
                .split("\n")
                .map((line) => bar + line)
                .join("\n");
            return `${body}\n\n`;
        },
        list(this: RendererThis, token: Tokens.List): string {
            const ordered = token.ordered;
            const start = typeof token.start === "number" && token.start ? token.start : 1;
            const markerWidth = ordered ? String(start + token.items.length - 1).length + 2 : 2;
            const parts = token.items.map((item, index) => {
                const marker = ordered ? `${start + index}. `.padEnd(markerWidth) : "• ";
                return renderItem.call(this, item, marker, markerWidth);
            });
            return `${parts.join("")}\n`;
        },
        listitem(): string {
            // Items are rendered by `list` via `renderItem`; never reached.
            return "";
        },
        checkbox(_token: Tokens.Checkbox): string {
            // Task state is handled inline in `renderItem`; never reached.
            return "";
        },
        code(token: Tokens.Code): string {
            const language = token.lang?.trim() || undefined;
            if (chalk.level === 0) {
                return `${token.text.replace(/\n+$/u, "")}\n\n`;
            }
            let body: string;
            try {
                body = highlight(token.text, { language, ignoreIllegals: true });
            } catch {
                body = STYLE.code(token.text);
            }
            return `${body.replace(/\n+$/u, "")}\n\n`;
        },
        hr(): string {
            return `${STYLE.hr("─".repeat(Math.max(MIN_CONTENT_WIDTH, avail)))}\n\n`;
        },
        br(): string {
            return "\n";
        },
        html(token: Tokens.HTML | Tokens.Tag): string {
            return STYLE.html(token.text);
        },
        strong(this: RendererThis, token: Tokens.Strong): string {
            return STYLE.strong(this.parser.parseInline(token.tokens));
        },
        em(this: RendererThis, token: Tokens.Em): string {
            return STYLE.em(this.parser.parseInline(token.tokens));
        },
        del(this: RendererThis, token: Tokens.Del): string {
            return STYLE.del(this.parser.parseInline(token.tokens));
        },
        codespan(token: Tokens.Codespan): string {
            return STYLE.codespan(unescapeEntities(token.text));
        },
        link(this: RendererThis, token: Tokens.Link): string {
            const text = this.parser.parseInline(token.tokens);
            const href = token.href;
            if (terminalSupportsHyperlinks) {
                return hyperlink(STYLE.link(text || href), href);
            }
            if (text && text !== href) {
                return `${STYLE.link(text)} (${chalk.dim(href)})`;
            }
            return STYLE.link(href);
        },
        image(token: Tokens.Image): string {
            return `![${token.text}](${token.href})`;
        },
        table(this: RendererThis, token: Tokens.Table): string {
            const cell = parseCell.bind(this);
            const naturalContent = token.header.map((header, columnIndex) =>
                Math.max(
                    visibleLength(header.text),
                    ...token.rows.map((row) => visibleLength(row[columnIndex]?.text ?? "")),
                ),
            );
            const colWidths = budgetColumns(naturalContent, avail);
            const table = new Table({
                head: token.header.map(cell),
                wordWrap: true,
                wrapOnWordBoundary: false,
                // Passing `colWidths: undefined` makes cli-table3 throw, so the
                // key is omitted entirely when the table fits naturally.
                ...(colWidths ? { colWidths } : {}),
            });
            for (const row of token.rows) {
                table.push(row.map(cell));
            }
            return `${table.toString()}\n\n`;
        },
        tablerow(): string {
            return "";
        },
        tablecell(): string {
            return "";
        },
    };

    return renderer;
}

/**
 * Render markdown to ANSI-styled terminal output at the current terminal
 * width. Caller is expected to have decided (e.g. via a TTY check) that
 * ANSI styling is appropriate; this function does no TTY detection of its
 * own and always emits styled output.
 *
 * Trailing newlines are preserved — call sites that print a separator
 * afterwards may want to `.replace(/\n+$/, "")` to avoid compounding
 * blank lines.
 *
 * @param input - markdown source
 * @returns ANSI-styled terminal output
 */
export function renderMarkdown(input: string): string {
    const width = Math.min(process.stdout.columns ?? FALLBACK_WIDTH, MAX_WIDTH);
    const marked = new Marked();
    marked.use({ renderer: buildRenderer(width) as never });
    return marked.parse(input) as string;
}
