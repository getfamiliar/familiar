import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
    evaluate,
    type GroupDef,
    type GroupLookup,
    parseExpression,
    parseGroupLine,
} from "./ToolFilter.js";

const POOL = new Set([
    "fetch_fetch",
    "atlassian_jira_search",
    "atlassian_jira_create_issue",
    "atlassian_jira_get_issue",
    "atlassian_confluence_get_page",
    "send_chat",
    "schedule_handler",
    "file_read",
    "file_write",
    "fs_ls",
    "fs_grep",
]);

const SYSTEM_KEYS = new Set([
    "send_chat",
    "schedule_handler",
    "file_read",
    "file_write",
    "fs_ls",
    "fs_grep",
]);

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
    ["system", SYSTEM_KEYS],
    ["mcp", MCP_KEYS],
    ["atlassian", ATLASSIAN_KEYS],
    ["fetch", FETCH_KEYS],
]);

const NO_LOOKUP: GroupLookup = () => undefined;

/** Wrap a Map as a GroupLookup, the shape tests use most. */
function lookupFromMap(map: ReadonlyMap<string, GroupDef>): GroupLookup {
    return (name) => map.get(name);
}

/** Convenience: parse + evaluate, return sorted matched keys. */
function resolve(
    expression: string,
    lookup: GroupLookup = NO_LOOKUP,
    builtins: ReadonlyMap<string, ReadonlySet<string>> = BUILTINS,
): string[] {
    return [...evaluate(parseExpression(expression), POOL, lookup, builtins)].sort();
}

describe("ToolFilter — bareword classification", () => {
    it("classifies a lowercase ident without underscore as a group", () => {
        const lookup = lookupFromMap(
            new Map([["reads", [{ kind: "tool", pattern: "fetch_fetch" }]]]),
        );
        assert.deepEqual(resolve("reads", lookup), ["fetch_fetch"]);
    });

    it("classifies a token with underscore as a tool pattern (literal match)", () => {
        assert.deepEqual(resolve("fetch_fetch"), ["fetch_fetch"]);
    });

    it("classifies a token with `*` as a tool glob", () => {
        assert.deepEqual(resolve("atlassian_jira_*"), [
            "atlassian_jira_create_issue",
            "atlassian_jira_get_issue",
            "atlassian_jira_search",
        ]);
    });

    it("the bare `*` matches every key (equivalent to `all`)", () => {
        assert.deepEqual(resolve("*"), [...POOL].sort());
    });
});

describe("ToolFilter — built-in groups", () => {
    it("`all` returns the full available pool", () => {
        assert.deepEqual(resolve("all"), [...POOL].sort());
    });

    it("`none` returns an empty set", () => {
        assert.deepEqual(resolve("none"), []);
    });

    it("`system` returns just the system-tool keys", () => {
        assert.deepEqual(resolve("system"), [...SYSTEM_KEYS].sort());
    });

    it("`mcp` returns just the MCP-tool keys", () => {
        assert.deepEqual(resolve("mcp"), [...MCP_KEYS].sort());
    });

    it("`system - send_chat` — system minus one tool", () => {
        const out = new Set(resolve("system - send_chat"));
        assert.equal(out.has("send_chat"), false);
        assert.equal(out.has("file_read"), true);
        assert.equal(out.size, SYSTEM_KEYS.size - 1);
    });

    it("`mcp - atlassian_*` removes every atlassian-prefixed key", () => {
        const out = new Set(resolve("mcp - atlassian_*"));
        assert.equal(out.has("atlassian_jira_search"), false);
        assert.equal(out.has("atlassian_confluence_get_page"), false);
        assert.equal(out.has("fetch_fetch"), true);
    });

    it("`none & all` short-circuits to empty", () => {
        assert.deepEqual(resolve("none & all"), []);
    });

    it("`none + fetch_fetch` reduces to the single tool", () => {
        assert.deepEqual(resolve("none + fetch_fetch"), ["fetch_fetch"]);
    });
});

describe("ToolFilter — MCP-id default groups", () => {
    it("a bare MCP id resolves to that MCP's keys", () => {
        assert.deepEqual(resolve("atlassian"), [...ATLASSIAN_KEYS].sort());
    });

    it("`fetch` resolves to its single tool key", () => {
        assert.deepEqual(resolve("fetch"), [...FETCH_KEYS].sort());
    });

    it("`fetch + atlassian` unions two MCP-id groups", () => {
        assert.deepEqual(resolve("fetch + atlassian"), [...FETCH_KEYS, ...ATLASSIAN_KEYS].sort());
    });

    it("`all - atlassian - fetch` excludes both MCPs in one chain", () => {
        const out = new Set(resolve("all - atlassian - fetch"));
        for (const k of ATLASSIAN_KEYS) {
            assert.equal(out.has(k), false, `expected ${k} excluded`);
        }
        assert.equal(out.has("fetch_fetch"), false);
        // System keys survive.
        assert.equal(out.has("send_chat"), true);
    });
});

describe("ToolFilter — operators", () => {
    it("+ unions matches", () => {
        assert.deepEqual(resolve("fetch_fetch + atlassian_jira_search"), [
            "atlassian_jira_search",
            "fetch_fetch",
        ]);
    });

    it("& intersects matches", () => {
        assert.deepEqual(resolve("atlassian_* & *_search"), ["atlassian_jira_search"]);
    });

    it("- removes the right side from the left", () => {
        const out = new Set(resolve("all - fetch_fetch"));
        assert.equal(out.has("fetch_fetch"), false);
        assert.equal(out.has("atlassian_jira_search"), true);
        assert.equal(out.size, POOL.size - 1);
    });

    it("id-prefix glob matches every key with that id prefix", () => {
        const out = new Set(resolve("atlassian_*"));
        assert.equal(out.has("atlassian_jira_search"), true);
        assert.equal(out.has("atlassian_confluence_get_page"), true);
        assert.equal(out.has("fetch_fetch"), false);
    });

    it("`,` unions matches the same way `+` does", () => {
        assert.deepEqual(resolve("fetch_fetch, atlassian_jira_search"), [
            "atlassian_jira_search",
            "fetch_fetch",
        ]);
    });

    it("`,` and `+` are interchangeable within one expression", () => {
        const commaForm = resolve("fetch_fetch, atlassian_jira_search + atlassian_jira_get_issue");
        const plusForm = resolve("fetch_fetch + atlassian_jira_search + atlassian_jira_get_issue");
        assert.deepEqual(commaForm, plusForm);
    });

    it("`,` shares precedence with `+` against `&`: a, b & c == a + (b & c)", () => {
        assert.deepEqual(resolve("fetch_fetch, atlassian_jira_search & *_search"), [
            "atlassian_jira_search",
            "fetch_fetch",
        ]);
    });

    it("whitespace around `,` is optional", () => {
        const tight = resolve("fetch_fetch,atlassian_jira_search");
        const loose = resolve("fetch_fetch , atlassian_jira_search");
        assert.deepEqual(tight, ["atlassian_jira_search", "fetch_fetch"]);
        assert.deepEqual(loose, ["atlassian_jira_search", "fetch_fetch"]);
    });
});

describe("ToolFilter — precedence", () => {
    it("`&` binds tighter than `+`: a + b & c == a + (b & c)", () => {
        // fetch_fetch + atlassian_jira_search & *_search
        //   == fetch_fetch + (atlassian_jira_search & *_search)
        //   == {fetch_fetch, atlassian_jira_search}
        assert.deepEqual(resolve("fetch_fetch + atlassian_jira_search & *_search"), [
            "atlassian_jira_search",
            "fetch_fetch",
        ]);
    });

    it("`&` binds tighter than `-`: a - b & c == a - (b & c)", () => {
        // all - atlassian_* & *_search
        //   == all - (atlassian_* & *_search)
        //   == all minus just `atlassian_jira_search`
        const out = new Set(resolve("all - atlassian_* & *_search"));
        assert.equal(out.has("atlassian_jira_search"), false);
        assert.equal(out.has("atlassian_jira_get_issue"), true);
        assert.equal(out.has("atlassian_jira_create_issue"), true);
        assert.equal(out.size, POOL.size - 1);
    });

    it("`+` and `-` share precedence, left-to-right: a + b - c == (a + b) - c", () => {
        // (fetch_fetch + atlassian_jira_search) - fetch_fetch
        //   == {atlassian_jira_search}
        assert.deepEqual(resolve("fetch_fetch + atlassian_jira_search - fetch_fetch"), [
            "atlassian_jira_search",
        ]);
    });

    it("chained `-` is left-associative: all - x - y == (all - x) - y", () => {
        const out = new Set(resolve("all - fetch_fetch - atlassian_jira_search"));
        assert.equal(out.has("fetch_fetch"), false);
        assert.equal(out.has("atlassian_jira_search"), false);
        assert.equal(out.size, POOL.size - 2);
    });

    it("mixed - then +: all - x + y reads as (all - x) + y, so y survives", () => {
        // The case most likely to surprise readers: removing a key
        // and then adding it back via + still includes it.
        const out = new Set(resolve("all - fetch_fetch + fetch_fetch"));
        assert.equal(out.has("fetch_fetch"), true);
        assert.equal(out.size, POOL.size);
    });

    it("parens override precedence", () => {
        assert.deepEqual(resolve("(fetch_fetch + atlassian_jira_search) - fetch_fetch"), [
            "atlassian_jira_search",
        ]);
    });
});

describe("ToolFilter — group resolution and lazy lookup", () => {
    it("resolves nested group references", () => {
        const lookup = lookupFromMap(
            new Map([
                ["jira_reads", [{ kind: "tool", pattern: "atlassian_jira_get_*" }]],
                [
                    "reads",
                    [
                        { kind: "group", name: "jira_reads" },
                        { kind: "tool", pattern: "fetch_fetch" },
                    ],
                ],
            ]),
        );
        assert.deepEqual(resolve("reads", lookup), ["atlassian_jira_get_issue", "fetch_fetch"]);
    });

    it("throws on unknown group with the missing name", () => {
        assert.throws(() => resolve("notarealgroup"), /unknown group: notarealgroup/);
    });

    it("throws on cycle with the full chain in the message", () => {
        const lookup = lookupFromMap(
            new Map([
                ["a", [{ kind: "group", name: "b" }]],
                ["b", [{ kind: "group", name: "a" }]],
            ]),
        );
        assert.throws(() => resolve("a", lookup), /cycle in group references: a -> b -> a/);
    });

    it("a tool pattern matching nothing returns empty (warn-not-throw)", () => {
        assert.deepEqual(resolve("nonexistent_tool"), []);
    });

    it("lazy lookup: a malformed group is only fatal when referenced", () => {
        let badAccessed = false;
        const lookup: GroupLookup = (name) => {
            if (name === "bad") {
                badAccessed = true;
                throw new Error("toolgroups/bad.txt:1: parse error");
            }
            if (name === "reads") {
                return [{ kind: "tool", pattern: "fetch_fetch" }];
            }
            return undefined;
        };

        assert.deepEqual(resolve("reads", lookup), ["fetch_fetch"]);
        assert.equal(badAccessed, false, "bad group must not be touched when not referenced");

        assert.throws(() => resolve("bad", lookup), /toolgroups\/bad\.txt:1: parse error/);
        assert.equal(badAccessed, true);
    });
});

describe("ToolFilter — parseGroupLine", () => {
    it("returns null for blank lines and comments", () => {
        assert.equal(parseGroupLine(""), null);
        assert.equal(parseGroupLine("   "), null);
        assert.equal(parseGroupLine("# just a comment"), null);
        assert.equal(parseGroupLine("   # leading whitespace ok"), null);
    });

    it("classifies a bareword the same way as expressions do", () => {
        assert.deepEqual(parseGroupLine("reads"), { kind: "group", name: "reads" });
        assert.deepEqual(parseGroupLine("fetch_fetch"), {
            kind: "tool",
            pattern: "fetch_fetch",
        });
        assert.deepEqual(parseGroupLine("atlassian_jira_*"), {
            kind: "tool",
            pattern: "atlassian_jira_*",
        });
    });

    it("strips trailing inline comments", () => {
        assert.deepEqual(parseGroupLine("fetch_fetch  # all-purpose URL grab"), {
            kind: "tool",
            pattern: "fetch_fetch",
        });
    });

    it("rejects a line with operator characters", () => {
        assert.throws(() => parseGroupLine("a + b"), /matching/);
        assert.throws(() => parseGroupLine("a - b"), /matching/);
        assert.throws(() => parseGroupLine("a & b"), /matching/);
    });

    it("rejects a hyphenated bareword (underscores only)", () => {
        assert.throws(() => parseGroupLine("read-operations"), /matching/);
    });
});

describe("ToolFilter — syntax errors", () => {
    it("rejects unbalanced parens", () => {
        assert.throws(() => parseExpression("(fetch_fetch"), /expected "\)"/);
    });

    it("rejects empty expression", () => {
        assert.throws(() => parseExpression(""), /expected/);
    });

    it("rejects a leading binary operator", () => {
        assert.throws(() => parseExpression("+ b"), /expected group \/ tool/);
        assert.throws(() => parseExpression("& b"), /expected group \/ tool/);
        assert.throws(() => parseExpression("- b"), /expected group \/ tool/);
    });

    it("rejects a dangling trailing operator", () => {
        assert.throws(() => parseExpression("a +"), /expected group \/ tool/);
        assert.throws(() => parseExpression("a -"), /expected group \/ tool/);
        assert.throws(() => parseExpression("a &"), /expected group \/ tool/);
    });

    it("rejects the old `&&` / `||` / `!` operators", () => {
        // `&&` lexes as two `&` tokens → second one has no left operand.
        assert.throws(() => parseExpression("a && b"));
        // `||` lexes as two `+`-less `|` characters (unknown char).
        assert.throws(() => parseExpression("a || b"), /unexpected character/);
        // `!` is not a recognized character.
        assert.throws(() => parseExpression("!a"), /unexpected character/);
    });

    it("rejects a hyphenated bareword (`-` is always the operator)", () => {
        // `read-operations` lexes as bareword `read`, op `-`, bareword
        // `operations`. Without surrounding context it parses as a
        // diff of two unknown groups — the first `read` lookup fails.
        assert.throws(() => resolve("read-operations"), /unknown group: read/);
    });
});
