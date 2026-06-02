import {
    type CalendarApi,
    type CalendarChangePayload,
    type CalendarEventRow,
    type CalendarProvider,
    type CalendarRow,
    type ConfigService,
    DuplicateIdempotencyKeyError,
    EVENT_PRIORITY,
    type EventBus,
    type FindEventsQuery,
    type Logger,
    type NewCalendarEvent,
    type UpsertCalendarInput,
} from "@getfamiliar/shared";
import type { CalendarRegistry } from "./CalendarRegistry.js";
import type { CalendarStore } from "./CalendarStore.js";
import { readCoreTimezone, renderEventForAgent } from "./EventRenderer.js";

export interface CalendarServiceDeps {
    readonly store: CalendarStore;
    readonly registry: CalendarRegistry;
    /**
     * Lazy access to the shared `EventBus` — calendar:new emissions
     * go through it. Lazy so the calendar service can be instantiated
     * before the postgres pool is open (e.g. during one-shot CLI
     * commands that never emit anything).
     */
    readonly events: () => Promise<EventBus>;
    readonly config: ConfigService;
    readonly log: Logger;
}

/**
 * Topic format accepted by {@link CalendarService.emitCalendarEvent}.
 * Captures the verb and the pluginId so the service can validate the
 * suffix against the calendar's owning plugin.
 */
const EMIT_TOPIC_RE = /^calendar:(new|update|delete):([\w-]+)$/;

/**
 * Concrete implementation of {@link CalendarApi}. One instance per
 * host process, shared across plugin contexts via
 * {@link CalendarApiBinding} so every plugin sees the same registry.
 *
 * Bus events:
 *   - `calendar:new:<pluginId>` / `calendar:update:<pluginId>` /
 *     `calendar:delete:<pluginId>` — emitted via
 *     {@link emitCalendarEvent}. Pollers call this explicitly after an
 *     upsert (using the `{created}` flag to pick new vs update) or
 *     before a tombstone-driven remove. The service additionally
 *     drives `calendar:delete:<pluginId>` for every row pruned by
 *     {@link endRefresh}.
 *
 * Defaults / lookups:
 *   - `resolveDefaultCalendar` parses `core.defaultCalendar` (format
 *     `"<name>"` or `"<pluginId>:<name>"`). Returns `null` for unset
 *     or not-yet-discovered.
 */
export class CalendarService implements CalendarApi {
    private readonly deps: CalendarServiceDeps;

    constructor(deps: CalendarServiceDeps) {
        this.deps = deps;
    }

    registerProvider(provider: CalendarProvider): void {
        this.deps.registry.register(provider);
    }

    /** Expose the registry for write-tool dispatch in `CalendarTools`. */
    get registry(): CalendarRegistry {
        return this.deps.registry;
    }

    async upsertCalendar(input: UpsertCalendarInput): Promise<CalendarRow> {
        return this.deps.store.upsertCalendar(input);
    }

    async beginRefresh(calendarId: string): Promise<number> {
        return this.deps.store.beginRefresh(calendarId);
    }

    async endRefresh(
        calendarId: string,
        gen: number,
    ): Promise<{ removed: number; rows: readonly CalendarEventRow[] }> {
        const result = await this.deps.store.endRefresh(calendarId, gen);
        if (result.rows.length === 0) {
            return result;
        }
        const calendar = await this.deps.store.getCalendar(calendarId);
        if (!calendar) {
            this.deps.log.warn(
                { calendarId },
                "calendar: endRefresh pruned rows for unknown calendar; skipping delete emissions",
            );
            return result;
        }
        const topic = `calendar:delete:${calendar.pluginId}`;
        for (const deleted of result.rows) {
            await this.emitFromRow(topic, deleted, calendar.pluginId).catch((err) => {
                const message = err instanceof Error ? err.message : String(err);
                this.deps.log.warn(
                    { calendarEventId: deleted.id, err: message },
                    "calendar: endRefresh delete emit failed",
                );
            });
        }
        return result;
    }

    // `opts.seed` is retained for forward compatibility; emission control
    // moved to the caller via {@link emitCalendarEvent}, so this method
    // is now pure persistence.
    async addEvent(
        row: NewCalendarEvent,
        _opts: { seed: boolean },
    ): Promise<{ created: boolean; changed: boolean }> {
        return this.deps.store.upsertEvent(row);
    }

    async removeEvent(id: string): Promise<void> {
        return this.deps.store.removeEvent(id);
    }

    async findEvents(q: FindEventsQuery): Promise<readonly CalendarEventRow[]> {
        return this.deps.store.findEvents(q);
    }

    async getEvent(id: string): Promise<CalendarEventRow | null> {
        return this.deps.store.getEvent(id);
    }

    async listCalendars(filter?: { pluginId?: string }): Promise<readonly CalendarRow[]> {
        return this.deps.store.listCalendars(filter);
    }

    async resolveDefaultCalendar(): Promise<CalendarRow | null> {
        const ref = this.deps.config.getString("core.defaultCalendar", "") ?? "";
        if (typeof ref === "string" && ref.length > 0) {
            return this.resolveCalendarRef(ref);
        }
        // Fallback: the provider-flagged default. `listCalendars`
        // returns rows in `id ASC` order, so the first match is the
        // first calendar the first registered login surfaced as its
        // default — matches the user's "default of the first ms365
        // login" rule when ms365 is the only provider.
        const calendars = await this.deps.store.listCalendars();
        return calendars.find((c) => c.isDefault) ?? null;
    }

    async resolveCalendarRef(ref: string): Promise<CalendarRow | null> {
        const colon = ref.indexOf(":");
        const calendars = await this.deps.store.listCalendars();
        if (colon > 0) {
            const pluginId = ref.slice(0, colon);
            const name = ref.slice(colon + 1);
            const candidate = calendars.find((c) => c.pluginId === pluginId && c.name === name);
            return candidate ?? null;
        }
        const matches = calendars.filter((c) => c.name === ref);
        if (matches.length === 0) {
            return null;
        }
        if (matches.length === 1) {
            return matches[0];
        }
        const list = matches.map((c) => `${c.pluginId}:${c.name}`).join(", ");
        throw new Error(
            `calendar reference "${ref}" is ambiguous — multiple matches: ${list}. ` +
                "Use the qualified form '<pluginId>:<name>' instead.",
        );
    }

    async emitCalendarEvent(topic: string, eventId: string): Promise<void> {
        const match = EMIT_TOPIC_RE.exec(topic);
        if (!match) {
            throw new Error(
                `calendar: invalid emit topic "${topic}" — expected ` +
                    `"calendar:{new|update|delete}:<pluginId>"`,
            );
        }
        const topicPluginId = match[2];
        const row = await this.deps.store.getEvent(eventId);
        if (!row) {
            throw new Error(`calendar: emit target row not found: ${eventId}`);
        }
        const calendar = await this.deps.store.getCalendar(row.calendarId);
        if (!calendar) {
            throw new Error(
                `calendar: event ${eventId} references unknown calendar ${row.calendarId}`,
            );
        }
        if (calendar.pluginId !== topicPluginId) {
            throw new Error(
                `calendar: emit topic "${topic}" pluginId does not match ` +
                    `the event's calendar owner "${calendar.pluginId}"`,
            );
        }
        await this.emitFromRow(topic, row, calendar.pluginId);
    }

    /**
     * Build the standardized payload + prompt for `row` and post it
     * under `topic`. Caller is responsible for having validated the
     * topic shape and pluginId match — this helper trusts both. The
     * verb is parsed from the topic so `endRefresh`'s pre-built
     * `calendar:delete:<pluginId>` path can reuse it without a second
     * regex pass.
     */
    private async emitFromRow(
        topic: string,
        row: CalendarEventRow,
        pluginId: string,
    ): Promise<void> {
        const match = EMIT_TOPIC_RE.exec(topic);
        if (!match) {
            throw new Error(`calendar: emitFromRow received invalid topic "${topic}"`);
        }
        const verb = match[1] as CalendarChangePayload["verb"];
        const subjectLabel = row.subject ?? "(no subject)";
        const prompt =
            verb === "new"
                ? `A new calendar event was discovered: ${subjectLabel}.`
                : verb === "update"
                  ? `A calendar event was updated: ${subjectLabel}.`
                  : `A calendar event was deleted: ${subjectLabel}.`;
        // new/delete fire once per id; update fires once per change,
        // discriminated by the row's updatedAt. Two pollers seeing
        // the identical updated_at coalesce on the bus side; two
        // genuine sequential updates each fire.
        const updatedAtIso = row.updatedAt.toISOString();
        const idempotencyKey =
            verb === "update"
                ? `calendar:update:${pluginId}:${row.id}:${updatedAtIso}`
                : `calendar:${verb}:${pluginId}:${row.id}`;
        const view = renderEventForAgent(row, readCoreTimezone(this.deps.config));
        const payload: CalendarChangePayload = {
            verb,
            pluginId,
            calendarEventId: row.id,
            calendarId: row.calendarId,
            subject: view.subject,
            start: view.start,
            end: view.end,
            eventTz: view.eventTz,
            isAllDay: view.isAllDay,
            isCancelled: view.isCancelled,
            organizerEmail: view.organizerEmail,
            location: view.location,
            updatedAt: updatedAtIso,
        };
        const bus = await this.deps.events();
        try {
            await bus.add({
                topic,
                prompt,
                priority: EVENT_PRIORITY.ASYNC,
                idempotencyKey,
                payload,
            });
        } catch (err) {
            if (err instanceof DuplicateIdempotencyKeyError) {
                // Re-walks of an unchanged event reuse the stable
                // new/delete key; the change was already emitted. No-op.
                this.deps.log.debug(
                    `calendar: event ${row.id} change already emitted ` +
                        `(idempotency key "${idempotencyKey}"); skipping`,
                );
                return;
            }
            throw err;
        }
    }
}

/**
 * Adapter that makes {@link CalendarService} usable as the
 * {@link CalendarApi} surface plugins receive via `ctx.calendar`.
 * Same instance, just typed as the public interface.
 */
export function asCalendarApi(service: CalendarService): CalendarApi {
    return service;
}
