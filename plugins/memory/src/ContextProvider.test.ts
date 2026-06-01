import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { formatMemoryTable, sanitizeDescription } from "./ContextProvider.js";

describe("formatMemoryTable", () => {
    it("renders the header, preamble, and a row per file", () => {
        const out = formatMemoryTable([
            { path: "wiki/people/adam.md", scorePercent: 88, description: "Adam is a coworker." },
            { path: "mail/index.md", scorePercent: 64, description: "(Handler file)" },
        ]);
        const lines = out.split("\n");
        assert.equal(lines[0], "# Memories");
        assert.match(out, /Files matching your prompt/);
        assert.match(out, /\| File \| Score \(1-100\) \| Description \|/);
        assert.match(out, /\| - \| - \| - \|/);
        assert.match(out, /\| `wiki\/people\/adam\.md` \| 88 \| Adam is a coworker\. \|/);
        assert.match(out, /\| `mail\/index\.md` \| 64 \| \(Handler file\) \|/);
    });

    it("escapes pipes already escaped by sanitizeDescription upstream", () => {
        // formatMemoryTable trusts the caller to have sanitized; verify it
        // does not double-process a backslash-escaped pipe.
        const out = formatMemoryTable([
            { path: "wiki/a.md", scorePercent: 50, description: "a \\| b" },
        ]);
        assert.match(out, /\| `wiki\/a\.md` \| 50 \| a \\\| b \|/);
    });

    it("emits a table with no data rows when given no rows", () => {
        const out = formatMemoryTable([]);
        assert.match(out, /\| - \| - \| - \|/);
        assert.ok(!out.includes("| `"));
    });
});

describe("sanitizeDescription", () => {
    it("strips inline markdown markup", () => {
        assert.equal(
            sanitizeDescription("**Bold** _italic_ `code` ~~strike~~"),
            "Bold italic code strike",
        );
    });

    it("keeps link text and drops the target", () => {
        assert.equal(
            sanitizeDescription("See [the docs](https://example.com/x) now"),
            "See the docs now",
        );
    });

    it("drops leading heading hashes and blockquote markers", () => {
        assert.equal(sanitizeDescription("# Title\n> quoted line"), "Title quoted line");
    });

    it("collapses all whitespace to single spaces", () => {
        assert.equal(sanitizeDescription("a\n\n  b\tc   d"), "a b c d");
    });

    it("escapes pipes so a table row stays well-formed", () => {
        assert.equal(sanitizeDescription("a | b | c"), "a \\| b \\| c");
    });

    it("truncates to 200 characters with an ellipsis", () => {
        const result = sanitizeDescription("x".repeat(300));
        assert.equal(result.length, 200);
        assert.ok(result.endsWith("…"));
    });

    it("leaves a short string untouched and trims it", () => {
        assert.equal(sanitizeDescription("  hello  "), "hello");
    });

    it("returns empty string for empty input", () => {
        assert.equal(sanitizeDescription(""), "");
    });
});
