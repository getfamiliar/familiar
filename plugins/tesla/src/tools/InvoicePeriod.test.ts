import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isWithinPeriod, resolvePeriod } from "./InvoicePeriod.js";

const ZONE = "Europe/Berlin";

describe("resolvePeriod", () => {
    it("defaults to the last full month", () => {
        const period = resolvePeriod({}, new Date("2026-09-23T10:00:00Z"), ZONE);
        assert.deepEqual(period, { fromDay: "2026-08-01", toDay: "2026-08-31" });
    });

    it("rolls back across the year boundary", () => {
        const period = resolvePeriod({}, new Date("2026-01-15T10:00:00Z"), ZONE);
        assert.deepEqual(period, { fromDay: "2025-12-01", toDay: "2025-12-31" });
    });

    it("gets February's length right in a leap year", () => {
        const period = resolvePeriod({}, new Date("2024-03-10T10:00:00Z"), ZONE);
        assert.deepEqual(period, { fromDay: "2024-02-01", toDay: "2024-02-29" });
    });

    it("uses the zone's month, not UTC's, at a month boundary", () => {
        // 23:30 UTC on Aug 31 is already 01:30 on Sep 1 in Berlin, so
        // the last full month is August there and July in UTC.
        const period = resolvePeriod({}, new Date("2026-08-31T23:30:00Z"), ZONE);
        assert.deepEqual(period, { fromDay: "2026-08-01", toDay: "2026-08-31" });
    });

    it("leaves the missing bound open-ended", () => {
        const from = resolvePeriod({ from_day: "2026-05-01" }, new Date(), ZONE);
        assert.equal(from.fromDay, "2026-05-01");
        assert.equal(from.toDay, "9999-12-31");

        const to = resolvePeriod({ to_day: "2026-05-31" }, new Date(), ZONE);
        assert.equal(to.fromDay, "0000-01-01");
        assert.equal(to.toDay, "2026-05-31");
    });

    it("rejects a malformed day", () => {
        assert.throws(() => resolvePeriod({ from_day: "01.05.2026" }, new Date(), ZONE), {
            message: /from_day must be a YYYY-MM-DD date/,
        });
    });

    it("rejects an inverted range", () => {
        assert.throws(
            () => resolvePeriod({ from_day: "2026-06-01", to_day: "2026-05-01" }, new Date(), ZONE),
            { message: /is after to_day/ },
        );
    });
});

describe("isWithinPeriod", () => {
    const august = { fromDay: "2026-08-01", toDay: "2026-08-31" };

    it("includes both bounds", () => {
        assert.equal(isWithinPeriod("2026-08-01T10:00:00Z", august, ZONE), true);
        assert.equal(isWithinPeriod("2026-08-31T10:00:00Z", august, ZONE), true);
    });

    it("excludes the days outside", () => {
        assert.equal(isWithinPeriod("2026-07-31T10:00:00Z", august, ZONE), false);
        assert.equal(isWithinPeriod("2026-09-01T10:00:00Z", august, ZONE), false);
    });

    it("compares the local day, not the UTC one", () => {
        // 22:30 UTC on Jul 31 is 00:30 on Aug 1 in Berlin — the user's
        // August, so it belongs to the August period.
        assert.equal(isWithinPeriod("2026-07-31T22:30:00Z", august, ZONE), true);
        // And the mirror case at the far end.
        assert.equal(isWithinPeriod("2026-08-31T22:30:00Z", august, ZONE), false);
    });
});
