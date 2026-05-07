import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { evaluate, type GroupDef, parseExpression, parseGroupLine } from "./ToolFilter.js";

const POOL = new Set([
    "fetch_fetch",
    "atlassian_jira_search",
    "atlassian_jira_create_issue",
    "atlassian_jira_get_issue",
    "atlassian_confluence_get_page",
    "atlassian-personal_confluence_search",
    "atlassian-personal_confluence_get_page",
]);

const NO_GROUPS: ReadonlyMap<string, GroupDef> = new Map();

/** Convenience: parse + evaluate, return sorted matched keys. */
function resolve(expression: string, groups: ReadonlyMap<string, GroupDef> = NO_GROUPS): string[] {
    return [...evaluate(parseExpression(expression), POOL, groups)].sort();
}

describe("ToolFilter — bareword classification", () => {
    it("classifies a lowercase ident without underscore as a group", () => {
        const groups: ReadonlyMap<string, GroupDef> = new Map([
            ["reads", [{ kind: "tool", pattern: "fetch_fetch" }]],
        ]);
        assert.deepEqual(resolve("reads", groups), ["fetch_fetch"]);
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

    it("`all` is the built-in group", () => {
        assert.deepEqual(resolve("all"), [...POOL].sort());
    });
});

describe("ToolFilter — operators", () => {
    it("|| unions matches", () => {
        assert.deepEqual(resolve("fetch_fetch || atlassian_jira_search"), [
            "atlassian_jira_search",
            "fetch_fetch",
        ]);
    });

    it("&& intersects matches", () => {
        assert.deepEqual(resolve("atlassian_* && *_search"), ["atlassian_jira_search"]);
    });

    it("! complements against the available pool", () => {
        const out = new Set(resolve("all && !fetch_fetch"));
        assert.equal(out.has("fetch_fetch"), false);
        assert.equal(out.has("atlassian_jira_search"), true);
        assert.equal(out.size, POOL.size - 1);
    });

    it("id-prefix glob excludes other id literally (atlassian_* vs atlassian-personal_*)", () => {
        // `atlassian_*` matches keys starting with "atlassian_" — NOT
        // "atlassian-personal_". This is the literal-id property.
        const out = new Set(resolve("atlassian_*"));
        assert.equal(out.has("atlassian_jira_search"), true);
        assert.equal(out.has("atlassian-personal_confluence_search"), false);
    });

    it("precedence: ! > && > ||", () => {
        // `a || b && !c` parses as `a || (b && (!c))`
        // With a=fetch_fetch, b=atlassian_jira_search, c=fetch_fetch:
        // → fetch_fetch || (atlassian_jira_search && !fetch_fetch)
        // → fetch_fetch || atlassian_jira_search
        assert.deepEqual(resolve("fetch_fetch || atlassian_jira_search && !fetch_fetch"), [
            "atlassian_jira_search",
            "fetch_fetch",
        ]);
    });

    it("parens override precedence", () => {
        // `(fetch_fetch || atlassian_jira_search) && !fetch_fetch`
        // → atlassian_jira_search alone
        assert.deepEqual(resolve("(fetch_fetch || atlassian_jira_search) && !fetch_fetch"), [
            "atlassian_jira_search",
        ]);
    });
});

describe("ToolFilter — group resolution", () => {
    it("resolves nested group references", () => {
        const groups: ReadonlyMap<string, GroupDef> = new Map([
            ["jira-reads", [{ kind: "tool", pattern: "atlassian_jira_get_*" }]],
            [
                "reads",
                [
                    { kind: "group", name: "jira-reads" },
                    { kind: "tool", pattern: "fetch_fetch" },
                ],
            ],
        ]);
        assert.deepEqual(resolve("reads", groups), ["atlassian_jira_get_issue", "fetch_fetch"]);
    });

    it("throws on unknown group with the missing name", () => {
        assert.throws(() => resolve("not-a-real-group"), /unknown group: not-a-real-group/);
    });

    it("throws on cycle with the full chain in the message", () => {
        const groups: ReadonlyMap<string, GroupDef> = new Map([
            ["a", [{ kind: "group", name: "b" }]],
            ["b", [{ kind: "group", name: "a" }]],
        ]);
        assert.throws(() => resolve("a", groups), /cycle in group references: a -> b -> a/);
    });

    it("a tool pattern matching nothing returns empty (warn-not-throw)", () => {
        // Whereas an unknown group throws (above), a tool literal that
        // happens to match no key just contributes nothing.
        assert.deepEqual(resolve("nonexistent_tool"), []);
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
        assert.deepEqual(parseGroupLine("reads"), {
            kind: "group",
            name: "reads",
        });
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
        assert.throws(() => parseGroupLine("a && b"), /matching/);
    });
});

describe("ToolFilter — syntax errors", () => {
    it("rejects unbalanced parens", () => {
        assert.throws(() => parseExpression("(fetch_fetch"), /expected "\)"/);
    });

    it("rejects empty expression", () => {
        assert.throws(() => parseExpression(""), /expected/);
    });

    it("rejects a bare operator", () => {
        assert.throws(() => parseExpression("&&"), /expected group \/ tool/);
    });

    it("requires `&&` not `&`", () => {
        assert.throws(() => parseExpression("a & b"), /expected "&&"/);
    });
});
