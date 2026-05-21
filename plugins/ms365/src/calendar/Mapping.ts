import {
    buildCalendarEventId,
    type CalendarAttachmentMeta,
    type CalendarAttendee,
    type CalendarEventRow,
    type CalendarEventType,
    type CalendarImportance,
    type CalendarResponseStatus,
    type CalendarSensitivity,
    type CalendarShowAs,
    type CreateEventInput,
    type NewCalendarEvent,
    renderMarkdownToHtml,
    type UpdateEventInput,
} from "@getfamiliar/shared";
import { DateTime } from "luxon";
import type {
    GraphCalendar,
    GraphCalendarEvent,
    GraphCalendarEventCreate,
} from "../graph/GraphClient.js";

/** Provider id used as a prefix on event ids and as the registry key. */
export const MS365_PROVIDER_ID = "ms365";

/**
 * Turn a Graph calendar event into the core's persisted shape. The
 * `calendarId` (numeric primary key of the local `calendars` row),
 * `scanGeneration`, and `seriesMasterId` prefix-handling are stamped
 * by the caller; everything else is derived from the Graph projection.
 */
export function eventFromGraph(
    graph: GraphCalendarEvent,
    opts: {
        readonly calendarId: string;
        readonly scanGeneration: number;
    },
): NewCalendarEvent {
    const start = graph.start;
    const end = graph.end;
    const startIso = isoFromGraph(start);
    const endIso = isoFromGraph(end);
    const tz = start?.timeZone ?? graph.originalStartTimeZone ?? null;
    const location = graph.location?.displayName ?? null;
    const organizerEmail = graph.organizer?.emailAddress?.address ?? null;
    const organizerName = graph.organizer?.emailAddress?.name ?? null;
    return {
        id: buildCalendarEventId(MS365_PROVIDER_ID, graph.id),
        calendarId: opts.calendarId,
        seriesMasterId:
            typeof graph.seriesMasterId === "string" && graph.seriesMasterId.length > 0
                ? buildCalendarEventId(MS365_PROVIDER_ID, graph.seriesMasterId)
                : null,
        type: normaliseType(graph.type),
        subject: typeof graph.subject === "string" ? graph.subject : null,
        startDt: startIso,
        endDt: endIso,
        eventTz: tz,
        isAllDay: graph.isAllDay === true,
        isCancelled: graph.isCancelled === true,
        showAs: normaliseShowAs(graph.showAs),
        sensitivity: normaliseSensitivity(graph.sensitivity),
        importance: normaliseImportance(graph.importance),
        location,
        isOnlineMeeting: graph.isOnlineMeeting === true,
        onlineMeetingUrl:
            typeof graph.onlineMeeting?.joinUrl === "string" ? graph.onlineMeeting.joinUrl : null,
        organizerName,
        organizerEmail,
        responseStatus: normaliseResponse(graph.responseStatus?.response),
        attendees: graph.attendees ? graph.attendees.map(attendeeFromGraph) : null,
        body: typeof graph.body?.content === "string" ? graph.body.content : null,
        attachments: null, // metadata is fetched on demand via getEventAttachments
        scanGeneration: opts.scanGeneration,
    };
}

/**
 * Translate a {@link CreateEventInput} into the Graph create-event
 * body. Carries through `is_videocall` as `isOnlineMeeting +
 * onlineMeetingProvider: 'teamsForBusiness'` so the Graph response
 * contains a Teams join URL the agent can share.
 *
 * Attendees may have been stripped upstream when
 * `ms365.calendar.allowAttendees=false`; this function never strips
 * — it just translates whatever the caller passed.
 */
export function buildCreateBody(
    input: CreateEventInput,
    opts: {
        readonly timezone: string;
        readonly reminderMinutesBeforeStart: number;
    },
): GraphCalendarEventCreate {
    const body: GraphCalendarEventCreate = {
        subject: input.subject,
        start: { dateTime: input.start, timeZone: input.timezone ?? opts.timezone },
        end: { dateTime: input.end, timeZone: input.timezone ?? opts.timezone },
        body: input.body
            ? { contentType: "HTML", content: renderMarkdownToHtml(input.body) }
            : undefined,
        location: input.location ? { displayName: input.location } : undefined,
        attendees: input.attendees?.length
            ? input.attendees.map((a) => ({
                  type: "required" as const,
                  emailAddress: a.name ? { address: a.email, name: a.name } : { address: a.email },
              }))
            : undefined,
        showAs: input.showAs ?? "busy",
        sensitivity: input.sensitivity,
        reminderMinutesBeforeStart:
            typeof input.reminderMinutesBeforeStart === "number"
                ? input.reminderMinutesBeforeStart
                : opts.reminderMinutesBeforeStart,
        isReminderOn: true,
        isOnlineMeeting: input.isVideocall === true,
        onlineMeetingProvider: input.isVideocall === true ? "teamsForBusiness" : undefined,
    };
    return body;
}

/**
 * Translate an {@link UpdateEventInput} patch into the Graph
 * `PATCH /me/events/{id}` body. Only fields present on the input are
 * emitted, so unspecified Graph properties stay as they were. Empty
 * `attendees` arrays land as `[]` (explicit "clear all") rather than
 * being omitted; absent `attendees` keeps Graph's current list.
 *
 * The `timezone` field is used both as the Graph zone for `start` and
 * `end` slots and as the patch's `originalStartTimeZone` — Graph
 * occasionally renders the latter independently.
 */
export function buildPatchBody(
    patch: UpdateEventInput,
    opts: { readonly timezone: string },
): Partial<GraphCalendarEventCreate> {
    const tz = patch.timezone ?? opts.timezone;
    return {
        ...(patch.subject !== undefined && { subject: patch.subject }),
        ...(patch.start !== undefined && {
            start: { dateTime: patch.start, timeZone: tz },
        }),
        ...(patch.end !== undefined && {
            end: { dateTime: patch.end, timeZone: tz },
        }),
        ...(patch.body !== undefined && {
            body: { contentType: "HTML" as const, content: renderMarkdownToHtml(patch.body) },
        }),
        ...(patch.location !== undefined && {
            location: { displayName: patch.location },
        }),
        ...(patch.attendees !== undefined && {
            attendees: patch.attendees.map((a) => ({
                type: "required" as const,
                emailAddress: a.name ? { address: a.email, name: a.name } : { address: a.email },
            })),
        }),
        ...(patch.showAs !== undefined && { showAs: patch.showAs }),
        ...(patch.sensitivity !== undefined && { sensitivity: patch.sensitivity }),
        ...(patch.reminderMinutesBeforeStart !== undefined && {
            reminderMinutesBeforeStart: patch.reminderMinutesBeforeStart,
            isReminderOn: true,
        }),
    };
}

/**
 * Reconstruct the row shape `cal_create_event` returns to the agent.
 * The provider receives the Graph response and lifts it into the same
 * `CalendarEventRow` shape the cache would have stored after a poll,
 * minus `createdAt` / `updatedAt` (filled by the DB).
 */
export function eventRowFromGraph(
    graph: GraphCalendarEvent,
    opts: {
        readonly calendarId: string;
        readonly scanGeneration: number;
    },
): CalendarEventRow {
    const stub = eventFromGraph(graph, opts);
    const now = new Date();
    return {
        ...stub,
        seriesMasterId: stub.seriesMasterId ?? null,
        eventTz: stub.eventTz ?? null,
        isAllDay: stub.isAllDay === true,
        isCancelled: stub.isCancelled === true,
        showAs: stub.showAs ?? null,
        sensitivity: stub.sensitivity ?? null,
        importance: stub.importance ?? null,
        location: stub.location ?? null,
        isOnlineMeeting: stub.isOnlineMeeting === true,
        onlineMeetingUrl: stub.onlineMeetingUrl ?? null,
        organizerName: stub.organizerName ?? null,
        organizerEmail: stub.organizerEmail ?? null,
        responseStatus: stub.responseStatus ?? null,
        attendees: stub.attendees ?? null,
        body: stub.body ?? null,
        attachments: stub.attachments ?? null,
        createdAt: now,
        updatedAt: now,
    };
}

/**
 * Decide whether a calendar from `/me/calendars` is `own` or `shared`.
 * Graph reports `canEdit: true` for owned calendars; shared calendars
 * we have read or read/write access to come back with `canEdit:
 * false` (read-only) or `true` (read/write delegate, but `owner`
 * matches the delegating user, not the signed-in one).
 */
export function calendarTypeOf(graph: GraphCalendar, signedInUpn: string): "own" | "shared" {
    const owner = graph.owner?.address?.toLowerCase();
    if (typeof owner === "string" && owner.length > 0 && owner !== signedInUpn.toLowerCase()) {
        return "shared";
    }
    return "own";
}

/**
 * Display name of a shared calendar's original owner. Returns `null`
 * for owned calendars so the row reflects the operational state
 * accurately.
 */
export function ownerNameOf(graph: GraphCalendar, type: "own" | "shared"): string | null {
    if (type === "own") {
        return null;
    }
    return graph.owner?.name ?? graph.owner?.address ?? null;
}

/**
 * Convert one Graph `{dateTime, timeZone}` slot into a UTC ISO-8601 string
 * with trailing `Z`. Storage is canonical UTC; the {@link
 * CalendarEventRow.eventTz} field on the surrounding row carries the
 * original IANA zone for round-tripping writes back to Graph.
 *
 * Graph returns `dateTime` as a wall-clock string ("2026-05-21T08:00:00")
 * paired with a separate `timeZone` field (IANA zone or `"UTC"`). When the
 * input is already UTC (either ends with `Z` or `timeZone === "UTC"`), we
 * just normalize the suffix. Otherwise luxon resolves the wall-clock in
 * the given zone and converts to UTC — DST gap / overlap follow luxon's
 * default semantics (forward-shift on gaps, earlier instant on overlaps).
 *
 * Malformed inputs (missing slot, empty dateTime, unknown zone) fall back
 * to the epoch — same as the prior helper. The fallback is intentional:
 * we'd rather surface a clearly-wrong "1970" date in the agent's view
 * than a parser exception breaking the whole poll cycle.
 */
function isoFromGraph(slot: { dateTime: string; timeZone: string } | null | undefined): string {
    if (!slot || typeof slot.dateTime !== "string" || slot.dateTime.length === 0) {
        return new Date(0).toISOString();
    }
    if (slot.dateTime.endsWith("Z")) {
        return slot.dateTime;
    }
    if (slot.timeZone === "UTC") {
        return `${slot.dateTime}Z`;
    }
    const dt = DateTime.fromISO(slot.dateTime, { zone: slot.timeZone });
    if (!dt.isValid) {
        return new Date(0).toISOString();
    }
    const iso = dt.toUTC().toISO({ suppressMilliseconds: true });
    return iso ?? new Date(0).toISOString();
}

function attendeeFromGraph(graph: {
    type?: string;
    status?: { response?: string };
    emailAddress?: { name?: string; address?: string };
}): CalendarAttendee {
    return {
        name: graph.emailAddress?.name ?? null,
        email: graph.emailAddress?.address ?? "",
        type: normaliseAttendeeType(graph.type),
        response: normaliseResponse(graph.status?.response),
    };
}

function normaliseAttendeeType(raw: string | undefined): CalendarAttendee["type"] {
    if (raw === "required" || raw === "optional" || raw === "resource") {
        return raw;
    }
    return null;
}

function normaliseType(raw: string | null | undefined): CalendarEventType {
    if (
        raw === "singleInstance" ||
        raw === "occurrence" ||
        raw === "exception" ||
        raw === "seriesMaster"
    ) {
        return raw;
    }
    return "singleInstance";
}

function normaliseShowAs(raw: string | null | undefined): CalendarShowAs | null {
    if (
        raw === "busy" ||
        raw === "free" ||
        raw === "tentative" ||
        raw === "oof" ||
        raw === "workingElsewhere"
    ) {
        return raw;
    }
    return null;
}

function normaliseSensitivity(raw: string | null | undefined): CalendarSensitivity | null {
    if (raw === "normal" || raw === "personal" || raw === "private" || raw === "confidential") {
        return raw;
    }
    return null;
}

function normaliseImportance(raw: string | null | undefined): CalendarImportance | null {
    if (raw === "low" || raw === "normal" || raw === "high") {
        return raw;
    }
    return null;
}

function normaliseResponse(raw: string | undefined): CalendarResponseStatus | null {
    if (
        raw === "none" ||
        raw === "accepted" ||
        raw === "tentative" ||
        raw === "declined" ||
        raw === "organizer"
    ) {
        return raw;
    }
    return null;
}

/**
 * Fill inherited fields on an occurrence / exception row from the row
 * of its series master.
 *
 * Graph returns occurrences via `calendarView/delta` with empty
 * `subject` / `location` / `body` / etc. — the caller is expected to
 * fall back to the seriesMaster for those. We mirror that on the
 * persistence path so the local cache never shows blank occurrence
 * rows. Fields with a clear per-instance identity (start/end,
 * cancellation, RSVP response, type, scan generation) are kept from
 * the occurrence verbatim; only the inherited-by-default fields are
 * filled.
 *
 * Empty strings are treated as missing — Graph returns `subject: ""`
 * (not `null`) for inherited string fields, so a `?? master.subject`
 * fall-through wouldn't fire on its own.
 */
export function mergeWithMaster(
    occurrence: NewCalendarEvent,
    master: CalendarEventRow,
): NewCalendarEvent {
    return {
        ...occurrence,
        subject: preferOccurrence(occurrence.subject, master.subject),
        body: preferOccurrence(occurrence.body, master.body),
        location: preferOccurrence(occurrence.location, master.location),
        importance: occurrence.importance ?? master.importance ?? null,
        sensitivity: occurrence.sensitivity ?? master.sensitivity ?? null,
        showAs: occurrence.showAs ?? master.showAs ?? null,
        organizerName: preferOccurrence(occurrence.organizerName, master.organizerName),
        organizerEmail: preferOccurrence(occurrence.organizerEmail, master.organizerEmail),
        isOnlineMeeting:
            occurrence.isOnlineMeeting === true ? true : master.isOnlineMeeting === true,
        onlineMeetingUrl: preferOccurrence(occurrence.onlineMeetingUrl, master.onlineMeetingUrl),
        attendees:
            occurrence.attendees && occurrence.attendees.length > 0
                ? occurrence.attendees
                : (master.attendees ?? null),
    };
}

/**
 * Pick the occurrence's value when it carries content, fall back to
 * the master otherwise. "Content" excludes `null`, `undefined`, AND
 * the empty string — Graph sends `""` for fields the occurrence
 * inherits, which the agent would surface as missing data without
 * the fallback.
 */
function preferOccurrence(occ: string | null | undefined, master: string | null): string | null {
    if (typeof occ === "string" && occ.length > 0) {
        return occ;
    }
    return master;
}

/** Convert attachment metadata returned by Graph into the core shape. */
export function attachmentMetaFromGraph(graph: {
    readonly id: string;
    readonly name: string;
    readonly contentType: string;
    readonly size: number;
}): CalendarAttachmentMeta {
    return {
        id: graph.id,
        name: graph.name,
        contentType: graph.contentType,
        size: graph.size,
    };
}
