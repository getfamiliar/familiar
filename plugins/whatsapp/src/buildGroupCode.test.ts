import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { buildGroupCode } from "./WhatsAppDaemon.js";

describe("buildGroupCode", () => {
    it("returns null when given null (no group name available)", () => {
        assert.equal(buildGroupCode(null), null);
    });

    it("returns null when the name slugs to empty (all special chars)", () => {
        assert.equal(buildGroupCode("🎉🎉🎉"), null);
        assert.equal(buildGroupCode("---"), null);
        assert.equal(buildGroupCode("   "), null);
    });

    it("converts spaces to underscores", () => {
        assert.equal(buildGroupCode("MyEO German Real Estate"), "MyEO_German_Real_Estate");
    });

    it("strips characters outside [A-Za-z0-9]", () => {
        // Umlauts, colon, ampersand, emoji — all dropped.
        assert.equal(buildGroupCode("MyEO Optimale Vitalität: 💊💪🍏🧬"), "MyEO_Optimale_Vitalitt");
        assert.equal(buildGroupCode("MyEO German Needs & Leads"), "MyEO_German_Needs_Leads");
    });

    it("collapses runs of underscores", () => {
        assert.equal(buildGroupCode("a   b"), "a_b");
        assert.equal(buildGroupCode("a !!! b"), "a_b");
    });

    it("trims both leading and trailing underscores", () => {
        assert.equal(buildGroupCode("  hello  "), "hello");
        assert.equal(buildGroupCode("💊 Group "), "Group");
        assert.equal(buildGroupCode("___wrapped___"), "wrapped");
    });

    it("preserves digits and case", () => {
        assert.equal(buildGroupCode("Q1 2026 Roadmap"), "Q1_2026_Roadmap");
    });
});
