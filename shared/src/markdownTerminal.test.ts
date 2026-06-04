import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { renderMarkdown } from "./markdownTerminal.js";

/**
 * Strip ANSI escape sequences so a rendered line's visible width can
 * be measured with `.length`.
 *
 * @param text - ANSI-styled string
 * @returns the same string without SGR / cursor escape sequences
 */
function stripAnsi(text: string): string {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are control chars by definition.
    return text.replace(/\[[0-9;]*m/g, "");
}

/**
 * Force `process.stdout.columns` for one render. Returns a restore
 * thunk registered with `afterEach`.
 *
 * @param columns - the terminal width to simulate
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

test("a wide table is constrained to the terminal width", () => {
    setColumns(40);
    const md = [
        "| Name | Description |",
        "| --- | --- |",
        "| alpha | a fairly long description that would otherwise run far past the right edge of a narrow terminal |",
    ].join("\n");
    const rendered = renderMarkdown(md);
    const lines = stripAnsi(rendered).split("\n");
    for (const line of lines) {
        assert.ok(
            line.length <= 40,
            `line exceeds width (${line.length}): ${JSON.stringify(line)}`,
        );
    }
    // The long cell must have wrapped onto several rows rather than
    // being emitted on one overflowing line.
    assert.ok(lines.length > 5, "expected the long description to wrap across rows");
});

test("a table nested in blockquotes stays within the terminal width", () => {
    setColumns(60);
    const table = [
        "| File | Score | Description |",
        "| --- | --- | --- |",
        "| people/familie-schiefke.md | 84 | Bekannte der Familie, mit denen Mattis verreist ist und noch mehr |",
    ];
    for (const depth of [1, 2, 3]) {
        const prefix = "> ".repeat(depth);
        const md = table.map((line) => prefix + line).join("\n");
        const lines = stripAnsi(renderMarkdown(md)).split("\n");
        for (const line of lines) {
            assert.ok(
                line.length <= 60,
                `depth ${depth} line exceeds width (${line.length}): ${JSON.stringify(line)}`,
            );
        }
    }
});

test("inline markdown survives inside table cells", () => {
    setColumns(80);
    const md = ["| Field | Value |", "| --- | --- |", "| status | **done** |"].join("\n");
    const rendered = renderMarkdown(md);
    // The bold marker must not leak through verbatim, and the word
    // itself must still be present.
    assert.ok(!rendered.includes("**done**"), "bold markers leaked into table cell");
    assert.ok(stripAnsi(rendered).includes("done"), "cell text missing");
});

test("inline-code colons and HTML entities resolve inside table cells", () => {
    setColumns(80);
    const md = [
        "| Field | Value |",
        "| --- | --- |",
        "| Topic | `chat:cli` |",
        "| Ratio | a < b & c |",
    ].join("\n");
    const rendered = stripAnsi(renderMarkdown(md));
    // marked-terminal shields inline-code colons behind an internal
    // placeholder; our table path must undo it.
    assert.ok(!rendered.includes("*#COLON|*"), "colon placeholder leaked into cell");
    assert.ok(rendered.includes("chat:cli"), "inline-code colon not restored");
    // HTML entities must be unescaped for the terminal.
    assert.ok(!/&(amp|lt|gt);/.test(rendered), "HTML entity leaked into cell");
    assert.ok(rendered.includes("a < b & c"), "entity text not restored");
});

test("long list items reflow without exceeding the width and keep their indent", () => {
    setColumns(40);
    const md =
        "- This is a single bullet whose text is long enough that it must wrap across multiple lines when the terminal is narrow.";
    const rendered = renderMarkdown(md);
    const lines = stripAnsi(rendered)
        .split("\n")
        .filter((line) => line.trim().length > 0);
    for (const line of lines) {
        assert.ok(
            line.length <= 40,
            `line exceeds width (${line.length}): ${JSON.stringify(line)}`,
        );
    }
    // The first line carries the bullet; every wrapped continuation
    // keeps a hanging indent rather than collapsing back to column 0.
    assert.ok(lines.length > 1, "expected the bullet text to wrap");
    assert.ok(/^•\s/.test(lines[0]), `first line missing bullet: ${JSON.stringify(lines[0])}`);
    for (const line of lines.slice(1)) {
        assert.ok(/^\s/.test(line), `continuation line lost its indent: ${JSON.stringify(line)}`);
    }
});

test("paragraphs nested in blockquotes stay within the terminal width", () => {
    setColumns(60);
    const sentence =
        "This is a fairly long quoted paragraph that must wrap several times so we can confirm the indentation is subtracted from the available width.";
    for (const depth of [1, 2, 3]) {
        const md = `${"> ".repeat(depth)}${sentence}`;
        const lines = stripAnsi(renderMarkdown(md)).split("\n");
        for (const line of lines) {
            assert.ok(
                line.length <= 60,
                `depth ${depth} line exceeds width (${line.length}): ${JSON.stringify(line)}`,
            );
        }
    }
});

test("width is read per render, so a resize is picked up", () => {
    const md =
        "A paragraph long enough to wrap differently at narrow versus wide terminal widths, demonstrating that the render width is not frozen at first call.";
    setColumns(40);
    const narrow = stripAnsi(renderMarkdown(md));
    setColumns(120);
    const wide = stripAnsi(renderMarkdown(md));
    const narrowMax = Math.max(...narrow.split("\n").map((l) => l.length));
    const wideMax = Math.max(...wide.split("\n").map((l) => l.length));
    assert.ok(narrowMax <= 40, `narrow render exceeded 40 (${narrowMax})`);
    assert.ok(wideMax > 40, `wide render did not use the extra width (${wideMax})`);
});
