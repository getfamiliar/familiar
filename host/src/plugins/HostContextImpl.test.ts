import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { isUsableChannelId } from "./HostContextImpl.js";

describe("isUsableChannelId", () => {
    it("accepts a non-empty string", () => {
        assert.equal(isUsableChannelId("telegram"), true);
        assert.equal(isUsableChannelId(" "), true); // whitespace counts; we don't trim
        assert.equal(isUsableChannelId("cli"), true);
    });

    it("rejects an empty string", () => {
        assert.equal(isUsableChannelId(""), false);
    });

    it("rejects null and undefined", () => {
        assert.equal(isUsableChannelId(null), false);
        assert.equal(isUsableChannelId(undefined), false);
    });

    it("rejects booleans", () => {
        assert.equal(isUsableChannelId(false), false);
        assert.equal(isUsableChannelId(true), false);
    });

    it("rejects numbers (including 0)", () => {
        assert.equal(isUsableChannelId(0), false);
        assert.equal(isUsableChannelId(42), false);
        assert.equal(isUsableChannelId(Number.NaN), false);
    });

    it("rejects objects and arrays", () => {
        assert.equal(isUsableChannelId({}), false);
        assert.equal(isUsableChannelId({ id: "telegram" }), false);
        assert.equal(isUsableChannelId(["telegram"]), false);
    });

    it("acts as a TypeScript type guard", () => {
        const candidate: unknown = "telegram";
        if (isUsableChannelId(candidate)) {
            // Compile-time assertion: inside this branch, `candidate`
            // is narrowed to `string`. The `.toUpperCase()` would not
            // typecheck against `unknown`.
            assert.equal(candidate.toUpperCase(), "TELEGRAM");
        } else {
            assert.fail("string should pass the guard");
        }
    });
});
