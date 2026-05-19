import {
    type CalendarApi,
    type CalendarEventRow,
    type CalendarProvider,
    type CalendarRow,
    type ConfigService,
    EVENT_PRIORITY,
    type EventBus,
    type FindEventsQuery,
    type Logger,
    type NewCalendarEvent,
    type UpsertCalendarInput,
} from "@getfamiliar/shared";
import type { CalendarRegistry } from "./CalendarRegistry.js";
import type { CalendarStore } from "./CalendarStore.js";

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
 * Concrete implementation of {@link CalendarApi}. One instance per
 * host process, shared across plugin contexts via
 * {@link CalendarApiBinding} so every plugin sees the same registry.
 *
 * Bus events:
 *   - `calendar:new` — emitted by {@link addEvent} when `seed=false`
 *     and the row id did not previously exist. Idempotency key is the
 *     event id (`<plugin>:<provider-id>`) so re-walks dedup on the
 *     bus side.
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

    async endRefresh(calendarId: string, gen: number): Promise<{ removed: number }> {
        return this.deps.store.endRefresh(calendarId, gen);
    }

    async addEvent(row: NewCalendarEvent, opts: { seed: boolean }): Promise<{ created: boolean }> {
        const result = await this.deps.store.upsertEvent(row);
        if (!opts.seed && result.created) {
            await this.emitNew(row).catch((err) => {
                const message = err instanceof Error ? err.message : String(err);
                this.deps.log.warn(
                    { calendarEventId: row.id, err: message },
                    "calendar: emit calendar:new failed",
                );
            });
        }
        return result;
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

    private async emitNew(row: NewCalendarEvent): Promise<void> {
        const bus = await this.deps.events();
        await bus.add({
            topic: "calendar:new",
            prompt: `A new calendar event was discovered: ${row.subject ?? "(no subject)"}.`,
            priority: EVENT_PRIORITY.ASYNC,
            idempotencyKey: `calendar:new:${row.id}`,
            payload: {
                calendarEventId: row.id,
                calendarId: row.calendarId,
                subject: row.subject,
                start: row.startDt,
                end: row.endDt,
                isAllDay: row.isAllDay === true,
                eventTz: row.eventTz ?? null,
            },
        });
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
