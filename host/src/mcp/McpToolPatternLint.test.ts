import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { findUnmatchedToolPatterns } from "./McpToolPatternLint.js";

const TOTEM_TOOLS = [
    "whoop_profile_get",
    "whoop_profile_update",
    "whoop_hidden_metric",
    "whoop_endpoints",
];

const NO_GATING = { allowlist: [], denylist: [], approval: [], privileged: [] };

describe("findUnmatchedToolPatterns", () => {
    it("returns nothing when every pattern matches a tool", () => {
        const entry = {
            ...NO_GATING,
            allowlist: ["whoop_*"],
            denylist: ["whoop_hidden_*", "whoop_endpoints"],
        };
        assert.deepEqual(findUnmatchedToolPatterns(entry, TOTEM_TOOLS), []);
    });

    it("reports a pattern missing the server's name prefix, with a suggestion", () => {
        const entry = { ...NO_GATING, denylist: ["profile_update", "hidden_*"] };
        assert.deepEqual(findUnmatchedToolPatterns(entry, TOTEM_TOOLS), [
            {
                field: "denylist",
                pattern: "profile_update",
                suggestions: ["whoop_profile_update"],
            },
            { field: "denylist", pattern: "hidden_*", suggestions: ["whoop_hidden_metric"] },
        ]);
    });

    it("reports a typo with no suggestion", () => {
        const entry = { ...NO_GATING, approval: ["whoop_profil_update"] };
        assert.deepEqual(findUnmatchedToolPatterns(entry, TOTEM_TOOLS), [
            { field: "approval", pattern: "whoop_profil_update", suggestions: [] },
        ]);
    });

    it("checks all four gating fields in field order", () => {
        const entry = {
            allowlist: ["a"],
            denylist: ["b"],
            approval: ["c"],
            privileged: ["d"],
        };
        const fields = findUnmatchedToolPatterns(entry, TOTEM_TOOLS).map((u) => u.field);
        assert.deepEqual(fields, ["allowlist", "denylist", "approval", "privileged"]);
    });
});
