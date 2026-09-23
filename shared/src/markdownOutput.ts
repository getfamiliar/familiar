import { renderMarkdown } from "./markdownTerminal.js";

/**
 * Escape a single value for use as a GitHub-flavoured-markdown table cell:
 * backslashes stay literal, `|` no longer splits the column, and any
 * newline collapses to a space so the row stays on one line. Backticks are
 * left untouched so inline-code spans in a cell survive. Mirrors the
 * escaping the `tools list --raw` renderer needs; that renderer's
 * `escapeCell` delegates here so there is a single implementation.
 *
 * @param text - raw cell text
 * @returns the text safe to drop between two `|` pipes
 */
export function escapeTableCell(text: string): string {
    return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/**
 * Build a GitHub-flavoured-markdown table from a header row and body rows.
 * Every cell is run through {@link escapeTableCell}. The result is meant to
 * be handed to {@link writeMarkdown}, which renders it (cli-table3) on a TTY
 * or emits it verbatim when piped.
 *
 * @param headers - column header labels
 * @param rows - one string tuple per row; each row should have `headers.length` cells
 * @returns a GFM table string terminated by a single newline
 */
export function markdownTable(
    headers: readonly string[],
    rows: readonly (readonly string[])[],
): string {
    const headerLine = `| ${headers.map(escapeTableCell).join(" | ")} |`;
    const separator = `| ${headers.map(() => "---").join(" | ")} |`;
    const body = rows.map((row) => `| ${row.map(escapeTableCell).join(" | ")} |`).join("\n");
    return body.length > 0
        ? `${headerLine}\n${separator}\n${body}\n`
        : `${headerLine}\n${separator}\n`;
}

/**
 * Write a markdown string to stdout as the single human-facing CLI/plugin
 * output sink: ANSI-styled via {@link renderMarkdown} on a TTY, or the raw
 * markdown verbatim when stdout is piped/redirected.
 *
 * The TTY check lives *inside* this function on purpose — no call site
 * should read `process.stdout.isTTY` itself. A caller can only ever *force*
 * raw output (e.g. to honour a `--raw` flag); it can never accidentally
 * render box-drawing tables and ANSI escapes into a pipe.
 *
 * @param markdown - markdown source to emit
 * @param opts - `raw: true` forces raw output even on a TTY; omitted/false lets the TTY check decide
 */
export function writeMarkdown(markdown: string, opts?: { readonly raw?: boolean }): void {
    const raw = opts?.raw === true || !process.stdout.isTTY;
    process.stdout.write(raw ? markdown : renderMarkdown(markdown));
}
