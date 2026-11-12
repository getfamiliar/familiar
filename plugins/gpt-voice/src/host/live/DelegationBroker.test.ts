import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { buildBackgroundPrompt, splitIntoAppends } from "./DelegationBroker.js";

describe("splitIntoAppends", () => {
    it("keeps short text in one chunk", () => {
        assert.deepEqual(splitIntoAppends("  Morgen um 9 Uhr.  "), ["Morgen um 9 Uhr."]);
    });

    it("splits at sentence and paragraph boundaries within the limit", () => {
        const chunks = splitIntoAppends("Erster Satz. Zweiter Satz!\n\nDritter Absatz?", 30);
        assert.deepEqual(chunks, ["Erster Satz. Zweiter Satz!", "Dritter Absatz?"]);
        for (const chunk of chunks) {
            assert.ok(chunk.length <= 30);
        }
    });

    it("splits an overlong sentence at words and an overlong word hard", () => {
        const chunks = splitIntoAppends(`${"wort ".repeat(10)}${"x".repeat(25)}`, 12);
        assert.ok(chunks.every((chunk) => chunk.length <= 12));
        assert.equal(chunks.join(" ").replace(/\s+/g, ""), `${"wort".repeat(10)}${"x".repeat(25)}`);
    });
});

describe("buildBackgroundPrompt", () => {
    it("lists the conversation without call metadata", () => {
        const prompt = buildBackgroundPrompt([
            { speaker: "user", text: "Was steht morgen an?", startMs: 0 },
        ]);
        assert.doesNotMatch(prompt, /Voice call/);
        assert.match(prompt, /User: Was steht morgen an\?$/);
    });

    it("says when there is no transcript yet", () => {
        assert.match(buildBackgroundPrompt([]), /\(no transcript yet\)$/);
    });
});
