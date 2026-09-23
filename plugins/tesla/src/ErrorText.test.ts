import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeError } from "./ErrorText.js";

describe("describeError", () => {
    it("never returns an empty string for an AggregateError", () => {
        // This is the exact shape Node raises when a connection fails
        // across every resolved address; `message` is "".
        const inner = Object.assign(new Error(""), { code: "ETIMEDOUT" });
        const err = Object.assign(new AggregateError([inner, inner], ""), { code: "ETIMEDOUT" });
        const text = describeError(err);
        assert.ok(text.length > 0);
        assert.match(text, /ETIMEDOUT/);
    });

    it("keeps a plain error's message", () => {
        assert.equal(describeError(new Error("boom")), "boom");
    });

    it("appends a code the message does not already mention", () => {
        const err = Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" });
        assert.equal(describeError(err), "connect failed ECONNREFUSED");
    });

    it("does not repeat a code the message already carries", () => {
        const err = Object.assign(new Error("getaddrinfo EAI_AGAIN auth.tesla.com"), {
            code: "EAI_AGAIN",
        });
        assert.equal(describeError(err), "getaddrinfo EAI_AGAIN auth.tesla.com");
    });

    it("falls back to the error name when there is nothing else", () => {
        assert.equal(describeError(new AggregateError([], "")), "AggregateError");
    });

    it("handles non-Error throws", () => {
        assert.equal(describeError("nope"), "nope");
        assert.equal(describeError(undefined), "undefined");
    });
});
