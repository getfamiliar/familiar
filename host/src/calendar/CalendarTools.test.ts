import assert from "node:assert";
import { describe, it } from "node:test";
import { resolveDayBounds } from "./CalendarTools.js";

describe("resolveDayBounds", () => {
    it("turns `day` into the local-tz [00:00, next 00:00) window in UTC (Berlin, CEST)", () => {
        // 2026-05-21 00:00 Europe/Berlin (CEST, +02:00) → 2026-05-20T22:00Z
        // 2026-05-22 00:00 Europe/Berlin                → 2026-05-21T22:00Z
        const { from, to } = resolveDayBounds({ day: "2026-05-21" }, "Europe/Berlin");
        assert.equal(from, "2026-05-20T22:00:00Z");
        assert.equal(to, "2026-05-21T22:00:00Z");
    });

    it("turns `day` into the local-tz window in UTC (Berlin, CET in January)", () => {
        // 2026-01-15 00:00 Europe/Berlin (CET, +01:00) → 2026-01-14T23:00Z
        const { from, to } = resolveDayBounds({ day: "2026-01-15" }, "Europe/Berlin");
        assert.equal(from, "2026-01-14T23:00:00Z");
        assert.equal(to, "2026-01-15T23:00:00Z");
    });

    it("returns Z-suffixed UTC bounds when coreTz is UTC", () => {
        const { from, to } = resolveDayBounds({ day: "2026-05-21" }, "UTC");
        // luxon emits the +00:00 form for UTC; both are valid.
        assert.match(from, /^2026-05-21T00:00:00(Z|\+00:00)$/);
        assert.match(to, /^2026-05-22T00:00:00(Z|\+00:00)$/);
    });

    it("from_day/to_day range is inclusive on the upper day", () => {
        // Mon-Wed under UTC: from = Mon 00:00 UTC, to = Thu 00:00 UTC.
        const { from, to } = resolveDayBounds(
            { from_day: "2026-05-18", to_day: "2026-05-20" },
            "UTC",
        );
        assert.match(from, /^2026-05-18T00:00:00(Z|\+00:00)$/);
        assert.match(to, /^2026-05-21T00:00:00(Z|\+00:00)$/);
    });

    it("rejects mixing `day` with `from_day`/`to_day`", () => {
        assert.throws(
            () => resolveDayBounds({ day: "2026-05-21", from_day: "2026-05-21" }, "UTC"),
            /not both/,
        );
    });

    it("rejects an unpaired from_day or to_day", () => {
        assert.throws(
            () => resolveDayBounds({ from_day: "2026-05-21" }, "UTC"),
            /must be set together/,
        );
        assert.throws(
            () => resolveDayBounds({ to_day: "2026-05-21" }, "UTC"),
            /must be set together/,
        );
    });

    it("rejects an empty input", () => {
        assert.throws(() => resolveDayBounds({}, "UTC"), /provide `day`/);
    });

    it("rejects an invalid YYYY-MM-DD", () => {
        assert.throws(() => resolveDayBounds({ day: "not-a-date" }, "UTC"), /invalid day/);
    });

    it("rejects from_day after to_day", () => {
        assert.throws(
            () => resolveDayBounds({ from_day: "2026-05-22", to_day: "2026-05-21" }, "UTC"),
            /must not be after/,
        );
    });
});

describe("resolveDayBounds — cross-zone day-boundary regression", () => {
    // The bug: an event in America/New_York at 20:00 local on
    // 2026-05-21 happens at 00:00 UTC on 2026-05-22, which is 02:00 on
    // 2026-05-22 in Berlin. A Berlin agent asking for "2026-05-22"
    // must find this event. The fix is that `day` is interpreted in
    // coreTz before being converted to UTC bounds, so we query the
    // right UTC window.
    it("Berlin agent asking for 2026-05-22 covers a NY 20:00 May 21 event", () => {
        const { from, to } = resolveDayBounds({ day: "2026-05-22" }, "Europe/Berlin");
        const eventStartUtc = "2026-05-22T00:00:00Z"; // 20:00 NY EDT
        const eventEndUtc = "2026-05-22T02:00:00Z"; // 22:00 NY EDT

        // The findEvents predicate is `end_dt >= from AND start_dt < to`
        // — so the event must straddle [from, to).
        assert.ok(eventEndUtc >= from, `event end ${eventEndUtc} must be >= from ${from}`);
        assert.ok(eventStartUtc < to, `event start ${eventStartUtc} must be < to ${to}`);
    });
});
