import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { inspectPidFile } from "./pidfile.js";

let scratch: string;

beforeEach(() => {
    scratch = mkdtempSync(path.join(tmpdir(), "familiar-pidfile-"));
});

afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
});

const pidPath = (): string => path.join(scratch, ".daemon.pid");

describe("inspectPidFile", () => {
    it("returns vacant when the file is absent", () => {
        assert.deepEqual(inspectPidFile(pidPath()), { kind: "vacant" });
    });

    it("returns alive when the file points at this very process", () => {
        // `process.pid` is guaranteed to be alive — we are it.
        writeFileSync(pidPath(), `${process.pid}\n`, "utf-8");
        assert.deepEqual(inspectPidFile(pidPath()), {
            kind: "alive",
            pid: process.pid,
        });
    });

    it("returns stale when the pid is not running", () => {
        // Pids on Linux fit in 22 bits by default and 999_999_999
        // is well outside any plausible range, so the predicate
        // gets a clean ESRCH from kill(2).
        const deadPid = 999_999_999;
        writeFileSync(pidPath(), `${deadPid}\n`, "utf-8");
        assert.deepEqual(inspectPidFile(pidPath()), {
            kind: "stale",
            pid: deadPid,
        });
    });

    it("returns malformed when the contents aren't a positive integer", () => {
        writeFileSync(pidPath(), `not-a-number\n`, "utf-8");
        assert.deepEqual(inspectPidFile(pidPath()), { kind: "malformed" });
    });

    it("returns malformed for negative or zero pids", () => {
        writeFileSync(pidPath(), `0\n`, "utf-8");
        assert.deepEqual(inspectPidFile(pidPath()), { kind: "malformed" });
        writeFileSync(pidPath(), `-1\n`, "utf-8");
        assert.deepEqual(inspectPidFile(pidPath()), { kind: "malformed" });
    });

    it("trims surrounding whitespace before parsing", () => {
        writeFileSync(pidPath(), `   ${process.pid}   \n`, "utf-8");
        assert.deepEqual(inspectPidFile(pidPath()), {
            kind: "alive",
            pid: process.pid,
        });
    });
});
