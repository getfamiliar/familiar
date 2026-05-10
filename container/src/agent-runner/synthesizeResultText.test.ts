import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
    LENGTH_PREFIX,
    NO_PRECEDING_BODY,
    OTHER_PREFIX,
    STOP_PREFIX,
    type SynthesizeInput,
    synthesizeResultText,
} from "./synthesizeResultText.js";

const TARGETED = ["other", "length", "stop"] as const;

const PREFIX_FOR: Record<(typeof TARGETED)[number], string> = {
    other: OTHER_PREFIX,
    length: LENGTH_PREFIX,
    stop: STOP_PREFIX,
};

function input(over: Partial<SynthesizeInput>): SynthesizeInput {
    return { text: "", finishReason: "stop", steps: [], ...over };
}

describe("synthesizeResultText — passthrough", () => {
    it("non-empty result.text returns verbatim for `other`, `stop`, and non-targeted reasons", () => {
        for (const fr of ["other", "stop", "tool-calls", "content-filter"]) {
            const out = synthesizeResultText(
                input({ text: "hello world", finishReason: fr, steps: [{ text: "ignored" }] }),
            );
            assert.equal(out, "hello world");
        }
    });

    it("empty text + non-targeted finishReason returns empty (no synthesis)", () => {
        for (const fr of ["tool-calls", "content-filter", "error", "unknown"]) {
            const out = synthesizeResultText(
                input({ finishReason: fr, steps: [{ text: "previous" }] }),
            );
            assert.equal(out, "");
        }
    });
});

describe("synthesizeResultText — length always prefixes", () => {
    it("length + non-empty result.text → prefix + result.text (truncation context)", () => {
        const out = synthesizeResultText(
            input({
                text: "partial reply that got cut",
                finishReason: "length",
                steps: [{ text: "earlier step" }],
            }),
        );
        assert.equal(out, `${LENGTH_PREFIX}\n\npartial reply that got cut`);
    });

    it("length + empty result.text → prefix + last step body (walk-back)", () => {
        const out = synthesizeResultText(
            input({
                finishReason: "length",
                steps: [{ text: "fallback from step" }],
            }),
        );
        assert.equal(out, `${LENGTH_PREFIX}\n\nfallback from step`);
    });
});

describe("synthesizeResultText — synthesis on targeted finishReasons", () => {
    for (const fr of TARGETED) {
        it(`${fr}: last step has text → matching prefix + step text`, () => {
            const out = synthesizeResultText(
                input({
                    finishReason: fr,
                    steps: [{ text: "earlier step" }, { text: "last step utterance" }],
                }),
            );
            assert.equal(out, `${PREFIX_FOR[fr]}\n\nlast step utterance`);
        });

        it(`${fr}: last step has only reasoningText → prefix + reasoning`, () => {
            const out = synthesizeResultText(
                input({
                    finishReason: fr,
                    steps: [{ text: "earlier" }, { reasoningText: "thinking out loud" }],
                }),
            );
            assert.equal(out, `${PREFIX_FOR[fr]}\n\nthinking out loud`);
        });

        it(`${fr}: walks back to earlier step when last steps are empty`, () => {
            const out = synthesizeResultText(
                input({
                    finishReason: fr,
                    steps: [
                        { text: "real reply" },
                        { text: "" },
                        { reasoningText: "" },
                        { text: undefined, reasoningText: undefined },
                    ],
                }),
            );
            assert.equal(out, `${PREFIX_FOR[fr]}\n\nreal reply`);
        });

        it(`${fr}: text is preferred over reasoning on the same step`, () => {
            const out = synthesizeResultText(
                input({
                    finishReason: fr,
                    steps: [{ text: "spoken", reasoningText: "thought" }],
                }),
            );
            assert.equal(out, `${PREFIX_FOR[fr]}\n\nspoken`);
        });

        it(`${fr}: no step has text or reasoning → prefix + fallback body`, () => {
            const out = synthesizeResultText(
                input({
                    finishReason: fr,
                    steps: [{ text: "" }, { reasoningText: "" }],
                }),
            );
            assert.equal(out, `${PREFIX_FOR[fr]}\n\n${NO_PRECEDING_BODY}`);
        });

        it(`${fr}: empty steps array → prefix + fallback body`, () => {
            const out = synthesizeResultText(input({ finishReason: fr, steps: [] }));
            assert.equal(out, `${PREFIX_FOR[fr]}\n\n${NO_PRECEDING_BODY}`);
        });
    }
});

describe("synthesizeResultText — prefix constants", () => {
    it("each prefix appears verbatim in its synthesized output", () => {
        // Catches a typo in any of the three constants without
        // duplicating the long strings inside this test file.
        for (const fr of TARGETED) {
            const out = synthesizeResultText(input({ finishReason: fr, steps: [{ text: "x" }] }));
            assert.ok(
                out.startsWith(PREFIX_FOR[fr]),
                `expected output for ${fr} to start with its prefix`,
            );
        }
    });
});
