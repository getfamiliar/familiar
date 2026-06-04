// `marked-terminal` decides whether to emit OSC 8 terminal hyperlinks
// based on the environment, read once when `supports-hyperlinks` loads.
// Force it on *before* importing the renderer so links are emitted,
// then assert table cells strip them — otherwise cli-table3's wrapping
// corrupts the text and misaligns the borders (the alex-auer.md bug).
process.env.FORCE_HYPERLINK = "1";

import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";

const { renderMarkdown } = await import("./markdownTerminal.js");

/**
 * Whether the string contains an OSC 8 terminal-hyperlink escape.
 *
 * @param text - rendered output
 * @returns true if an OSC 8 sequence is present
 */
function hasOsc8(text: string): boolean {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: OSC escapes are control chars by definition.
    return /\x1b\]8;/.test(text);
}

/**
 * Strip both SGR colour codes and OSC 8 hyperlink wrappers so a
 * rendered line's visible width can be measured with `.length`.
 *
 * @param text - ANSI-styled string
 * @returns the visible text only
 */
function stripAllAnsi(text: string): string {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: OSC escapes are control chars by definition.
    const withoutLinks = text.replace(/\x1b\]8;[^;]*;[^\x1b\x07]*(?:\x07|\x1b\\)/g, "");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: SGR escapes are control chars by definition.
    return withoutLinks.replace(/\x1b\[[0-9;]*m/g, "");
}

const originalColumns = process.stdout.columns;
afterEach(() => {
    Object.defineProperty(process.stdout, "columns", {
        value: originalColumns,
        configurable: true,
        writable: true,
    });
});
after(() => {
    process.env.FORCE_HYPERLINK = undefined;
});

test("hyperlinks are actually emitted in prose under FORCE_HYPERLINK (guards the test)", () => {
    const rendered = renderMarkdown("Contact <someone@example.com> for details.");
    assert.ok(hasOsc8(rendered), "expected OSC 8 hyperlink in paragraph output");
});

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

const md = [
    "| File | Score | Description |",
    "| --- | --- | --- |",
    "| people/alex.md | 80 | Organises the check-in for Steffen. Contact: <alex@aauer.de>. |",
].join("\n");

test("a hyperlinked email in a table cell renders intact, not as OSC 8 bytes", () => {
    setColumns(120); // wide enough that the cell does not wrap
    const rendered = renderMarkdown(md);
    assert.ok(!hasOsc8(rendered), "OSC 8 hyperlink leaked into a table cell");
    assert.ok(stripAllAnsi(rendered).includes("alex@aauer.de"), "email text was corrupted");
});

test("table borders stay aligned when a hyperlinked cell wraps at a narrow width", () => {
    setColumns(60); // forces the description column to wrap
    const rendered = renderMarkdown(md);
    assert.ok(!hasOsc8(rendered), "OSC 8 hyperlink leaked into a wrapped table cell");
    const borderWidths = stripAllAnsi(rendered)
        .split("\n")
        .filter((line) => /[┌├└]/.test(line))
        .map((line) => line.length);
    assert.ok(borderWidths.length >= 2, "expected top and bottom borders");
    assert.ok(
        borderWidths.every((w) => w === borderWidths[0] && w <= 60),
        `border rows differ or overflow: ${borderWidths.join(",")}`,
    );
});
