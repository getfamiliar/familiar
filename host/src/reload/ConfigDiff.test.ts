import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { diffConfigLeaves, isConfigKeyOverlapping, isConfigKeyWithin } from "./ConfigDiff.js";

describe("diffConfigLeaves", () => {
    it("reports changed, added and removed leaves; arrays compare as a whole", () => {
        const changed = diffConfigLeaves(
            { mail: { allowSend: false }, core: { writablePaths: ["a"] }, old: { x: 1 } },
            {
                mail: { allowSend: true },
                core: { writablePaths: ["a", "b"] },
                telegram: { botToken: "t" },
            },
        );
        assert.deepEqual(changed, [
            "core.writablePaths",
            "mail.allowSend",
            "old.x",
            "telegram.botToken",
        ]);
    });

    it("reports a leaf that turned into a mapping at the shallower path", () => {
        assert.deepEqual(diffConfigLeaves({ a: 1 }, { a: { b: 1 } }), ["a"]);
    });

    it("returns nothing for equal trees", () => {
        assert.deepEqual(diffConfigLeaves({ a: { b: [1, 2] } }, { a: { b: [1, 2] } }), []);
    });
});

describe("isConfigKeyWithin / isConfigKeyOverlapping", () => {
    it("matches on dotted-path boundaries only", () => {
        assert.equal(isConfigKeyWithin("mail.allowSend", "mail"), true);
        assert.equal(isConfigKeyWithin("mailbox.x", "mail"), false);
        assert.equal(isConfigKeyOverlapping("telegram", "telegram.botToken"), true);
        assert.equal(
            isConfigKeyOverlapping("inference.apiKeys.openai", "inference.apiKeys.openai"),
            true,
        );
        assert.equal(
            isConfigKeyOverlapping("inference.apiKeys.featherless", "inference.apiKeys.openai"),
            false,
        );
    });
});
