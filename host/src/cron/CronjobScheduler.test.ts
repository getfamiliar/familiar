import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Logger, WorkspaceFile } from "@getfamiliar/shared";
import type { WorkspaceWatcher } from "../workspace/WorkspaceWatcher.js";
import { CronjobScheduler, pathToHandlerTarget } from "./CronjobScheduler.js";

/** No-op logger satisfying the structured-logging interface used by the scheduler. */
const silentLog = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => silentLog,
} as unknown as Logger;

/**
 * Minimal {@link WorkspaceWatcher} stub: `listMarkdownFiles` returns the
 * given snapshot, `onMarkdownFileUpdate` never fires. Enough to exercise
 * the scheduler's initial-scan `register` path.
 */
function stubWatcher(files: readonly WorkspaceFile[]): WorkspaceWatcher {
    return {
        listMarkdownFiles: async () => files,
        onMarkdownFileUpdate: () => () => {},
    } as unknown as WorkspaceWatcher;
}

/** Write a handler file with a `cron:` frontmatter at a workspace-relative path. */
function writeCronHandler(root: string, rel: string): WorkspaceFile {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, "---\ncron: every monday at 8\n---\n# handler\n");
    return { relativePath: rel, absolutePath: abs };
}

test("pathToHandlerTarget maps nested folders to colon-joined topics", () => {
    assert.deepEqual(pathToHandlerTarget("mail/important/digest.md"), {
        topic: "mail:important",
        startHandler: "digest",
    });
});

test("pathToHandlerTarget handles a single-folder file", () => {
    assert.deepEqual(pathToHandlerTarget("workflows/monday-digest.md"), {
        topic: "workflows",
        startHandler: "monday-digest",
    });
});

test("pathToHandlerTarget rejects workspace-root files", () => {
    assert.equal(pathToHandlerTarget("SOUL.md"), null);
    assert.equal(pathToHandlerTarget("loose.md"), null);
});

test("pathToHandlerTarget strips the .md suffix only", () => {
    const t = pathToHandlerTarget("workflows/has.dot.in.name.md");
    assert.deepEqual(t, { topic: "workflows", startHandler: "has.dot.in.name" });
});

test("start skips cron handlers under writable paths but registers others", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "cron-writable-test-"));
    try {
        const files = [
            writeCronHandler(root, "wiki/index.md"),
            writeCronHandler(root, "mail/digest.md"),
        ];
        const scheduler = new CronjobScheduler({
            watcher: stubWatcher(files),
            emit: async () => ({ id: "1" }),
            log: silentLog,
            writablePathGlobs: ["wiki/**"],
        });
        await scheduler.start();

        const scheduled = scheduler.list().map((r) => r.relativePath);
        assert.deepEqual(scheduled, ["mail/digest.md"]);
        await scheduler.stop();
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
