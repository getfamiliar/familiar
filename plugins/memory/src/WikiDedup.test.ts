import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
    groupByTopFolder,
    isSizeChangeSignificant,
    MAX_INLINE_GROUP_BYTES,
    pairsOf,
    parseScanReply,
    renderDeduplicatePrompt,
} from "./WikiDedup.js";

describe("parseScanReply", () => {
    const existing = new Set([
        "wiki/people/udo.md",
        "wiki/people/udo-sperling.md",
        "wiki/people/udo-spehrling.md",
        "wiki/threads/2026-11-sofa.md",
        "wiki/threads/2026-neues-sofa.md",
        "wiki/people/a.md",
        "wiki/people/b.md",
        "wiki/people/c.md",
        "wiki/people/d.md",
        "wiki/people/e.md",
        "wiki/people/f.md",
    ]);

    it("reads one group per line, comma-separated", () => {
        const { groups, warnings } = parseScanReply(
            "wiki/people/udo.md, wiki/people/udo-sperling.md, wiki/people/udo-spehrling.md\nwiki/threads/2026-11-sofa.md, wiki/threads/2026-neues-sofa.md\n",
            existing,
        );
        assert.deepEqual(groups, [
            ["wiki/people/udo.md", "wiki/people/udo-sperling.md", "wiki/people/udo-spehrling.md"],
            ["wiki/threads/2026-11-sofa.md", "wiki/threads/2026-neues-sofa.md"],
        ]);
        assert.deepEqual(warnings, []);
    });

    it("tolerates prose, list markers and backticks, drops missing paths and duplicates", () => {
        const { groups, warnings } = parseScanReply(
            "Here are the candidates:\n- `wiki/people/udo.md`, `wiki/people/udo.md`, wiki/people/gone.md\n1. wiki/people/udo.md, wiki/people/udo-sperling.md\n2. wiki/people/udo-sperling.md, wiki/people/udo.md\n",
            existing,
        );
        assert.deepEqual(groups, [["wiki/people/udo.md", "wiki/people/udo-sperling.md"]]);
        assert.deepEqual(warnings, ["wiki/people/gone.md does not exist"]);
    });

    it("keeps at most five files per group", () => {
        const { groups, warnings } = parseScanReply(
            "wiki/people/a.md, wiki/people/b.md, wiki/people/c.md, wiki/people/d.md, wiki/people/e.md, wiki/people/f.md",
            existing,
        );
        assert.equal(groups[0].length, 5);
        assert.equal(warnings.length, 1);
    });

    it("returns nothing for an empty reply", () => {
        assert.deepEqual(parseScanReply("", existing).groups, []);
        assert.deepEqual(parseScanReply("No duplicates found.", existing).groups, []);
    });
});

describe("pairs and staleness", () => {
    it("produces every sorted pair of a group", () => {
        assert.deepEqual(pairsOf(["wiki/c.md", "wiki/a.md", "wiki/b.md"]), [
            ["wiki/a.md", "wiki/b.md"],
            ["wiki/a.md", "wiki/c.md"],
            ["wiki/b.md", "wiki/c.md"],
        ]);
    });

    it("needs 20 % and at least 500 bytes of change, either way", () => {
        assert.equal(isSizeChangeSignificant(1000, 1400), false); // 40 % but only 400 bytes
        assert.equal(isSizeChangeSignificant(1000, 1500), true);
        assert.equal(isSizeChangeSignificant(1000, 500), true);
        assert.equal(isSizeChangeSignificant(10000, 11500), false); // 1500 bytes but 15 %
        assert.equal(isSizeChangeSignificant(10000, 12000), true);
        assert.equal(isSizeChangeSignificant(10000, 8000), true);
    });
});

describe("folders and prompts", () => {
    it("groups by top-level folder, clusters included, root files left out", () => {
        const folders = groupByTopFolder([
            "wiki/questions.md",
            "wiki/threads/sports-club/summer-camp.md",
            "wiki/people/a.md",
            "wiki/threads/acme.md",
        ]);
        assert.deepEqual(
            [...folders.entries()],
            [
                ["people", ["wiki/people/a.md"]],
                ["threads", ["wiki/threads/sports-club/summer-camp.md", "wiki/threads/acme.md"]],
            ],
        );
    });

    it("inlines small groups and only lists large ones", () => {
        const small = renderDeduplicatePrompt(
            new Map([
                ["wiki/people/udo.md", "# Udo\n"],
                ["wiki/people/udo-sperling.md", "# Udo Sperling\n"],
            ]),
        );
        assert.ok(small.includes('<file path="wiki/people/udo.md">\n# Udo\n</file>'));
        const large = renderDeduplicatePrompt(
            new Map([
                ["wiki/a.md", "x".repeat(MAX_INLINE_GROUP_BYTES)],
                ["wiki/b.md", "y"],
            ]),
        );
        assert.ok(!large.includes("<file"));
        assert.ok(large.includes("- wiki/a.md\n- wiki/b.md"));
    });
});
