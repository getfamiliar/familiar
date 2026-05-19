/**
 * Core calendar data model. Lives in `shared/` because both the host
 * (which owns persistence and the `cal_*` agent tools) and the plugin
 * providers (which feed the cache and implement create / attach
 * callbacks) trade in the same row shapes. No persistence code here —
 * the host's `CalendarStore` is the only writer.
 *
 * Two layers:
 *
 * 1. **`CalendarRow`** — one logical calendar, owned by one provider
 *    plugin (`pluginId`). Identified uniquely by `(pluginId, uniqueKey)`.
 * 2. **`CalendarEventRow`** — one instance of an appointment. PK is the
 *    provider-prefixed event id (e.g. `ms365:AAMkAGI...`), so multiple
 *    providers can coexist in the same table without collision.
 *
 * Plugins persist *every* occurrence of a recurring series — no
 * master-expansion happens in the core. The `seriesMasterId` /
 * `type` fields let callers reconstruct the series shape when they
 * need to.
 */
export type CalendarType = "own" | "shared";

export interface CalendarRow {
    /** Numeric primary key (`bigserial`), returned as string. */
    readonly id: string;
    /** Plugin id that owns this calendar (e.g. `"ms365"`). */
    readonly pluginId: string;
    /** Provider-specific stable id (e.g. Graph calendar id). */
    readonly uniqueKey: string;
    /** Human-friendly display name. May collide across plugins. */
    readonly name: string;
    /** Whether the signed-in user owns this calendar or it was shared. */
    readonly type: CalendarType;
    /** Display name of the original owner for shared calendars. */
    readonly ownerName: string | null;
    /**
     * The provider's own "default calendar" flag. Used by
     * `resolveDefaultCalendar` as the fallback when
     * `core.defaultCalendar` is unset.
     */
    readonly isDefault: boolean;
    /**
     * Monotonically-increasing tag bumped on each full refresh walk.
     * Rows still tagged with an old generation after a refresh
     * completes get DELETEd — that is how the core reconciles
     * deletions when no per-event tombstone arrives.
     */
    readonly scanGeneration: number;
    readonly createdAt: Date;
}

export interface UpsertCalendarInput {
    readonly pluginId: string;
    readonly uniqueKey: string;
    readonly name: string;
    readonly type: CalendarType;
    readonly ownerName?: string | null;
    readonly isDefault?: boolean;
}

export type CalendarEventType = "singleInstance" | "occurrence" | "exception" | "seriesMaster";

export type CalendarShowAs = "busy" | "free" | "tentative" | "oof" | "workingElsewhere";

export type CalendarSensitivity = "normal" | "personal" | "private" | "confidential";

export type CalendarImportance = "low" | "normal" | "high";

export type CalendarResponseStatus = "none" | "accepted" | "tentative" | "declined" | "organizer";

/**
 * One attendee on a calendar event. Mirrors the Graph shape but is
 * shared between providers; the `response` field stays optional because
 * not every provider distinguishes status types.
 */
export interface CalendarAttendee {
    readonly name: string | null;
    readonly email: string;
    readonly type: "required" | "optional" | "resource" | null;
    readonly response: CalendarResponseStatus | null;
}

/**
 * Lightweight attachment metadata stored on the event row. Actual
 * bytes are fetched on demand via {@link CalendarProvider.getAttachments}.
 */
export interface CalendarAttachmentMeta {
    readonly id: string;
    readonly name: string;
    readonly contentType: string | null;
    readonly size: number | null;
}

/**
 * Persisted shape of a calendar event row. Times stay as ISO-8601
 * strings (UTC) — postgres timestamptz would be wrong here because
 * the agent / user reasoning about "8am Monday" cares about
 * `eventTz`, not when our row was inserted.
 */
export interface CalendarEventRow {
    /** Provider-prefixed id (`ms365:<graph-id>`). Stable across polls. */
    readonly id: string;
    /** FK to `calendars.id`. */
    readonly calendarId: string;
    /** When this row instances a recurring series — the master's id. */
    readonly seriesMasterId: string | null;
    readonly type: CalendarEventType;
    readonly subject: string | null;
    readonly startDt: string;
    readonly endDt: string;
    /** IANA timezone the event was scheduled in. */
    readonly eventTz: string | null;
    readonly isAllDay: boolean;
    readonly isCancelled: boolean;
    readonly showAs: CalendarShowAs | null;
    readonly sensitivity: CalendarSensitivity | null;
    readonly importance: CalendarImportance | null;
    readonly location: string | null;
    readonly isOnlineMeeting: boolean;
    readonly onlineMeetingUrl: string | null;
    readonly organizerName: string | null;
    readonly organizerEmail: string | null;
    readonly responseStatus: CalendarResponseStatus | null;
    readonly attendees: readonly CalendarAttendee[] | null;
    readonly body: string | null;
    readonly attachments: readonly CalendarAttachmentMeta[] | null;
    readonly scanGeneration: number;
    readonly createdAt: Date;
    readonly updatedAt: Date;
}

/**
 * Input shape for {@link CalendarApi.addEvent}. The host sets
 * `scanGeneration` from the active refresh / poll generation; callers
 * only provide the domain fields.
 */
export interface NewCalendarEvent {
    readonly id: string;
    readonly calendarId: string;
    readonly seriesMasterId?: string | null;
    readonly type: CalendarEventType;
    readonly subject: string | null;
    readonly startDt: string;
    readonly endDt: string;
    readonly eventTz?: string | null;
    readonly isAllDay?: boolean;
    readonly isCancelled?: boolean;
    readonly showAs?: CalendarShowAs | null;
    readonly sensitivity?: CalendarSensitivity | null;
    readonly importance?: CalendarImportance | null;
    readonly location?: string | null;
    readonly isOnlineMeeting?: boolean;
    readonly onlineMeetingUrl?: string | null;
    readonly organizerName?: string | null;
    readonly organizerEmail?: string | null;
    readonly responseStatus?: CalendarResponseStatus | null;
    readonly attendees?: readonly CalendarAttendee[] | null;
    readonly body?: string | null;
    readonly attachments?: readonly CalendarAttachmentMeta[] | null;
    readonly scanGeneration: number;
}

export interface FindEventsQuery {
    /** Numeric id of the calendar — usually resolved via `resolveCalendarRef`. */
    readonly calendarId?: string;
    /** Inclusive ISO-8601 lower bound on `startDt`. */
    readonly from?: string;
    /** Exclusive ISO-8601 upper bound on `endDt`. */
    readonly to?: string;
    /** Case-insensitive substring filter on subject / body. */
    readonly text?: string;
    /** Excludes `seriesMaster` rows from results by default. */
    readonly includeMasters?: boolean;
    /** Excludes cancelled rows from results by default. */
    readonly includeCancelled?: boolean;
    readonly limit?: number;
}

/**
 * Plugin-agnostic update-event patch. Every field is optional — only
 * the ones present in the patch are sent through to the provider.
 * Mirrors {@link CreateEventInput} so the agent learns one schema
 * for both surfaces.
 *
 * Notable omission: `isVideocall`. Toggling online-meeting state on
 * an existing event has provider-specific gotchas (Graph mints a new
 * Teams join URL; some providers refuse the patch); v1 callers
 * recreate the event instead.
 */
export interface UpdateEventInput {
    readonly subject?: string;
    readonly start?: string;
    readonly end?: string;
    readonly timezone?: string;
    readonly body?: string;
    readonly location?: string;
    readonly attendees?: readonly { email: string; name?: string }[];
    readonly showAs?: CalendarShowAs;
    readonly sensitivity?: CalendarSensitivity;
    readonly reminderMinutesBeforeStart?: number;
}

/**
 * Plugin-agnostic create-event input. Translated to provider-specific
 * payloads by each `CalendarProvider.createEvent` impl.
 *
 * `body` is markdown; providers render to HTML where applicable.
 * Attendees may be bare addresses (`"a@example.com"`) or
 * `{email, name?}` objects — the helper `normalizeAttendeesInput` in
 * the core tool layer normalises both shapes.
 */
export interface CreateEventInput {
    readonly subject: string;
    readonly start: string;
    readonly end: string;
    readonly body?: string;
    readonly location?: string;
    readonly attendees?: readonly { email: string; name?: string }[];
    readonly showAs?: CalendarShowAs;
    readonly sensitivity?: CalendarSensitivity;
    readonly reminderMinutesBeforeStart?: number;
    readonly attachments?: readonly { name: string; contents: Buffer }[];
    readonly isVideocall?: boolean;
    /** IANA tz hint. Falls back to `core.timezone` when omitted. */
    readonly timezone?: string;
}

/**
 * The contract a provider plugin implements + registers via
 * {@link CalendarApi.registerProvider}. The core dispatches
 * write tools (`cal_create_event`, `cal_attach_file`,
 * `cal_get_event_attachments`) to the provider owning the target
 * calendar.
 */
export interface CalendarProvider {
    readonly pluginId: string;
    /**
     * Create a fresh event on the given calendar and return the
     * persisted row shape. The core inserts the returned row into
     * the cache with `seed: false`, which (because the row id is
     * new) emits a `calendar:new` bus event.
     */
    createEvent(calendar: CalendarRow, input: CreateEventInput): Promise<CalendarEventRow>;
    /**
     * Apply a partial update to an existing event. Returns the
     * post-patch row in the same shape `createEvent` does — the core
     * upserts it into the cache (no `calendar:new` emission, since
     * the PK already exists).
     */
    updateEvent(
        calendar: CalendarRow,
        eventId: string,
        patch: UpdateEventInput,
    ): Promise<CalendarEventRow>;
    /**
     * Delete an event at the provider. The core removes the row
     * from the local cache only after this resolves so a provider
     * error leaves the cache unchanged.
     */
    deleteEvent(calendar: CalendarRow, eventId: string): Promise<void>;
    /** Inline-attach a file (≤3MB) onto an existing event. */
    attachFile(eventId: string, name: string, contents: Buffer): Promise<void>;
    /**
     * Fetch every non-inline attachment for an event as in-memory
     * buffers. The core tool stages these into the agentrun's
     * scratch dir.
     */
    getAttachments(eventId: string): Promise<readonly { name: string; contents: Buffer }[]>;
}

/**
 * Capabilities the host exposes to plugins for calendar data. Reached
 * via `ctx.calendar` on a plugin's `HostContext`. Providers call
 * `registerProvider` once during `start()`; pollers call `upsertCalendar`
 * and the refresh / addEvent / removeEvent helpers; agent-facing tools
 * (host-owned) use the read side (`findEvents`, `getEvent`,
 * `resolveDefaultCalendar`, `resolveCalendarRef`).
 */
export interface CalendarApi {
    /**
     * Register the create / attach callbacks a provider plugin
     * implements. Throws if the same `pluginId` registers twice —
     * a wiring bug, not a feature.
     */
    registerProvider(provider: CalendarProvider): void;

    upsertCalendar(input: UpsertCalendarInput): Promise<CalendarRow>;

    /**
     * Bump the calendar's `scanGeneration` and return the new value.
     * The caller then upserts every event in the lookback..lookahead
     * window tagged with this generation; once the walk completes,
     * {@link endRefresh} deletes rows still on prior generations.
     */
    beginRefresh(calendarId: string): Promise<number>;

    /**
     * Finalise a refresh walk: DELETE every event for `calendarId`
     * whose `scanGeneration < gen`. Returns the count removed.
     */
    endRefresh(calendarId: string, gen: number): Promise<{ removed: number }>;

    /**
     * Upsert one event into the cache. Emits `calendar:new` iff
     * `opts.seed === false` AND the row id did not previously exist.
     * Returns `{created: true}` when the row was a fresh INSERT,
     * `{created: false}` for an UPDATE of an existing row.
     */
    addEvent(row: NewCalendarEvent, opts: { seed: boolean }): Promise<{ created: boolean }>;

    removeEvent(id: string): Promise<void>;

    findEvents(q: FindEventsQuery): Promise<readonly CalendarEventRow[]>;
    getEvent(id: string): Promise<CalendarEventRow | null>;

    /** Enumerate every registered calendar, optionally filtered by plugin. */
    listCalendars(filter?: { pluginId?: string }): Promise<readonly CalendarRow[]>;

    /**
     * Parse `core.defaultCalendar` and resolve it to a row. Returns
     * `null` when the setting is unset OR the named calendar hasn't
     * been discovered yet by its provider (startup race).
     */
    resolveDefaultCalendar(): Promise<CalendarRow | null>;

    /**
     * Parse a calendar reference and return the matching row.
     * Accepted formats:
     *   - `"<name>"` — matches by name across every plugin; throws if
     *     ambiguous (two providers share the name).
     *   - `"<pluginId>:<name>"` — name match restricted to that plugin.
     * Returns `null` when no match exists.
     */
    resolveCalendarRef(ref: string): Promise<CalendarRow | null>;
}
