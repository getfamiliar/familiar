import type {
    CalendarApi,
    CalendarEventRow,
    CalendarProvider,
    CalendarRow,
    ConfigService,
    CreateEventInput,
    UpdateEventInput,
} from "@getfamiliar/shared";
import { getActiveLogins } from "../auth/ActiveLogins.js";
import type { Ms365CalendarConfig } from "../Config.js";
import { GraphClient } from "../graph/GraphClient.js";
import {
    buildCreateBody,
    buildPatchBody,
    eventRowFromGraph,
    MS365_PROVIDER_ID,
} from "./Mapping.js";

/**
 * `CalendarProvider` implementation for Microsoft 365. Stateless apart
 * from the `pluginId` constant; all per-call resolution (which login
 * owns which calendar) happens on demand against the calendar's
 * `uniqueKey` (the Graph calendar id) and the active login store.
 *
 * The provider deliberately does not look up the local cache or talk
 * to the core service. The core's `cal_*` tools handle persistence
 * after `createEvent` returns — see `CalendarService.addEvent`.
 */
export class Ms365CalendarProvider implements CalendarProvider {
    readonly pluginId = MS365_PROVIDER_ID;
    private readonly config: ConfigService;
    private readonly calendarApi: CalendarApi;
    private readonly calendarConfig: Ms365CalendarConfig;

    constructor(deps: {
        readonly config: ConfigService;
        readonly calendarApi: CalendarApi;
        readonly calendarConfig: Ms365CalendarConfig;
    }) {
        this.config = deps.config;
        this.calendarApi = deps.calendarApi;
        this.calendarConfig = deps.calendarConfig;
    }

    async createEvent(calendar: CalendarRow, input: CreateEventInput): Promise<CalendarEventRow> {
        const { client, upn } = await this.clientForCalendar(calendar);
        const sanitised = this.maybeStripAttendees(input);
        const body = buildCreateBody(sanitised, {
            timezone: this.timezoneFromConfig(),
            reminderMinutesBeforeStart: this.calendarConfig.defaultReminderMinutesBeforeStart,
        });
        const graph = await client.createCalendarEvent(upn, calendar.uniqueKey, body);
        const row = eventRowFromGraph(graph, {
            calendarId: calendar.id,
            scanGeneration: calendar.scanGeneration,
        });
        // Upload attachments after creation — Graph's create-event
        // endpoint does not accept attachments inline. Failures here
        // leave the event itself in place; the agent sees a
        // ToolFailure but the bare event exists.
        if (input.attachments && input.attachments.length > 0) {
            for (const att of input.attachments) {
                await client.addEventAttachment(upn, graph.id, att.name, att.contents);
            }
        }
        return row;
    }

    async updateEvent(
        calendar: CalendarRow,
        eventId: string,
        patch: UpdateEventInput,
    ): Promise<CalendarEventRow> {
        const graphEventId = stripPrefix(eventId);
        const { client, upn } = await this.clientForCalendar(calendar);
        const sanitised = this.maybeStripAttendeesUpdate(patch);
        const body = buildPatchBody(sanitised, { timezone: this.timezoneFromConfig() });
        if (Object.keys(body).length === 0) {
            // No-op patch: Graph would still 200 but minting an empty
            // PATCH masks agent bugs. Re-fetch the event so the
            // returned row reflects the live state and let the caller
            // notice nothing changed.
            const current = await client.getCalendarEvent(upn, graphEventId);
            return eventRowFromGraph(current, {
                calendarId: calendar.id,
                scanGeneration: calendar.scanGeneration,
            });
        }
        const graph = await client.updateCalendarEvent(upn, graphEventId, body);
        return eventRowFromGraph(graph, {
            calendarId: calendar.id,
            scanGeneration: calendar.scanGeneration,
        });
    }

    async deleteEvent(calendar: CalendarRow, eventId: string): Promise<void> {
        const graphEventId = stripPrefix(eventId);
        const { client, upn } = await this.clientForCalendar(calendar);
        await client.deleteCalendarEvent(upn, graphEventId);
    }

    async attachFile(eventId: string, name: string, contents: Buffer): Promise<void> {
        const { client, upn, graphEventId } = await this.clientForEvent(eventId);
        await client.addEventAttachment(upn, graphEventId, name, contents);
    }

    async getAttachments(eventId: string): Promise<readonly { name: string; contents: Buffer }[]> {
        const { client, upn, graphEventId } = await this.clientForEvent(eventId);
        const raw = await client.getEventAttachments(upn, graphEventId);
        const out: { name: string; contents: Buffer }[] = [];
        for (const att of raw) {
            if (att.isInline) {
                continue;
            }
            if (typeof att.contentBytes !== "string" || att.contentBytes.length === 0) {
                continue;
            }
            out.push({
                name: att.name,
                contents: Buffer.from(att.contentBytes, "base64"),
            });
        }
        return out;
    }

    private timezoneFromConfig(): string {
        const tz = this.config.getString("core.timezone", "UTC") ?? "UTC";
        return typeof tz === "string" && tz.length > 0 ? tz : "UTC";
    }

    private maybeStripAttendees(input: CreateEventInput): CreateEventInput {
        if (this.calendarConfig.allowAttendees) {
            return input;
        }
        if (!input.attendees || input.attendees.length === 0) {
            return input;
        }
        return { ...input, attendees: [] };
    }

    /**
     * Same gate as {@link maybeStripAttendees} but for update patches.
     * Distinguishes "patch doesn't mention attendees" (leave Graph's
     * current list alone) from "patch sets attendees to [a, b]" (when
     * disallowed, force to empty so the agent never sends invitations
     * by accident).
     */
    private maybeStripAttendeesUpdate(input: UpdateEventInput): UpdateEventInput {
        if (this.calendarConfig.allowAttendees) {
            return input;
        }
        if (input.attendees === undefined) {
            return input;
        }
        return { ...input, attendees: [] };
    }

    /**
     * Resolve `(GraphClient, upn)` for a calendar row. Reads the
     * active login store seeded by the daemon; throws when no login
     * can be matched — the agent sees a clean `ToolFailure`.
     *
     * The owner of the matching login is decided by:
     *   1. Calendar type `own` → primary upn = calendar's owner.
     *      But we don't persist the upn on the row, so we just
     *      iterate active logins and pick whichever can read it.
     *   2. Calendar type `shared` → any login with delegated access.
     */
    private async clientForCalendar(
        _calendar: CalendarRow,
    ): Promise<{ client: GraphClient; upn: string }> {
        const store = getActiveLogins();
        if (!store) {
            throw new Error(
                "no active ms365 logins; run `./cli.sh ms365 login` and restart the daemon",
            );
        }
        const logins = store.list();
        if (logins.length === 0) {
            throw new Error("no active ms365 logins; run `./cli.sh ms365 login`");
        }
        // v1: use the first login — the calendar owner mapping is
        // expanded once shared/delegated calendars actually live on a
        // different upn than the signed-in user.
        const first = logins[0];
        return {
            client: new GraphClient(() => first.auth.getAccessTokenSilent()),
            upn: first.upn,
        };
    }

    private async clientForEvent(
        eventId: string,
    ): Promise<{ client: GraphClient; upn: string; graphEventId: string }> {
        const prefix = `${MS365_PROVIDER_ID}:`;
        if (!eventId.startsWith(prefix)) {
            throw new Error(
                `event id "${eventId}" is not owned by the ms365 provider — expected prefix "${prefix}"`,
            );
        }
        const graphEventId = eventId.slice(prefix.length);
        const row = await this.calendarApi.getEvent(eventId);
        if (!row) {
            throw new Error(`event ${eventId} not found in local cache`);
        }
        const calendars = await this.calendarApi.listCalendars({ pluginId: MS365_PROVIDER_ID });
        const calendar = calendars.find((c) => c.id === row.calendarId);
        if (!calendar) {
            throw new Error(`calendar ${row.calendarId} not found for event ${eventId}`);
        }
        const resolved = await this.clientForCalendar(calendar);
        return { ...resolved, graphEventId };
    }
}

/**
 * Strip the `ms365:` prefix the core uses on event ids to recover the
 * bare Graph id Graph endpoints expect. Throws with a clear,
 * agent-readable message when the id doesn't carry the expected
 * prefix — that catches mis-routed dispatches (an id from another
 * provider was passed to this one).
 */
function stripPrefix(eventId: string): string {
    const prefix = `${MS365_PROVIDER_ID}:`;
    if (!eventId.startsWith(prefix)) {
        throw new Error(
            `event id "${eventId}" is not owned by the ms365 provider — expected prefix "${prefix}"`,
        );
    }
    return eventId.slice(prefix.length);
}
