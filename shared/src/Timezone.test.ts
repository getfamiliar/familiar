import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dayBoundsInZone, parseInZone, renderInZone } from "./Timezone.js";

describe("renderInZone", () => {
    it("renders UTC instant as wall-clock with offset in the target zone (summer)", () => {
        assert.equal(
            renderInZone("2026-05-21T06:00:00Z", "Europe/Berlin"),
            "2026-05-21T08:00:00+02:00",
        );
    });

    it("renders UTC instant in winter offset (Europe/Berlin)", () => {
        assert.equal(
            renderInZone("2026-01-15T07:00:00Z", "Europe/Berlin"),
            "2026-01-15T08:00:00+01:00",
        );
    });

    it("falls back to the input string on a malformed UTC value", () => {
        assert.equal(renderInZone("not-an-iso-date", "Europe/Berlin"), "not-an-iso-date");
    });

    it("falls back to the input string on an unknown zone", () => {
        const out = renderInZone("2026-05-21T06:00:00Z", "Not/A_Zone");
        assert.equal(out, "2026-05-21T06:00:00Z");
    });
});

describe("parseInZone", () => {
    it("interprets a naive ISO as wall-clock in the supplied zone", () => {
        const out = parseInZone("2026-05-22T13:55:00", "Europe/Berlin");
        assert.deepEqual(out, { ok: true, utcIso: "2026-05-22T11:55:00Z" });
    });

    it("honors an explicit offset in the input and ignores the zone arg", () => {
        const out = parseInZone("2026-05-22T13:55:00+05:00", "Europe/Berlin");
        assert.deepEqual(out, { ok: true, utcIso: "2026-05-22T08:55:00Z" });
    });

    it("returns an error for an empty input", () => {
        const out = parseInZone("", "Europe/Berlin");
        assert.equal(out.ok, false);
    });

    it("returns an error for a malformed ISO string", () => {
        const out = parseInZone("garbage", "Europe/Berlin");
        assert.equal(out.ok, false);
    });

    it("round-trips through renderInZone for naive local input", () => {
        const parsed = parseInZone("2026-05-22T13:55:00", "Europe/Berlin");
        assert.equal(parsed.ok, true);
        if (parsed.ok) {
            assert.equal(renderInZone(parsed.utcIso, "Europe/Berlin"), "2026-05-22T13:55:00+02:00");
        }
    });
});

describe("dayBoundsInZone", () => {
    it("returns the UTC bounds of a local day (summer offset)", () => {
        const out = dayBoundsInZone("2026-05-22", "Europe/Berlin");
        assert.deepEqual(out, {
            ok: true,
            fromUtc: "2026-05-21T22:00:00Z",
            toUtc: "2026-05-22T22:00:00Z",
        });
    });

    it("returns an error for a malformed day", () => {
        const out = dayBoundsInZone("not-a-day", "Europe/Berlin");
        assert.equal(out.ok, false);
    });
});
