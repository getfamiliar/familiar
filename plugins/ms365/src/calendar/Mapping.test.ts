import assert from "node:assert";
import { describe, it } from "node:test";
import type { CalendarEventRow, CreateEventInput, NewCalendarEvent } from "@getfamiliar/shared";
import type { GraphCalendar, GraphCalendarEvent } from "../graph/GraphClient.js";
import {
    buildCreateBody,
    calendarTypeOf,
    eventFromGraph,
    MS365_PROVIDER_ID,
    mergeWithMaster,
    ownerNameOf,
} from "./Mapping.js";

describe("Mapping.eventFromGraph", () => {
    it("prefixes the event id with the provider id", () => {
        const row = eventFromGraph(sampleGraphEvent({ id: "AAAA" }), {
            calendarId: "42",
            scanGeneration: 7,
        });
        assert.equal(row.id, `${MS365_PROVIDER_ID}:AAAA`);
        assert.equal(row.calendarId, "42");
        assert.equal(row.scanGeneration, 7);
    });

    it("marks all-day events as such", () => {
        const row = eventFromGraph(sampleGraphEvent({ isAllDay: true }), {
            calendarId: "1",
            scanGeneration: 0,
        });
        assert.equal(row.isAllDay, true);
    });

    it("captures the online-meeting join URL on Teams events", () => {
        const row = eventFromGraph(
            sampleGraphEvent({
                isOnlineMeeting: true,
                onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meet/abc" },
            }),
            { calendarId: "1", scanGeneration: 0 },
        );
        assert.equal(row.isOnlineMeeting, true);
        assert.equal(row.onlineMeetingUrl, "https://teams.microsoft.com/l/meet/abc");
    });

    it("falls back to singleInstance when the type is missing or unknown", () => {
        const row = eventFromGraph(sampleGraphEvent({ type: undefined }), {
            calendarId: "1",
            scanGeneration: 0,
        });
        assert.equal(row.type, "singleInstance");
    });

    it("prefixes the series master id when present", () => {
        const row = eventFromGraph(
            sampleGraphEvent({ type: "occurrence", seriesMasterId: "MASTER" }),
            { calendarId: "1", scanGeneration: 0 },
        );
        assert.equal(row.seriesMasterId, `${MS365_PROVIDER_ID}:MASTER`);
    });

    it("normalizes UTC-source dateTimes by appending Z", () => {
        const row = eventFromGraph(
            sampleGraphEvent({
                start: { dateTime: "2026-05-21T10:00:00", timeZone: "UTC" },
                end: { dateTime: "2026-05-21T11:00:00", timeZone: "UTC" },
            }),
            { calendarId: "1", scanGeneration: 0 },
        );
        assert.equal(row.startDt, "2026-05-21T10:00:00Z");
        assert.equal(row.endDt, "2026-05-21T11:00:00Z");
        assert.equal(row.eventTz, "UTC");
    });

    it("converts Europe/Berlin wall-clock to UTC (CEST, +02:00)", () => {
        const row = eventFromGraph(
            sampleGraphEvent({
                start: { dateTime: "2026-05-21T08:00:00", timeZone: "Europe/Berlin" },
                end: { dateTime: "2026-05-21T09:00:00", timeZone: "Europe/Berlin" },
            }),
            { calendarId: "1", scanGeneration: 0 },
        );
        assert.equal(row.startDt, "2026-05-21T06:00:00Z");
        assert.equal(row.endDt, "2026-05-21T07:00:00Z");
        assert.equal(row.eventTz, "Europe/Berlin");
    });

    it("converts America/New_York wall-clock to UTC (EDT, -04:00)", () => {
        const row = eventFromGraph(
            sampleGraphEvent({
                start: { dateTime: "2026-05-21T20:00:00", timeZone: "America/New_York" },
                end: { dateTime: "2026-05-21T22:00:00", timeZone: "America/New_York" },
            }),
            { calendarId: "1", scanGeneration: 0 },
        );
        // NY 20:00 EDT → UTC 00:00 next day; 22:00 EDT → 02:00.
        assert.equal(row.startDt, "2026-05-22T00:00:00Z");
        assert.equal(row.endDt, "2026-05-22T02:00:00Z");
        assert.equal(row.eventTz, "America/New_York");
    });

    it("handles Berlin winter time (CET, +01:00)", () => {
        const row = eventFromGraph(
            sampleGraphEvent({
                start: { dateTime: "2026-01-15T08:00:00", timeZone: "Europe/Berlin" },
                end: { dateTime: "2026-01-15T09:00:00", timeZone: "Europe/Berlin" },
            }),
            { calendarId: "1", scanGeneration: 0 },
        );
        assert.equal(row.startDt, "2026-01-15T07:00:00Z");
        assert.equal(row.endDt, "2026-01-15T08:00:00Z");
    });

    it("falls back to epoch when timeZone is unknown", () => {
        const row = eventFromGraph(
            sampleGraphEvent({
                start: { dateTime: "2026-05-21T08:00:00", timeZone: "Not/A_Zone" },
                end: { dateTime: "2026-05-21T09:00:00", timeZone: "Not/A_Zone" },
            }),
            { calendarId: "1", scanGeneration: 0 },
        );
        assert.equal(row.startDt, "1970-01-01T00:00:00.000Z");
        assert.equal(row.endDt, "1970-01-01T00:00:00.000Z");
    });

    it("passes through already-UTC dateTimes with Z suffix verbatim", () => {
        const row = eventFromGraph(
            sampleGraphEvent({
                start: { dateTime: "2026-05-21T10:00:00Z", timeZone: "Europe/Berlin" },
                end: { dateTime: "2026-05-21T11:00:00Z", timeZone: "Europe/Berlin" },
            }),
            { calendarId: "1", scanGeneration: 0 },
        );
        // Already-Z input is honored verbatim; the row's eventTz still
        // records the authoring zone.
        assert.equal(row.startDt, "2026-05-21T10:00:00Z");
        assert.equal(row.endDt, "2026-05-21T11:00:00Z");
        assert.equal(row.eventTz, "Europe/Berlin");
    });
});

describe("Mapping.buildCreateBody", () => {
    it("maps is_videocall=true onto Teams isOnlineMeeting", () => {
        const body = buildCreateBody(baseInput({ isVideocall: true }), {
            timezone: "Europe/Berlin",
            reminderMinutesBeforeStart: 15,
        });
        assert.equal(body.isOnlineMeeting, true);
        assert.equal(body.onlineMeetingProvider, "teamsForBusiness");
    });

    it("omits onlineMeetingProvider when is_videocall is not set", () => {
        const body = buildCreateBody(baseInput({}), {
            timezone: "Europe/Berlin",
            reminderMinutesBeforeStart: 15,
        });
        assert.equal(body.isOnlineMeeting, false);
        assert.equal(body.onlineMeetingProvider, undefined);
    });

    it("uses the input timezone over the config default when present", () => {
        const body = buildCreateBody(baseInput({ timezone: "America/Los_Angeles" }), {
            timezone: "Europe/Berlin",
            reminderMinutesBeforeStart: 15,
        });
        assert.equal(body.start.timeZone, "America/Los_Angeles");
        assert.equal(body.end.timeZone, "America/Los_Angeles");
    });

    it("falls back to the config reminder when the input omits it", () => {
        const body = buildCreateBody(baseInput({}), {
            timezone: "Europe/Berlin",
            reminderMinutesBeforeStart: 30,
        });
        assert.equal(body.reminderMinutesBeforeStart, 30);
    });

    it("passes attendees through verbatim — stripping happens upstream", () => {
        const body = buildCreateBody(baseInput({ attendees: [{ email: "a@example.com" }] }), {
            timezone: "Europe/Berlin",
            reminderMinutesBeforeStart: 15,
        });
        assert.equal(body.attendees?.length, 1);
        assert.equal(body.attendees?.[0].emailAddress.address, "a@example.com");
    });

    it("renders markdown body to HTML when present", () => {
        const body = buildCreateBody(baseInput({ body: "**bold**" }), {
            timezone: "Europe/Berlin",
            reminderMinutesBeforeStart: 15,
        });
        assert.ok(body.body !== undefined);
        assert.equal(body.body?.contentType, "HTML");
        assert.match(body.body?.content ?? "", /<strong>bold<\/strong>/);
    });
});

describe("Mapping.calendarTypeOf / ownerNameOf", () => {
    it("classifies the user's own calendar as 'own'", () => {
        const cal: GraphCalendar = {
            id: "x",
            name: "Calendar",
            owner: { address: "me@example.com", name: "Me" },
        };
        const type = calendarTypeOf(cal, "me@example.com");
        assert.equal(type, "own");
        assert.equal(ownerNameOf(cal, type), null);
    });

    it("classifies a delegated calendar as 'shared'", () => {
        const cal: GraphCalendar = {
            id: "x",
            name: "Team",
            owner: { address: "team-leader@example.com", name: "Team Leader" },
        };
        const type = calendarTypeOf(cal, "me@example.com");
        assert.equal(type, "shared");
        assert.equal(ownerNameOf(cal, type), "Team Leader");
    });
});

describe("Mapping.mergeWithMaster", () => {
    it("fills empty subject / location / body from the master", () => {
        const merged = mergeWithMaster(
            sampleOccurrence({ subject: "", location: null, body: "" }),
            sampleMaster({ subject: "Weekly sync", location: "Room 12", body: "agenda…" }),
        );
        assert.equal(merged.subject, "Weekly sync");
        assert.equal(merged.location, "Room 12");
        assert.equal(merged.body, "agenda…");
    });

    it("inherits importance / sensitivity / showAs / online-meeting URL", () => {
        const merged = mergeWithMaster(
            sampleOccurrence({
                importance: null,
                sensitivity: null,
                showAs: null,
                isOnlineMeeting: false,
                onlineMeetingUrl: null,
            }),
            sampleMaster({
                importance: "high",
                sensitivity: "private",
                showAs: "tentative",
                isOnlineMeeting: true,
                onlineMeetingUrl: "https://teams.microsoft.com/l/meet/abc",
            }),
        );
        assert.equal(merged.importance, "high");
        assert.equal(merged.sensitivity, "private");
        assert.equal(merged.showAs, "tentative");
        assert.equal(merged.isOnlineMeeting, true);
        assert.equal(merged.onlineMeetingUrl, "https://teams.microsoft.com/l/meet/abc");
    });

    it("never inherits start/end, cancellation, or response status", () => {
        const merged = mergeWithMaster(
            sampleOccurrence({
                startDt: "2026-05-26T08:00:00Z",
                endDt: "2026-05-26T09:00:00Z",
                isCancelled: true,
                responseStatus: "declined",
            }),
            sampleMaster({
                startDt: "2026-01-01T08:00:00Z",
                endDt: "2026-01-01T09:00:00Z",
                isCancelled: false,
                responseStatus: "accepted",
            }),
        );
        assert.equal(merged.startDt, "2026-05-26T08:00:00Z");
        assert.equal(merged.endDt, "2026-05-26T09:00:00Z");
        assert.equal(merged.isCancelled, true);
        assert.equal(merged.responseStatus, "declined");
    });

    it("keeps occurrence content when it has a non-empty subject", () => {
        const merged = mergeWithMaster(
            sampleOccurrence({ subject: "Special agenda" }),
            sampleMaster({ subject: "Weekly sync" }),
        );
        assert.equal(merged.subject, "Special agenda");
    });
});

function sampleOccurrence(overrides: Partial<NewCalendarEvent> = {}): NewCalendarEvent {
    return {
        id: "ms365:occurrence-1",
        calendarId: "1",
        seriesMasterId: "ms365:master-1",
        type: "occurrence",
        subject: null,
        startDt: "2026-05-19T10:00:00Z",
        endDt: "2026-05-19T11:00:00Z",
        scanGeneration: 0,
        ...overrides,
    };
}

function sampleMaster(overrides: Partial<CalendarEventRow> = {}): CalendarEventRow {
    return {
        id: "ms365:master-1",
        calendarId: "1",
        seriesMasterId: null,
        type: "seriesMaster",
        subject: "Master subject",
        startDt: "2026-01-01T10:00:00Z",
        endDt: "2026-01-01T11:00:00Z",
        eventTz: "UTC",
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

function sampleGraphEvent(overrides: Partial<GraphCalendarEvent> = {}): GraphCalendarEvent {
    return {
        id: "AAAA",
        subject: "Test",
        start: { dateTime: "2026-05-19T10:00:00", timeZone: "UTC" },
        end: { dateTime: "2026-05-19T11:00:00", timeZone: "UTC" },
        type: "singleInstance",
        isAllDay: false,
        isCancelled: false,
        isOnlineMeeting: false,
        ...overrides,
    };
}

function baseInput(overrides: Partial<CreateEventInput>): CreateEventInput {
    return {
        subject: "Sample",
        start: "2026-05-19T10:00:00",
        end: "2026-05-19T11:00:00",
        ...overrides,
    };
}
