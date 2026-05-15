import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { DEFAULT_IDLE_TIMEOUT_SECONDS, type McpEntry, type McpSource } from "../McpEntry.js";
import { buildDockerRegistryArgs } from "./DockerMcpRegistryFactory.js";
import { buildNpmDockerArgs } from "./NpmFactory.js";
import { buildPypiDockerArgs } from "./PypiFactory.js";

/**
 * Minimal `McpEntry` factory for tests. Caller fills in
 * source-specific fields (`image`, `package`, …) plus any args
 * they want to assert against.
 */
function entryFixture(overrides: Partial<McpEntry>): McpEntry {
    return {
        id: "ms365",
        title: "t",
        description: "d",
        source: (overrides.source ?? "npm") as McpSource,
        env: [],
        volumes: [],
        args: [],
        command: null,
        network: { disable: false },
        idleTimeoutSeconds: DEFAULT_IDLE_TIMEOUT_SECONDS,
        ...overrides,
    };
}

const runtime = {
    tmpDir: "/tmp/ea-test",
    scratchDir: "/tmp/ea-test-scratch",
    hostUid: 1000,
    hostGid: 1000,
} as const;

describe("buildNpmDockerArgs — appendArgs tails entry.args, never replaces", () => {
    it("bastion path (no options) uses entry.args verbatim", () => {
        const entry = entryFixture({
            source: "npm",
            package: "@softeria/ms-365-mcp-server",
            args: ["--org-mode", "--read-only"],
        });
        const argv = buildNpmDockerArgs(entry, runtime);
        // Args land after the package spec; assert the tail matches.
        const tail = argv.slice(argv.indexOf("@softeria/ms-365-mcp-server") + 1);
        assert.deepEqual(tail, ["--org-mode", "--read-only"]);
    });

    it("mcp call path concatenates appendArgs AFTER entry.args", () => {
        const entry = entryFixture({
            source: "npm",
            package: "@softeria/ms-365-mcp-server",
            args: ["--org-mode", "--read-only"],
        });
        const argv = buildNpmDockerArgs(entry, runtime, {
            interactive: true,
            containerName: null,
            appendArgs: ["--login"],
        });
        const tail = argv.slice(argv.indexOf("@softeria/ms-365-mcp-server") + 1);
        assert.deepEqual(tail, ["--org-mode", "--read-only", "--login"]);
    });

    it("appendArgs with empty entry.args produces just the appended tail", () => {
        const entry = entryFixture({
            source: "npm",
            package: "pkg",
            args: [],
        });
        const argv = buildNpmDockerArgs(entry, runtime, { appendArgs: ["--version"] });
        const tail = argv.slice(argv.indexOf("pkg") + 1);
        assert.deepEqual(tail, ["--version"]);
    });
});

describe("buildPypiDockerArgs — appendArgs tails entry.args", () => {
    it("concatenates entry.args + appendArgs after the package spec", () => {
        const entry = entryFixture({
            source: "pypi",
            package: "mcp-server-foo",
            args: ["--bar"],
        });
        const argv = buildPypiDockerArgs(entry, runtime, { appendArgs: ["--baz"] });
        const tail = argv.slice(argv.indexOf("mcp-server-foo") + 1);
        assert.deepEqual(tail, ["--bar", "--baz"]);
    });
});

describe("buildDockerRegistryArgs — appendArgs tails entry.args", () => {
    it("concatenates entry.args + appendArgs after the image", () => {
        const entry = entryFixture({
            source: "docker-mcp-registry",
            image: "mcp/fetch",
            args: ["--verbose"],
        });
        const argv = buildDockerRegistryArgs(entry, runtime, { appendArgs: ["--debug"] });
        const tail = argv.slice(argv.indexOf("mcp/fetch") + 1);
        assert.deepEqual(tail, ["--verbose", "--debug"]);
    });
});
