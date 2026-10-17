import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Logger, NewEvent, WorkspaceFile } from "@getfamiliar/shared";
import type { WorkspaceWatcher } from "../utils/WorkspaceWatcher.js";
import { CronjobScheduler } from "./CronjobScheduler.js";

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
function writeCronHandler(root: string, rel: string, cron = "every monday at 8"): WorkspaceFile {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, `---\ncron: "${cron}"\n---\n# handler\n`);
    return { relativePath: rel, absolutePath: abs };
}

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

test("a firing emits an exact-topic event derived from the file path", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "cron-fire-test-"));
    try {
        const file = writeCronHandler(root, "mail/important/digest.md", "* * * * * *");
        const emitted: NewEvent[] = [];
        const scheduler = new CronjobScheduler({
            watcher: stubWatcher([file]),
            emit: async (event) => {
                emitted.push(event);
                return { id: "1" };
            },
            log: silentLog,
        });
        await scheduler.start();
        await waitFor(() => emitted.length > 0);
        await scheduler.stop();

        assert.equal(emitted[0].topic, "mail:important:digest");
        assert.equal(emitted[0].isExactTopic, true);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a folder-form cron handler shadowed by its x.md twin does not fire", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "cron-shadow-test-"));
    try {
        const shadowed = writeCronHandler(root, "mail/digest/index.md", "* * * * * *");
        writeCronHandler(root, "mail/digest.md", "every monday at 8");
        const emitted: NewEvent[] = [];
        const warnings: string[] = [];
        const scheduler = new CronjobScheduler({
            watcher: stubWatcher([shadowed]),
            emit: async (event) => {
                emitted.push(event);
                return { id: "1" };
            },
            log: {
                ...silentLog,
                warn: (_ctx: unknown, msg: string) => warnings.push(msg),
            } as unknown as Logger,
        });
        await scheduler.start();
        await waitFor(() => warnings.length > 0);
        await scheduler.stop();

        assert.equal(emitted.length, 0);
        assert.match(warnings[0], /mail\/digest\.md also exists/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

/**
 * Poll `condition` until it holds, failing after a few seconds.
 *
 * @param condition Predicate to wait for.
 */
async function waitFor(condition: () => boolean): Promise<void> {
    const deadline = Date.now() + 3000;
    while (!condition()) {
        if (Date.now() > deadline) {
            throw new Error("waitFor: condition not met in time");
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}
