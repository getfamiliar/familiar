import type {
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
 *
 * Every `eventId` arriving on a method here is the **bare Graph id**:
 * the core (`CalendarTools`) parses the `ms365:` prefix away using
 * {@link parseCalendarEventId} before dispatch.
 */
export class Ms365CalendarProvider implements CalendarProvider {
    readonly pluginId = MS365_PROVIDER_ID;
    private readonly config: ConfigService;
    private readonly calendarConfig: Ms365CalendarConfig;

    constructor(deps: {
        readonly config: ConfigService;
        readonly calendarConfig: Ms365CalendarConfig;
    }) {
        this.config = deps.config;
        this.calendarConfig = deps.calendarConfig;
    }

    async createEvent(calendar: CalendarRow, input: CreateEventInput): Promise<CalendarEventRow> {
        const { client, upn } = await this.clientForCalendar(calendar);
        const body = buildCreateBody(input, {
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
        const { client, upn } = await this.clientForCalendar(calendar);
        const body = buildPatchBody(patch, { timezone: this.timezoneFromConfig() });
        if (Object.keys(body).length === 0) {
            // No-op patch: Graph would still 200 but minting an empty
            // PATCH masks agent bugs. Re-fetch the event so the
            // returned row reflects the live state and let the caller
            // notice nothing changed.
            const current = await client.getCalendarEvent(upn, eventId);
            return eventRowFromGraph(current, {
                calendarId: calendar.id,
                scanGeneration: calendar.scanGeneration,
            });
        }
        const graph = await client.updateCalendarEvent(upn, eventId, body);
        return eventRowFromGraph(graph, {
            calendarId: calendar.id,
            scanGeneration: calendar.scanGeneration,
        });
    }

    async deleteEvent(calendar: CalendarRow, eventId: string): Promise<void> {
        const { client, upn } = await this.clientForCalendar(calendar);
        await client.deleteCalendarEvent(upn, eventId);
    }

    async attachFile(
        calendar: CalendarRow,
        eventId: string,
        name: string,
        contents: Buffer,
    ): Promise<void> {
        const { client, upn } = await this.clientForCalendar(calendar);
        await client.addEventAttachment(upn, eventId, name, contents);
    }

    async getAttachments(
        calendar: CalendarRow,
        eventId: string,
    ): Promise<readonly { name: string; contents: Buffer }[]> {
        const { client, upn } = await this.clientForCalendar(calendar);
        const raw = await client.getEventAttachments(upn, eventId);
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
}
