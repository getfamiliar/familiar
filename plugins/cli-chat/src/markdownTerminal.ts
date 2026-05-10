import { marked } from "marked";
import { markedTerminal } from "marked-terminal";

/**
 * Render assistant chat replies as ANSI-styled terminal output via
 * `marked-terminal`. Mirrors the host-side helper at
 * `host/src/reports/markedTerminal.ts` (kept duplicated rather than
 * shared because plugins must not reach into host internals — see
 * the "ctx only" feedback memory).
 *
 * `marked` is a singleton, so the extension is registered once per
 * process. Width is captured at first call; a mid-session resize
 * keeps the original width — acceptable for a chat REPL.
 *
 * Trailing newlines from `marked` are trimmed so the caller can add
 * its own visual separator without compounding.
 */
let registered = false;

function ensureRegistered(): void {
    if (registered) {
        return;
    }
    const width = process.stdout.columns ?? 100;
    // The marked-terminal types lag behind marked v15; the extension
    // works at runtime but can't satisfy the new TS signature. Cast
    // to `never` matches the host-side helper.
    marked.use(markedTerminal({ width }) as never);
    registered = true;
}

/**
 * Render a markdown string to ANSI-styled terminal output. Caller
 * is expected to have already decided (via TTY check) that ANSI is
 * appropriate; this function does no TTY detection of its own.
 */
export function renderMarkdown(input: string): string {
    ensureRegistered();
    const rendered = marked.parse(input) as string;
    return rendered.replace(/\n+$/, "");
}
