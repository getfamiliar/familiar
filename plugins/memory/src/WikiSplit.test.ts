import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { applyHarnessSplit, findOversizedFiles, splitInHalf } from "./WikiSplit.js";

/**
 * A section of roughly `bytes` bytes under a heading.
 *
 * @param heading - The heading line.
 * @param bytes - Approximate body size.
 * @returns The section.
 */
function section(heading: string, bytes: number): string {
    const bullets = Array.from({ length: Math.ceil(bytes / 20) }, (_, i) => `- fact ${i} xxxxxxx`);
    return `${heading}\n\n${bullets.join("\n")}\n`;
}

describe("splitInHalf", () => {
    const head = "---\ncategories: [work]\n---\n# Acme Rollout\n\nRollout of Acme at Contoso.\n\n";

    it("cuts at the h2 closest to the middle and keeps head and link", () => {
        const content = `${head}${section("## One", 1000)}\n${section("## Two", 1000)}\n${section("## Three", 1000)}\n${section("## Four", 1000)}`;
        const halves = splitInHalf(content, "threads/acme-rollout-2", "acme-rollout");
        assert.ok(halves);
        assert.ok(halves.first.startsWith(head));
        assert.ok(halves.first.includes("## Two\n"));
        assert.ok(!halves.first.includes("## Three"));
        assert.ok(halves.first.endsWith("\n\n→ [[threads/acme-rollout-2]]\n"));
        assert.ok(
            halves.second.startsWith(
                "---\ncategories: [work]\n---\n# Acme Rollout (2)\n\nRollout of Acme at Contoso.\n\n## Three\n",
            ),
        );
        assert.ok(halves.second.includes("## Four"));
    });

    it("prefers an h3 near the middle over an h2 far from it", () => {
        const content = `${head}${section("## Small", 100)}\n${section("## Big", 400)}\n${section("### Part A", 1500)}\n${section("### Part B", 1500)}`;
        const halves = splitInHalf(content, "threads/x-2", "x");
        assert.ok(halves);
        assert.ok(
            halves.second.includes(
                "# Acme Rollout (2)\n\nRollout of Acme at Contoso.\n\n### Part B\n",
            ),
        );
    });

    it("falls back to a paragraph break and never cuts inside a code fence", () => {
        const fence = `\`\`\`\n${"code line\n\ncode line\n".repeat(60)}\`\`\`\n`;
        const content = `# Notes\n\nSome notes.\n\nfirst paragraph\n\n${fence}\nlast paragraph\n`;
        const halves = splitInHalf(content, "self/notes-2", "notes");
        assert.ok(halves);
        const fences = (text: string): number => (text.match(/^```/gm) ?? []).length;
        assert.equal(fences(halves.first) % 2, 0);
        assert.equal(fences(halves.second) % 2, 0);
    });

    it("uses the slug as title when the file has no h1", () => {
        const content = `${section("## A", 500)}\n${section("## B", 500)}`;
        const halves = splitInHalf(content, "threads/plain-2", "plain");
        assert.ok(halves?.second.startsWith("# plain (2)\n\n## B\n"));
    });

    it("gives up when the body has nothing to cut", () => {
        assert.equal(splitInHalf("# X\n\nOnly a description.\n", "threads/x-2", "x"), undefined);
    });
});

describe("harness split on disk", () => {
    it("lists oversized files and writes the second half to the next free -N", async () => {
        const workspaceDir = mkdtempSync(path.join(tmpdir(), "familiar-memory-split-"));
        try {
            mkdirSync(path.join(workspaceDir, "wiki", "threads"), { recursive: true });
            const big = `# Big\n\nA big thread.\n\n${section("## A", 3000)}\n${section("## B", 3000)}`;
            writeFileSync(path.join(workspaceDir, "wiki", "threads", "big.md"), big);
            writeFileSync(path.join(workspaceDir, "wiki", "threads", "big-2.md"), "# Other\n");
            writeFileSync(path.join(workspaceDir, "wiki", "threads", "small.md"), "# Small\n");

            const oversized = await findOversizedFiles(workspaceDir, 2000);
            assert.deepEqual(
                oversized.map((file) => file.path),
                ["wiki/threads/big.md"],
            );

            const split = await applyHarnessSplit(workspaceDir, "wiki/threads/big.md");
            assert.deepEqual(split, {
                path: "wiki/threads/big.md",
                secondPath: "wiki/threads/big-3.md",
            });
            const first = readFileSync(
                path.join(workspaceDir, "wiki", "threads", "big.md"),
                "utf8",
            );
            const second = readFileSync(
                path.join(workspaceDir, "wiki", "threads", "big-3.md"),
                "utf8",
            );
            assert.ok(first.endsWith("→ [[threads/big-3]]\n"));
            assert.ok(second.startsWith("# Big (2)\n\nA big thread.\n\n## B\n"));
            assert.equal(
                readFileSync(path.join(workspaceDir, "wiki", "threads", "big-2.md"), "utf8"),
                "# Other\n",
            );
        } finally {
            rmSync(workspaceDir, { recursive: true, force: true });
        }
    });
});
