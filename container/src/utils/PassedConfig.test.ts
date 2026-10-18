import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { applyPassedConfigOverlay, PassedConfig, passedConfigVersion } from "./PassedConfig.js";

describe("PassedConfig overlay", () => {
    it("replaces the env blob entirely and ignores stale versions", () => {
        process.env.FAMILIAR_CONTAINER_CONFIG = JSON.stringify({ a: 1, dropped: true });
        assert.equal(PassedConfig.get<number>("a"), 1);
        assert.equal(passedConfigVersion(), 0);

        assert.equal(applyPassedConfigOverlay(2, { a: 2 }), true);
        assert.equal(PassedConfig.get<number>("a"), 2);
        assert.equal(
            PassedConfig.get<boolean>("dropped"),
            undefined,
            "no fallback to the env blob",
        );
        assert.equal(passedConfigVersion(), 2);

        assert.equal(applyPassedConfigOverlay(2, { a: 3 }), false);
        assert.equal(applyPassedConfigOverlay(1, { a: 4 }), false);
        assert.equal(PassedConfig.get<number>("a"), 2);
    });
});
