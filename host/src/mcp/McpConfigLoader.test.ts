import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { lintMcpConfigFile } from "./McpConfigLoader.js";

let scratch: string;

beforeEach(() => {
    scratch = mkdtempSync(path.join(tmpdir(), "ea-mcp-lint-"));
});

afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
});

function write(content: string): string {
    const filePath = path.join(scratch, "mcp.yml");
    writeFileSync(filePath, content, "utf-8");
    return filePath;
}

describe("McpConfigLoader — absence and emptiness", () => {
    it("treats a missing file as ok (no MCPs declared)", () => {
        const result = lintMcpConfigFile(path.join(scratch, "nope.yml"));
        assert.equal(result.ok, true);
        assert.deepEqual(result.errors, []);
    });

    it("treats an empty file as ok", () => {
        const file = write("");
        const result = lintMcpConfigFile(file);
        assert.equal(result.ok, true);
    });
});

describe("McpConfigLoader — happy path", () => {
    it("accepts a fetch entry with required fields only", () => {
        const file = write(`
fetch:
  title: "Fetch"
  description: "Fetches a URL."
  source: docker-mcp-registry
  image: mcp/fetch
`);
        const result = lintMcpConfigFile(file);
        assert.equal(result.ok, true, `errors: ${JSON.stringify(result.errors)}`);
    });

    it("accepts an external entry with url", () => {
        const file = write(`
remote:
  title: "Remote"
  description: "An HTTP MCP."
  source: external
  url: "https://example.com/mcp"
`);
        const result = lintMcpConfigFile(file);
        assert.equal(result.ok, true, `errors: ${JSON.stringify(result.errors)}`);
    });
});

describe("McpConfigLoader — failure modes", () => {
    it("rejects a docker-mcp-registry entry without `image`", () => {
        const file = write(`
fetch:
  title: "Fetch"
  description: "Fetches a URL."
  source: docker-mcp-registry
`);
        const result = lintMcpConfigFile(file);
        assert.equal(result.ok, false);
        assert.match(result.errors.join("\n"), /missing required field "image"/);
    });

    it("rejects an unknown source", () => {
        const file = write(`
weird:
  title: "Weird"
  description: "A made-up source."
  source: bittorrent
`);
        const result = lintMcpConfigFile(file);
        assert.equal(result.ok, false);
        assert.match(result.errors.join("\n"), /source must be one of/);
    });

    it("rejects an id that doesn't match the regex", () => {
        const file = write(`
"BadName!":
  title: "X"
  description: "Y"
  source: docker-mcp-registry
  image: mcp/x
`);
        const result = lintMcpConfigFile(file);
        assert.equal(result.ok, false);
        assert.match(result.errors.join("\n"), /must match/);
    });

    it("rejects idleTimeoutSeconds that isn't a positive integer", () => {
        const file = write(`
fetch:
  title: "Fetch"
  description: "Fetches a URL."
  source: docker-mcp-registry
  image: mcp/fetch
  idleTimeoutSeconds: -5
`);
        const result = lintMcpConfigFile(file);
        assert.equal(result.ok, false);
        assert.match(result.errors.join("\n"), /idleTimeoutSeconds/);
    });
});
