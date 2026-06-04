// chalk only emits colour when it thinks the stream supports it, decided
// once at load. Force it on *before* importing the renderer so we can
// assert on the actual ANSI — these tests guard against the colour-bleed
// bug that motivated replacing marked-terminal (state leaking across line
// breaks / inner resets cancelling the surrounding block colour).
process.env.FORCE_COLOR = "3";

import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";

const { renderMarkdown } = await import("./markdownTerminal.js");

// Build regexes from a non-literal ESC so the source carries no control
// characters (which the linter rejects in regex literals).
const ESC = String.fromCharCode(27);
/** A colour/style open sequence, i.e. an SGR that is not a reset. */
const SGR_OPEN = new RegExp(`${ESC}\\[(?!0?m|39m|49m|22m|23m|24m|29m)[0-9;]+m`);
/** Any SGR reset sequence. */
const SGR_RESET = new RegExp(`${ESC}\\[(0?|39|49|22|23|24|29)m`);
/** The dim modifier that opens the blockquote bar. */
const DIM_OPEN = `${ESC}[2m`;
/** `text` appearing immediately after a foreground reset (i.e. default-coloured). */
const afterReset = (word: string): RegExp => new RegExp(`${ESC}\\[39m ${word}`);

/**
 * Set the simulated terminal width for the next render.
 *
 * @param columns - width in columns
 */
function setColumns(columns: number): void {
    Object.defineProperty(process.stdout, "columns", {
        value: columns,
        configurable: true,
        writable: true,
    });
}

const originalColumns = process.stdout.columns;
afterEach(() => {
    setColumns(originalColumns as number);
});
after(() => {
    process.env.FORCE_COLOR = undefined;
});

test("colour is emitted under FORCE_COLOR (guards the test)", () => {
    setColumns(80);
    assert.ok(renderMarkdown("a `code` b").includes(`${ESC}[`), "expected ANSI in output");
});

test("text after a codespan returns to the default colour", () => {
    setColumns(80);
    const rendered = renderMarkdown("alpha `code` betaword gamma");
    // After the codespan's foreground reset, the following word must appear
    // with no colour re-opened in between.
    assert.ok(
        afterReset("betaword").test(rendered),
        `codespan colour bled: ${JSON.stringify(rendered)}`,
    );
});

test("a style never bleeds across a wrapped line break", () => {
    setColumns(36);
    // Bold sits on the first line; the paragraph then wraps several times.
    const rendered = renderMarkdown(
        "Here is **bold** followed by a good deal of plain words that wrap onto several lines here indeed.",
    );
    const lines = rendered.split("\n").filter((line) => line.trim().length > 0);
    assert.ok(lines.length > 2, "expected the paragraph to wrap");
    // The bold background (256-colour 236) must not appear on any line past
    // the first — i.e. it does not leak across the wrap.
    for (const line of lines.slice(1)) {
        assert.ok(
            !line.includes("48;5;236"),
            `bold bled onto a later line: ${JSON.stringify(line)}`,
        );
    }
    // Every wrapped line is self-contained: if it opens a style it also resets.
    for (const line of lines) {
        if (SGR_OPEN.test(line)) {
            assert.ok(SGR_RESET.test(line), `line not reset: ${JSON.stringify(line)}`);
        }
    }
});

test("a codespan inside a blockquote leaves the following word default-coloured", () => {
    setColumns(80);
    const rendered = renderMarkdown("> The skills live in the `skills/` folder now.");
    // The user's report: `folder` must be default-coloured, not grey.
    assert.ok(
        afterReset("folder").test(rendered),
        `blockquote codespan bled: ${JSON.stringify(rendered)}`,
    );
    // Every rendered line re-opens the dim blockquote bar (state is not
    // assumed to carry over from the previous line).
    const lines = rendered.split("\n").filter((line) => line.trim().length > 0);
    for (const line of lines) {
        assert.ok(
            line.startsWith(DIM_OPEN),
            `blockquote line missing its bar: ${JSON.stringify(line)}`,
        );
    }
});
