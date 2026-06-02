import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateTokens } from "./estimateTokens.js";

test("estimateTokens returns 0 for the empty string", () => {
    assert.equal(estimateTokens(""), 0);
});

test("estimateTokens rounds up to whole tokens", () => {
    assert.equal(estimateTokens("a"), 1);
    assert.equal(estimateTokens("abcd"), 1);
    assert.equal(estimateTokens("abcde"), 2);
    assert.equal(estimateTokens("abcdefgh"), 2);
});

test("estimateTokens scales ~4 chars per token", () => {
    assert.equal(estimateTokens("x".repeat(400)), 100);
    assert.equal(estimateTokens("x".repeat(401)), 101);
});
