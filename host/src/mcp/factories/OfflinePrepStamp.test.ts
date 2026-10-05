import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Logger } from "@getfamiliar/shared";
import type { McpEntry } from "../McpEntry.js";
import { mcpMountDirFor } from "../RuntimeImages.js";
import { prepareOfflineMount, prepStampFileFor, readPrepStamp } from "./OfflinePrepStamp.js";

const silentLog = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => silentLog,
} as unknown as Logger;

const IMAGE_A = "sha256:aaaa";
const IMAGE_B = "sha256:bbbb";

/** Minimal offline pypi entry; only the fields the stamp reads matter. */
function pdfEntry(version = "1.10.0"): McpEntry {
    return {
        id: "pdf",
        source: "pypi",
        package: "pdf-mcp",
        version,
        command: null,
        network: { disable: true },
    } as unknown as McpEntry;
}

let tmpDir: string;
let mountDir: string;
let stampFile: string;

beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "familiar-prep-stamp-"));
    mountDir = mcpMountDirFor(tmpDir, "pdf");
    stampFile = prepStampFileFor(tmpDir, "pdf");
});

afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
});

/** Simulate a successful prep: populate the cache and record the stamp. */
function prepWith(entry: McpEntry, imageId: string): void {
    const state = prepareOfflineMount(entry, tmpDir, imageId, silentLog);
    assert.equal(state.isPrepNeeded, true);
    writeFileSync(path.join(mountDir, "cached-package"), "x");
    state.writeStamp();
}

describe("prepareOfflineMount", () => {
    it("creates a missing mount dir and asks for prep, without writing the stamp yet", () => {
        const state = prepareOfflineMount(pdfEntry(), tmpDir, IMAGE_A, silentLog);
        assert.equal(state.isPrepNeeded, true);
        assert.equal(existsSync(mountDir), true);
        assert.equal(existsSync(stampFile), false);
    });

    it("reuses the cache when the stamp matches", () => {
        prepWith(pdfEntry(), IMAGE_A);
        const state = prepareOfflineMount(pdfEntry(), tmpDir, IMAGE_A, silentLog);
        assert.equal(state.isPrepNeeded, false);
        assert.equal(existsSync(path.join(mountDir, "cached-package")), true);
    });

    it("wipes and re-preps after a runtime image rebuild", () => {
        prepWith(pdfEntry(), IMAGE_A);
        const state = prepareOfflineMount(pdfEntry(), tmpDir, IMAGE_B, silentLog);
        assert.equal(state.isPrepNeeded, true);
        assert.equal(existsSync(path.join(mountDir, "cached-package")), false);
        assert.equal(
            existsSync(stampFile),
            false,
            "stale stamp removed until the new prep succeeds",
        );
    });

    it("wipes and re-preps after a version bump", () => {
        prepWith(pdfEntry("1.10.0"), IMAGE_A);
        const state = prepareOfflineMount(pdfEntry("1.11.0"), tmpDir, IMAGE_A, silentLog);
        assert.equal(state.isPrepNeeded, true);
        assert.equal(existsSync(path.join(mountDir, "cached-package")), false);
    });

    it("re-preps a populated cache that predates stamps", () => {
        mkdirSync(mountDir, { recursive: true });
        writeFileSync(path.join(mountDir, "cached-package"), "x");
        const state = prepareOfflineMount(pdfEntry(), tmpDir, IMAGE_A, silentLog);
        assert.equal(state.isPrepNeeded, true);
        assert.equal(existsSync(path.join(mountDir, "cached-package")), false);
    });

    it("keeps the stamp outside the mount dir", () => {
        prepWith(pdfEntry(), IMAGE_A);
        assert.equal(path.dirname(stampFile), tmpDir);
        assert.deepEqual(readPrepStamp(stampFile), {
            package: "pdf-mcp",
            version: "1.10.0",
            command: null,
            runtimeImageId: IMAGE_A,
        });
    });
});
