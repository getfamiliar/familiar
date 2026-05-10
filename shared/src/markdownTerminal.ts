import chalk from "chalk";
import { marked, type Tokens } from "marked";
import { markedTerminal } from "marked-terminal";

/**
 * Render a markdown string to ANSI-styled terminal output via
 * `marked-terminal`. Used by host-side `report` rendering and by
 * the cli-chat plugin so chat replies pick up headings, lists,
 * code blocks, and inline emphasis instead of leaking raw markdown.
 *
 * Two notable customisations live in `ensureRegistered`:
 *
 *   1. **Bold gets a dark-gray background.** Plain `chalk.bold`
 *      (the default) is invisible in many monospace fonts that
 *      have no bold variant. Wrapping in `chalk.bgGray.bold` keeps
 *      the boldface intent and adds a clearly visible block.
 *   2. **Inline emphasis inside tight list items renders correctly.**
 *      marked-terminal's default `text` renderer is fed a string and
 *      can't descend into a token's inline children. In tight list
 *      items (the common case), marked v15 emits a block-level
 *      `text` token whose `tokens` field carries the inline
 *      strong/em/del children — without an override the markers
 *      leak through verbatim (`**zurück**`, `~~done~~`, …). The
 *      override calls `parseInline` whenever inline children are
 *      present and falls back to the literal text otherwise.
 *
 * `marked` is a singleton, so the extensions are registered exactly
 * once per process. Width is captured at first call — a mid-session
 * resize keeps the original width, which is fine for both the
 * one-shot `report` command and the long-lived chat REPL.
 */
let registered = false;

function ensureRegistered(): void {
    if (registered) {
        return;
    }
    const width = process.stdout.columns ?? 100;
    // The marked-terminal types lag behind marked v15; the extension
    // works at runtime but can't satisfy the new TS signature. Cast
    // to `never` is the workaround the marked-terminal docs suggest
    // until their types catch up.
    marked.use(
        markedTerminal({
            width,
            // 256-colour palette index 236 ≈ #303030 — a meaningful
            // step darker than chalk.bgGray's ~#666, so the bold
            // block reads as a highlighter rather than a faint
            // shade. Universal on any 256-colour terminal.
            strong: chalk.bgAnsi256(236).bold,
        }) as never,
    );
    marked.use({
        renderer: {
            text(token: Tokens.Text | Tokens.Escape): string {
                if ("tokens" in token && Array.isArray(token.tokens) && token.tokens.length > 0) {
                    return this.parser.parseInline(token.tokens);
                }
                return token.text;
            },
        },
    });
    registered = true;
}

/**
 * Render markdown to ANSI-styled terminal output. Caller is
 * expected to have decided (e.g. via a TTY check) that ANSI
 * styling is appropriate; this function does no TTY detection of
 * its own and always emits styled output.
 *
 * Trailing newlines from marked are preserved — call sites that
 * print a separator afterwards may want to `.replace(/\n+$/, "")`
 * to avoid compounding blank lines.
 */
export function renderMarkdown(input: string): string {
    ensureRegistered();
    return marked.parse(input) as string;
}
