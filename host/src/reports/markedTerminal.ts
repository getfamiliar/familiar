import { marked } from "marked";
import { markedTerminal } from "marked-terminal";

/**
 * Marked-terminal extension is registered once per process — `marked`
 * is a singleton, so re-registering on each call would compound
 * extensions. The width tracks `process.stdout.columns` at module
 * load; if the operator resizes mid-`report tail` the layout uses
 * the original width. Acceptable for v1.
 */
let registered = false;

function ensureRegistered(): void {
    if (registered) {
        return;
    }
    const width = process.stdout.columns ?? 100;
    // The marked-terminal types lag behind marked v15; the extension
    // works at runtime but can't satisfy the new TS signature. Cast
    // to `never` is the recommended workaround in the marked-terminal
    // docs while their types catch up.
    marked.use(markedTerminal({ width }) as never);
    registered = true;
}

/** Render markdown to ANSI-styled terminal output via marked-terminal. */
export function md(input: string): string {
    ensureRegistered();
    return marked.parse(input) as string;
}
