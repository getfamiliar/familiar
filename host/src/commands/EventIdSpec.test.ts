import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { parseEventIdSpec } from "./EventIdSpec.js";

describe("parseEventIdSpec", () => {
    it("parses a single id", () => {
        assert.deepEqual(parseEventIdSpec("4711"), ["4711"]);
    });

    it("expands an inclusive span", () => {
        assert.deepEqual(parseEventIdSpec("123-126"), ["123", "124", "125", "126"]);
    });

    it("accepts a comma-separated mix of ids and spans", () => {
        assert.deepEqual(parseEventIdSpec("123-125, 555, 560-562"), [
            "123",
            "124",
            "125",
            "555",
            "560",
            "561",
            "562",
        ]);
    });

    it("treats a single-element span as one id", () => {
        assert.deepEqual(parseEventIdSpec("7-7"), ["7"]);
    });

    it("deduplicates overlapping ids while preserving first-seen order", () => {
        assert.deepEqual(parseEventIdSpec("5, 3-6, 4"), ["5", "3", "4", "6"]);
    });

    it("ignores extra whitespace", () => {
        assert.deepEqual(parseEventIdSpec("  10 ,  12 - 14 "), ["10", "12", "13", "14"]);
    });

    it("rejects an empty spec", () => {
        assert.throws(() => parseEventIdSpec(""), /Empty id spec/);
        assert.throws(() => parseEventIdSpec("   "), /Empty id spec/);
    });

    it("rejects non-numeric ids", () => {
        assert.throws(() => parseEventIdSpec("abc"), /Invalid event id/);
        assert.throws(() => parseEventIdSpec("12, x"), /Invalid event id/);
        assert.throws(() => parseEventIdSpec("12-abc"), /Invalid event id/);
    });

    it("rejects zero and negative ids", () => {
        assert.throws(() => parseEventIdSpec("0"), /Invalid event id/);
        assert.throws(() => parseEventIdSpec("-3"), /Invalid event id/);
    });

    it("rejects descending spans", () => {
        assert.throws(() => parseEventIdSpec("10-5"), /Invalid span/);
    });
});
