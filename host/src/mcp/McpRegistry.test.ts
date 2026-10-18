import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Logger } from "@getfamiliar/shared";
import { McpRegistry } from "./McpRegistry.js";

const silentLog = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child: () => silentLog,
} as unknown as Logger;

let scratch: string;
let file: string;

beforeEach(() => {
    scratch = mkdtempSync(path.join(tmpdir(), "familiar-mcp-registry-"));
    file = path.join(scratch, "mcp.yml");
});

afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
});

/** Render one external MCP entry. */
function entry(id: string, url: string): string {
    return `${id}:\n  title: ${id}\n  description: ${id} server\n  source: external\n  url: ${url}\n`;
}

describe("McpRegistry.reload", () => {
    it("reports added, removed and changed ids and swaps the entries", () => {
        writeFileSync(
            file,
            entry("keep", "http://a") + entry("change", "http://b") + entry("drop", "http://c"),
        );
        const registry = new McpRegistry(file, silentLog);
        writeFileSync(
            file,
            entry("keep", "http://a") + entry("change", "http://B") + entry("fresh", "http://d"),
        );

        assert.deepEqual(registry.previewReload(), {
            added: ["fresh"],
            removed: ["drop"],
            changed: ["change"],
        });
        assert.ok(registry.get("drop"), "preview does not swap");

        const diff = registry.reload();
        assert.deepEqual(diff, { added: ["fresh"], removed: ["drop"], changed: ["change"] });
        assert.equal(registry.get("drop"), undefined);
        assert.equal(registry.get("change")?.url, "http://B");
    });

    it("throws on a lint error and keeps the current entries", () => {
        writeFileSync(file, entry("keep", "http://a"));
        const registry = new McpRegistry(file, silentLog);
        writeFileSync(file, "Bad_Id:\n  title: x\n");
        assert.throws(() => registry.reload());
        assert.ok(registry.get("keep"));
    });
});
