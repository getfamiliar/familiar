import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { Logger } from "@getfamiliar/shared";
import { DirectoryGc } from "./DirectoryGc.js";

/** No-op logger satisfying the structured-logging interface used by the GC. */
const silentLog = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => silentLog,
} as unknown as Logger;

const DAY_MS = 24 * 60 * 60 * 1000;

/** `days` days before now. */
function daysAgo(days: number): Date {
    return new Date(Date.now() - days * DAY_MS);
}

describe("DirectoryGc.sweep (24 h scratch window)", () => {
    let scratchDir: string;

    before(async () => {
        scratchDir = mkdtempSync(path.join(tmpdir(), "familiar-scratch-gc-"));
        mkdirSync(path.join(scratchDir, "old-event"));
        mkdirSync(path.join(scratchDir, "fresh-event"));
        writeFileSync(path.join(scratchDir, "old-loose.md"), "x", "utf8");
        writeFileSync(path.join(scratchDir, "fresh-loose.md"), "x", "utf8");
        utimesSync(path.join(scratchDir, "old-event"), daysAgo(2), daysAgo(2));
        utimesSync(path.join(scratchDir, "old-loose.md"), daysAgo(2), daysAgo(2));

        await new DirectoryGc({
            dir: scratchDir,
            retentionMs: DAY_MS,
            name: "scratch",
            log: silentLog,
        }).sweep();
    });

    after(() => {
        rmSync(scratchDir, { recursive: true, force: true });
    });

    it("removes stale event dirs and stale loose files", () => {
        assert.equal(existsSync(path.join(scratchDir, "old-event")), false);
        assert.equal(existsSync(path.join(scratchDir, "old-loose.md")), false);
    });

    it("keeps fresh event dirs and fresh loose files", () => {
        assert.equal(existsSync(path.join(scratchDir, "fresh-event")), true);
        assert.equal(existsSync(path.join(scratchDir, "fresh-loose.md")), true);
    });
});

describe("DirectoryGc.sweep (configured 10-day window)", () => {
    let debugDir: string;

    before(async () => {
        debugDir = mkdtempSync(path.join(tmpdir(), "familiar-llm-debug-gc-"));
        writeFileSync(path.join(debugDir, "old.req.log"), "x", "utf8");
        writeFileSync(path.join(debugDir, "recent.req.log"), "x", "utf8");
        utimesSync(path.join(debugDir, "old.req.log"), daysAgo(11), daysAgo(11));
        utimesSync(path.join(debugDir, "recent.req.log"), daysAgo(9), daysAgo(9));

        await new DirectoryGc({
            dir: debugDir,
            retentionMs: 10 * DAY_MS,
            name: "llm-debug",
            log: silentLog,
        }).sweep();
    });

    after(() => {
        rmSync(debugDir, { recursive: true, force: true });
    });

    it("removes captures older than the window", () => {
        assert.equal(existsSync(path.join(debugDir, "old.req.log")), false);
    });

    it("keeps captures inside the window", () => {
        assert.equal(existsSync(path.join(debugDir, "recent.req.log")), true);
    });
});

describe("DirectoryGc.sweep (missing directory)", () => {
    it("is a no-op when the directory does not exist", async () => {
        const missing = path.join(tmpdir(), `familiar-missing-${process.pid}-${Date.now()}`);
        await new DirectoryGc({
            dir: missing,
            retentionMs: DAY_MS,
            name: "llm-debug",
            log: silentLog,
        }).sweep();
        assert.equal(existsSync(missing), false);
    });
});
