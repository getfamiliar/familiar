import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { Logger } from "@getfamiliar/shared";
import { ScratchGc } from "./ScratchGc.js";

/** No-op logger satisfying the structured-logging interface used by the GC. */
const silentLog = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => silentLog,
} as unknown as Logger;

/** Two days ago — comfortably past the 24 h retention window. */
const STALE = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

describe("ScratchGc.sweep", () => {
    let scratchDir: string;

    before(async () => {
        scratchDir = mkdtempSync(path.join(tmpdir(), "familiar-scratch-gc-"));
        mkdirSync(path.join(scratchDir, "old-event"));
        mkdirSync(path.join(scratchDir, "fresh-event"));
        writeFileSync(path.join(scratchDir, "old-loose.md"), "x", "utf8");
        writeFileSync(path.join(scratchDir, "fresh-loose.md"), "x", "utf8");
        utimesSync(path.join(scratchDir, "old-event"), STALE, STALE);
        utimesSync(path.join(scratchDir, "old-loose.md"), STALE, STALE);

        await new ScratchGc({ scratchDir, log: silentLog }).sweep();
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
