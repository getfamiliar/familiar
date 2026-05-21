import assert from "node:assert";
import { describe, it } from "node:test";
import type { CalendarEventRow } from "@getfamiliar/shared";
import { renderEventForAgent, renderInZone } from "./EventRenderer.js";

describe("renderInZone", () => {
    it("renders UTC source in Europe/Berlin with +02:00 offset in May (CEST)", () => {
        assert.equal(
            renderInZone("2026-05-21T06:00:00Z", "Europe/Berlin"),
            "2026-05-21T08:00:00+02:00",
        );
    });

    it("renders UTC source in Europe/Berlin with +01:00 offset in January (CET)", () => {
        assert.equal(
            renderInZone("2026-01-15T07:00:00Z", "Europe/Berlin"),
            "2026-01-15T08:00:00+01:00",
        );
    });

    it("renders UTC source in America/New_York with -04:00 offset in May (EDT)", () => {
        assert.equal(
            renderInZone("2026-05-22T00:00:00Z", "America/New_York"),
            "2026-05-21T20:00:00-04:00",
        );
    });

    it("renders UTC source in UTC verbatim (Z suffix)", () => {
        const rendered = renderInZone("2026-05-21T06:00:00Z", "UTC");
        // luxon emits +00:00 for UTC, not Z — both are valid ISO and
        // semantically equivalent; the agent never has to parse the
        // suffix, just the wall-clock prefix.
        assert.match(rendered, /^2026-05-21T06:00:00(Z|\+00:00)$/);
    });

    it("falls back to the input string when UTC ISO is malformed", () => {
        assert.equal(renderInZone("not-an-iso-date", "Europe/Berlin"), "not-an-iso-date");
    });

    it("falls back to the input string when zone is unknown", () => {
        const out = renderInZone("2026-05-21T06:00:00Z", "Not/A_Zone");
        assert.equal(out, "2026-05-21T06:00:00Z");
    });

    it("survives DST spring-forward (Berlin loses an hour at 02:00 → 03:00 on 2026-03-29)", () => {
        // Pre-DST: 00:00 UTC on 2026-03-29 == 01:00 Berlin (CET, +01:00).
        assert.equal(
            renderInZone("2026-03-29T00:00:00Z", "Europe/Berlin"),
            "2026-03-29T01:00:00+01:00",
        );
        // Post-DST: 02:00 UTC on 2026-03-29 == 04:00 Berlin (CEST, +02:00).
        assert.equal(
            renderInZone("2026-03-29T02:00:00Z", "Europe/Berlin"),
            "2026-03-29T04:00:00+02:00",
        );
    });
});

describe("renderEventForAgent", () => {
    it("replaces startDt/endDt with local-TZ wall-clock strings", () => {
        const view = renderEventForAgent(sampleRow(), "Europe/Berlin");
        assert.equal(view.start, "2026-05-21T08:00:00+02:00");
        assert.equal(view.end, "2026-05-21T09:00:00+02:00");
    });

    it("preserves eventTz unchanged for cross-zone reasoning", () => {
        const view = renderEventForAgent(
            sampleRow({ eventTz: "America/New_York" }),
            "Europe/Berlin",
        );
        assert.equal(view.eventTz, "America/New_York");
    });

    it("passes through all other fields verbatim", () => {
        const view = renderEventForAgent(sampleRow({ subject: "Lunch", location: "Cafe" }), "UTC");
        assert.equal(view.id, "ms365:abc");
        assert.equal(view.calendarId, "1");
        assert.equal(view.subject, "Lunch");
        assert.equal(view.location, "Cafe");
        assert.equal(view.isAllDay, false);
        assert.equal(view.scanGeneration, 0);
    });
});

function sampleRow(overrides: Partial<CalendarEventRow> = {}): CalendarEventRow {
    return {
        id: "ms365:abc",
        calendarId: "1",
        seriesMasterId: null,
        type: "singleInstance",
        subject: "Sample",
        startDt: "2026-05-21T06:00:00Z",
        endDt: "2026-05-21T07:00:00Z",
        eventTz: "Europe/Berlin",
        isAllDay: false,
        isCancelled: false,
        showAs: null,
        sensitivity: null,
        importance: null,
        location: null,
        isOnlineMeeting: false,
        onlineMeetingUrl: null,
        organizerName: null,
        organizerEmail: null,
        responseStatus: null,
        attendees: null,
        body: null,
        attachments: null,
        scanGeneration: 0,
        createdAt: new Date(0),
        updatedAt: new Date(0),
        ...overrides,
    };
}
