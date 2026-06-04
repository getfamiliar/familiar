import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { resolveTools } from "./ToolsExpressionParser.js";

const POOL = new Set([
    "fetch_fetch",
    "atlassian_jira_search",
    "atlassian_jira_create_issue",
    "atlassian_jira_get_issue",
    "atlassian_confluence_get_page",
    "send_chat",
    "schedule_handler",
    "fs_read",
    "fs_write",
    "fs_ls",
    "fs_grep",
]);

/**
 * The implicit-default `core` group seen by these tests. `fs_read`
 * appears in both `core` and `fs`, exercising the multi-group
 * membership the `PluginTool.groups` API enables.
 */
const CORE_KEYS = new Set(["send_chat", "schedule_handler", "fs_read"]);

const FS_KEYS = new Set(["fs_read", "fs_write", "fs_ls", "fs_grep"]);

const MCP_KEYS = new Set([
    "fetch_fetch",
    "atlassian_jira_search",
    "atlassian_jira_create_issue",
    "atlassian_jira_get_issue",
    "atlassian_confluence_get_page",
]);

const ATLASSIAN_KEYS = new Set([
    "atlassian_jira_search",
    "atlassian_jira_create_issue",
    "atlassian_jira_get_issue",
    "atlassian_confluence_get_page",
]);

const FETCH_KEYS = new Set(["fetch_fetch"]);

const BUILTINS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
    ["core", CORE_KEYS],
    ["fs", FS_KEYS],
    ["mcp", MCP_KEYS],
    ["atlassian", ATLASSIAN_KEYS],
    ["fetch", FETCH_KEYS],
]);

/** Convenience: resolve entries against the shared fixtures, sorted. */
function resolve(entries: readonly string[]): string[] {
    return [...resolveTools(entries, POOL, BUILTINS)].sort();
}

describe("resolveTools — entry classification", () => {
    it("resolves a group name (lowercase ident, no underscore) via builtins", () => {
        assert.deepEqual(resolve(["core"]), [...CORE_KEYS].sort());
    });

    it("matches an explicit tool name literally", () => {
        assert.deepEqual(resolve(["fetch_fetch"]), ["fetch_fetch"]);
    });

    it("matches a `*`-glob against the pool", () => {
        assert.deepEqual(resolve(["atlassian_jira_*"]), [
            "atlassian_jira_create_issue",
            "atlassian_jira_get_issue",
            "atlassian_jira_search",
        ]);
    });

    it("the bare `*` glob matches every key (equivalent to `all`)", () => {
        assert.deepEqual(resolve(["*"]), [...POOL].sort());
    });
});

describe("resolveTools — built-in groups", () => {
    it("`all` returns the full available pool", () => {
        assert.deepEqual(resolve(["all"]), [...POOL].sort());
    });

    it("`none` contributes nothing", () => {
        assert.deepEqual(resolve(["none"]), []);
    });

    it("`mcp` returns just the MCP-tool keys", () => {
        assert.deepEqual(resolve(["mcp"]), [...MCP_KEYS].sort());
    });

    it("a bare MCP id resolves to that MCP's keys", () => {
        assert.deepEqual(resolve(["atlassian"]), [...ATLASSIAN_KEYS].sort());
    });

    it("`none` alongside a tool reduces to that tool", () => {
        assert.deepEqual(resolve(["none", "fetch_fetch"]), ["fetch_fetch"]);
    });
});

describe("resolveTools — union semantics", () => {
    it("unions multiple entries", () => {
        assert.deepEqual(resolve(["fetch_fetch", "atlassian_jira_search"]), [
            "atlassian_jira_search",
            "fetch_fetch",
        ]);
    });

    it("unions overlapping groups without duplicates", () => {
        const out = new Set(resolve(["core", "fs"]));
        for (const k of [...CORE_KEYS, ...FS_KEYS]) {
            assert.equal(out.has(k), true, `expected ${k} present`);
        }
        assert.equal(out.size, new Set([...CORE_KEYS, ...FS_KEYS]).size);
    });

    it("dedupes a key selected by both a group and a glob", () => {
        assert.deepEqual(resolve(["fetch", "fetch_*"]), ["fetch_fetch"]);
    });

    it("mixes a group, a glob, and an explicit name", () => {
        const out = new Set(resolve(["core", "atlassian_jira_*", "fetch_fetch"]));
        for (const k of CORE_KEYS) {
            assert.equal(out.has(k), true, `expected ${k} present`);
        }
        assert.equal(out.has("atlassian_jira_search"), true);
        assert.equal(out.has("fetch_fetch"), true);
        assert.equal(out.has("atlassian_confluence_get_page"), false);
    });
});

describe("resolveTools — edge cases", () => {
    it("an empty entry list resolves to nothing", () => {
        assert.deepEqual(resolve([]), []);
    });

    it("a glob matching nothing contributes nothing without throwing", () => {
        assert.deepEqual(resolve(["zzz_*"]), []);
    });

    it("an explicit tool name absent from the pool contributes nothing", () => {
        assert.deepEqual(resolve(["nonexistent_tool"]), []);
    });

    it("throws on an unknown group with the missing name", () => {
        assert.throws(() => resolve(["notarealgroup"]), /unknown group: notarealgroup/);
    });
});
