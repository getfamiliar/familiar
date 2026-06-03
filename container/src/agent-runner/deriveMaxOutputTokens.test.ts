import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
    ABSOLUTE_DEFAULT_OUTPUT_TOKENS,
    DEFAULT_OUTPUT_FALLBACK_FRACTION,
    deriveMaxOutputTokens,
    resolveModelCeiling,
} from "./deriveMaxOutputTokens.js";

describe("resolveModelCeiling", () => {
    it("uses a declared outputLimit verbatim", () => {
        assert.equal(resolveModelCeiling({ outputLimit: 8192, contextLimit: 200000 }), 8192);
    });

    it("uses the default fraction of a large context window when outputLimit is absent", () => {
        assert.equal(resolveModelCeiling({ contextLimit: 200000 }), 140000);
    });

    it("scales down with a small context window (no backstop, but proportional)", () => {
        assert.equal(resolveModelCeiling({ contextLimit: 8000 }), 5600);
    });

    it("honours an explicit fraction argument", () => {
        assert.equal(resolveModelCeiling({ contextLimit: 10000 }, 0.5), 5000);
    });

    it("rounds the fractional result", () => {
        assert.equal(resolveModelCeiling({ contextLimit: 4097 }, 0.7), Math.round(4097 * 0.7));
    });

    it("clamps a fraction above 1 down to 1 (full context window)", () => {
        // 70 (a 0.70 typo) must not yield 70× the context window.
        assert.equal(resolveModelCeiling({ contextLimit: 10000 }, 70), 10000);
    });

    it("falls back to the default fraction for a non-positive value", () => {
        assert.equal(resolveModelCeiling({ contextLimit: 10000 }, 0), 7000);
        assert.equal(resolveModelCeiling({ contextLimit: 10000 }, -0.5), 7000);
    });

    it("falls back to the absolute default when no metadata is available", () => {
        assert.equal(resolveModelCeiling(undefined), ABSOLUTE_DEFAULT_OUTPUT_TOKENS);
    });

    it("falls back to the absolute default when metadata carries neither limit", () => {
        assert.equal(resolveModelCeiling({ toolCall: true }), ABSOLUTE_DEFAULT_OUTPUT_TOKENS);
    });

    it("exposes a 0.7 default fraction", () => {
        assert.equal(DEFAULT_OUTPUT_FALLBACK_FRACTION, 0.7);
    });
});

describe("deriveMaxOutputTokens", () => {
    it("inherits the model ceiling when the handler declares nothing", () => {
        assert.equal(deriveMaxOutputTokens({ outputLimit: 8192 }, undefined), 8192);
    });

    it("keeps an explicit handler value below the ceiling", () => {
        assert.equal(deriveMaxOutputTokens({ outputLimit: 8192 }, 2000), 2000);
    });

    it("clamps an explicit handler value down to the ceiling", () => {
        assert.equal(deriveMaxOutputTokens({ outputLimit: 8192 }, 20000), 8192);
    });

    it("clamps against the context-derived ceiling when outputLimit is absent", () => {
        // round(8000 * 0.7) = 5600
        assert.equal(deriveMaxOutputTokens({ contextLimit: 8000 }, 50000), 5600);
    });

    it("threads an explicit fraction through to the ceiling", () => {
        assert.equal(deriveMaxOutputTokens({ contextLimit: 10000 }, undefined, 0.5), 5000);
    });
});
