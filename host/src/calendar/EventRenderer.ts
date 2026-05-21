import { type CalendarEventRow, type ConfigService, renderInZone } from "@getfamiliar/shared";

// Re-exported for backwards compatibility — callers historically import
// `renderInZone` from this module. The canonical home is `shared/Timezone`.
export { renderInZone };

/**
 * Agent-facing projection of a {@link CalendarEventRow}.
 *
 * The internal storage truth on `CalendarEventRow` is UTC: `startDt` /
 * `endDt` are ISO-8601 strings ending in `Z`. The agent never sees those
 * directly — every read tool (`cal_get_events`, `cal_get_event`) and every
 * `calendar:{new,update,delete}` bus payload projects through
 * {@link renderEventForAgent} first, replacing the UTC times with
 * wall-clock-plus-offset strings rendered in `core.timezone`.
 *
 * `eventTz` carries the **original** IANA zone (the one the event was
 * authored in on Graph / CalDAV / etc.) so handlers that genuinely care
 * about cross-zone reasoning can read it; the renderer does not consult
 * it because the agent is meant to operate strictly in `core.timezone`.
 */
export interface AgentEventView {
    readonly id: string;
    readonly calendarId: string;
    readonly seriesMasterId: string | null;
    readonly type: CalendarEventRow["type"];
    readonly subject: string | null;
    /** Wall-clock ISO with offset in `core.timezone` (e.g. `2026-05-21T08:00:00+02:00`). */
    readonly start: string;
    /** Wall-clock ISO with offset in `core.timezone`. */
    readonly end: string;
    /** Original IANA zone the event was authored in; informational only. */
    readonly eventTz: string | null;
    readonly isAllDay: boolean;
    readonly isCancelled: boolean;
    readonly showAs: CalendarEventRow["showAs"];
    readonly sensitivity: CalendarEventRow["sensitivity"];
    readonly importance: CalendarEventRow["importance"];
    readonly location: string | null;
    readonly isOnlineMeeting: boolean;
    readonly onlineMeetingUrl: string | null;
    readonly organizerName: string | null;
    readonly organizerEmail: string | null;
    readonly responseStatus: CalendarEventRow["responseStatus"];
    readonly attendees: CalendarEventRow["attendees"];
    readonly body: string | null;
    readonly attachments: CalendarEventRow["attachments"];
    readonly scanGeneration: number;
    readonly createdAt: Date;
    readonly updatedAt: Date;
}

/**
 * Build the agent-facing view of one event row. `coreTz` is the IANA
 * zone from `core.timezone`; pass `"UTC"` to render UTC verbatim.
 *
 * Conversion failures (malformed UTC string in the row, unknown zone)
 * fall back to the input string unchanged — handlers see the raw UTC and
 * can flag the bad row rather than the entire emit/read crashing.
 */
export function renderEventForAgent(row: CalendarEventRow, coreTz: string): AgentEventView {
    return {
        ...row,
        start: renderInZone(row.startDt, coreTz),
        end: renderInZone(row.endDt, coreTz),
    };
}

/**
 * Read `core.timezone` defensively. Defaults to `"UTC"` when the key is
 * absent or empty so agent-facing surfaces stay deterministic on a fresh
 * install with no `core:` config block.
 */
export function readCoreTimezone(config: ConfigService): string {
    const tz = config.getString("core.timezone", "UTC") ?? "UTC";
    return typeof tz === "string" && tz.length > 0 ? tz : "UTC";
}
