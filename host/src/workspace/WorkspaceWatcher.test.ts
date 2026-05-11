import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { matchSearchExpr, scanWorkspace } from "./WorkspaceWatcher.js";

test("matchSearchExpr anchors both ends without wildcards", () => {
    assert.equal(matchSearchExpr("foo", "foo"), true);
    assert.equal(matchSearchExpr("foo", "fooz"), false);
    assert.equal(matchSearchExpr("foo", "afoo"), false);
});

test("matchSearchExpr `*` alone matches any non-empty value", () => {
    assert.equal(matchSearchExpr("*", "anything"), true);
    assert.equal(matchSearchExpr("*", ""), true); // both parts empty
});

test("matchSearchExpr `*` at one end allows prefix/suffix", () => {
    assert.equal(matchSearchExpr("foo*", "foobar"), true);
    assert.equal(matchSearchExpr("foo*", "xfoo"), false);
    assert.equal(matchSearchExpr("*bar", "foobar"), true);
    assert.equal(matchSearchExpr("*bar", "bara"), false);
});

test("matchSearchExpr internal `*` is substring-in-order", () => {
    assert.equal(matchSearchExpr("foo*bar", "foozzzbar"), true);
    assert.equal(matchSearchExpr("foo*bar", "barfoo"), false);
});

test("scanWorkspace returns only files matching the frontmatter filter", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ws-watcher-"));
    try {
        writeFileSync(join(dir, "root-only.md"), "no frontmatter here\n");
        const sub = join(dir, "workflows");
        const subSub = join(dir, "mail");
        const fs = await import("node:fs/promises");
        await fs.mkdir(sub, { recursive: true });
        await fs.mkdir(subSub, { recursive: true });
        writeFileSync(join(sub, "digest.md"), "---\ncron: every monday at 8\n---\nbody\n");
        writeFileSync(join(sub, "no-cron.md"), "---\nmodel: foo\n---\nbody\n");
        writeFileSync(join(subSub, "scan.md"), "---\ncron: '*/5 * * * *'\n---\nbody\n");
        const out = await scanWorkspace(dir, { frontmatter: { cron: "*" } });
        const paths = out.map((f) => f.relativePath).sort();
        assert.deepEqual(paths, ["mail/scan.md", "workflows/digest.md"]);
        for (const f of out) {
            assert.ok(f.absolutePath.startsWith(dir));
            assert.equal(f.type, undefined);
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("scanWorkspace honours pathGlob filter", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ws-watcher-"));
    try {
        const fs = await import("node:fs/promises");
        await fs.mkdir(join(dir, "workflows"), { recursive: true });
        await fs.mkdir(join(dir, "mail"), { recursive: true });
        writeFileSync(join(dir, "workflows", "a.md"), "---\ncron: 'every minute'\n---\n");
        writeFileSync(join(dir, "mail", "b.md"), "---\ncron: 'every minute'\n---\n");
        const out = await scanWorkspace(dir, {
            frontmatter: { cron: "*" },
            pathGlob: "workflows/*",
        });
        const paths = out.map((f) => f.relativePath);
        assert.deepEqual(paths, ["workflows/a.md"]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
