import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { buildCalendarEventId, parseCalendarEventId } from "./Calendar.js";

describe("buildCalendarEventId", () => {
    it("joins pluginId and realId with a single colon", () => {
        assert.equal(buildCalendarEventId("ms365", "abc"), "ms365:abc");
    });

    it("passes a realId that itself contains colons through verbatim", () => {
        assert.equal(buildCalendarEventId("ms365", "AAA:BBB"), "ms365:AAA:BBB");
    });

    it("throws on an empty pluginId", () => {
        assert.throws(() => buildCalendarEventId("", "abc"), /pluginId must be non-empty/);
    });

    it("throws when pluginId contains a colon", () => {
        assert.throws(() => buildCalendarEventId("ms:365", "abc"), /":"-free/);
    });

    it("throws on an empty realId", () => {
        assert.throws(() => buildCalendarEventId("ms365", ""), /realId must be non-empty/);
    });
});

describe("parseCalendarEventId", () => {
    it("splits on the first colon", () => {
        assert.deepEqual(parseCalendarEventId("ms365:abc"), { pluginId: "ms365", realId: "abc" });
    });

    it("treats the realId tail as opaque even when it contains colons", () => {
        assert.deepEqual(parseCalendarEventId("ms365:AAA:BBB"), {
            pluginId: "ms365",
            realId: "AAA:BBB",
        });
    });

    it("throws when no colon is present", () => {
        assert.throws(() => parseCalendarEventId("ms365abc"), /malformed/);
    });

    it("throws when the realId segment is empty", () => {
        assert.throws(() => parseCalendarEventId("ms365:"), /empty real-id segment/);
    });

    it("throws when the pluginId segment is empty", () => {
        assert.throws(() => parseCalendarEventId(":abc"), /malformed/);
    });

    it("round-trips through buildCalendarEventId", () => {
        const id = buildCalendarEventId("ms365", "AAMkAGI=");
        assert.deepEqual(parseCalendarEventId(id), { pluginId: "ms365", realId: "AAMkAGI=" });
    });
});
