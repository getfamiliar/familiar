import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type {
    CalendarChangePayload,
    CalendarEventRow,
    CalendarRow,
    ConfigService,
    EventBus,
    EventRow,
    Logger,
    NewCalendarEvent,
    NewEvent,
} from "@getfamiliar/shared";
import { CalendarRegistry } from "./CalendarRegistry.js";
import { CalendarService } from "./CalendarService.js";
import type { CalendarStore } from "./CalendarStore.js";

describe("CalendarService.resolveCalendarRef", () => {
    it("returns null for an unknown name", async () => {
        const svc = build({ calendars: [sampleCalendar({ pluginId: "ms365", name: "Work" })] });
        assert.equal(await svc.resolveCalendarRef("Home"), null);
    });

    it("matches a unique unprefixed name", async () => {
        const svc = build({ calendars: [sampleCalendar({ pluginId: "ms365", name: "Work" })] });
        const cal = await svc.resolveCalendarRef("Work");
        assert.equal(cal?.name, "Work");
        assert.equal(cal?.pluginId, "ms365");
    });

    it("throws on ambiguous unprefixed name across providers", async () => {
        const svc = build({
            calendars: [
                sampleCalendar({ pluginId: "ms365", name: "Work" }),
                sampleCalendar({ pluginId: "gcal", name: "Work" }),
            ],
        });
        await assert.rejects(svc.resolveCalendarRef("Work"), /ambiguous/);
    });

    it("disambiguates with the pluginId prefix", async () => {
        const svc = build({
            calendars: [
                sampleCalendar({ pluginId: "ms365", name: "Work" }),
                sampleCalendar({ pluginId: "gcal", name: "Work" }),
            ],
        });
        const cal = await svc.resolveCalendarRef("gcal:Work");
        assert.equal(cal?.pluginId, "gcal");
    });

    it("returns null when the qualified name doesn't match either part", async () => {
        const svc = build({ calendars: [sampleCalendar({ pluginId: "ms365", name: "Work" })] });
        assert.equal(await svc.resolveCalendarRef("ms365:Home"), null);
        assert.equal(await svc.resolveCalendarRef("gcal:Work"), null);
    });
});

describe("CalendarService.resolveDefaultCalendar", () => {
    it("returns null when core.defaultCalendar is unset AND no calendar is flagged default", async () => {
        const svc = build({
            calendars: [sampleCalendar({ pluginId: "ms365", name: "Work" })],
            configMap: {},
        });
        assert.equal(await svc.resolveDefaultCalendar(), null);
    });

    it("resolves the configured default", async () => {
        const svc = build({
            calendars: [sampleCalendar({ pluginId: "ms365", name: "Work" })],
            configMap: { "core.defaultCalendar": "Work" },
        });
        const cal = await svc.resolveDefaultCalendar();
        assert.equal(cal?.name, "Work");
    });

    it("falls back to the first is_default calendar when config is unset", async () => {
        const svc = build({
            calendars: [
                sampleCalendar({ id: "1", pluginId: "ms365", name: "Other", isDefault: false }),
                sampleCalendar({ id: "2", pluginId: "ms365", name: "Kalender", isDefault: true }),
            ],
            configMap: {},
        });
        const cal = await svc.resolveDefaultCalendar();
        assert.equal(cal?.name, "Kalender");
    });
});

describe("CalendarService.emitCalendarEvent", () => {
    it("emits the standardized payload for calendar:new:<pluginId>", async () => {
        const calendar = sampleCalendar({ id: "1", pluginId: "ms365" });
        const row = sampleEvent({ id: "ms365:abc", calendarId: "1", subject: "Lunch" });
        const captured: NewEvent[] = [];
        const svc = build({
            calendars: [calendar],
            events: [row],
            captureEmits: captured,
        });
        await svc.emitCalendarEvent("calendar:new:ms365", "ms365:abc");
        assert.equal(captured.length, 1);
        const emitted = captured[0];
        assert.equal(emitted.topic, "calendar:new:ms365");
        assert.equal(emitted.prompt, "A new calendar event was discovered: Lunch.");
        assert.equal(emitted.idempotencyKey, "calendar:new:ms365:ms365:abc");
        const payload = emitted.payload as CalendarChangePayload;
        assert.equal(payload.verb, "new");
        assert.equal(payload.pluginId, "ms365");
        assert.equal(payload.calendarEventId, "ms365:abc");
        assert.equal(payload.subject, "Lunch");
    });

    it("uses updatedAt in the idempotency key for updates", async () => {
        const calendar = sampleCalendar({ id: "1", pluginId: "ms365" });
        const updatedAt = new Date("2026-05-21T09:15:00.000Z");
        const row = sampleEvent({ id: "ms365:abc", calendarId: "1", updatedAt });
        const captured: NewEvent[] = [];
        const svc = build({ calendars: [calendar], events: [row], captureEmits: captured });
        await svc.emitCalendarEvent("calendar:update:ms365", "ms365:abc");
        assert.equal(
            captured[0].idempotencyKey,
            "calendar:update:ms365:ms365:abc:2026-05-21T09:15:00.000Z",
        );
        assert.equal((captured[0].payload as CalendarChangePayload).verb, "update");
    });

    it("falls back to '(no subject)' when subject is null", async () => {
        const calendar = sampleCalendar({ id: "1", pluginId: "ms365" });
        const row = sampleEvent({ id: "ms365:abc", calendarId: "1", subject: null });
        const captured: NewEvent[] = [];
        const svc = build({ calendars: [calendar], events: [row], captureEmits: captured });
        await svc.emitCalendarEvent("calendar:delete:ms365", "ms365:abc");
        assert.equal(captured[0].prompt, "A calendar event was deleted: (no subject).");
    });

    it("throws on a malformed topic", async () => {
        const calendar = sampleCalendar({ id: "1", pluginId: "ms365" });
        const row = sampleEvent({ id: "ms365:abc", calendarId: "1" });
        const svc = build({ calendars: [calendar], events: [row] });
        await assert.rejects(
            svc.emitCalendarEvent("calendar:new", "ms365:abc"),
            /invalid emit topic/,
        );
        await assert.rejects(
            svc.emitCalendarEvent("calendar:created:ms365", "ms365:abc"),
            /invalid emit topic/,
        );
    });

    it("throws when the row does not exist (delete-after-remove or typo)", async () => {
        const calendar = sampleCalendar({ id: "1", pluginId: "ms365" });
        const svc = build({ calendars: [calendar], events: [] });
        await assert.rejects(
            svc.emitCalendarEvent("calendar:delete:ms365", "ms365:gone"),
            /emit target row not found/,
        );
    });

    it("throws when the topic pluginId doesn't match the calendar's owner", async () => {
        const calendar = sampleCalendar({ id: "1", pluginId: "ms365" });
        const row = sampleEvent({ id: "ms365:abc", calendarId: "1" });
        const svc = build({ calendars: [calendar], events: [row] });
        await assert.rejects(
            svc.emitCalendarEvent("calendar:new:gcal", "ms365:abc"),
            /pluginId does not match/,
        );
    });
});

describe("CalendarService.addEvent", () => {
    it("does not emit anything by itself — emission is the caller's job", async () => {
        const calendar = sampleCalendar({ id: "1", pluginId: "ms365" });
        const captured: NewEvent[] = [];
        const upsertResults: Array<{ created: boolean }> = [{ created: true }, { created: false }];
        const svc = build({
            calendars: [calendar],
            events: [],
            captureEmits: captured,
            upsertResults,
        });
        const newRow: NewCalendarEvent = {
            id: "ms365:abc",
            calendarId: "1",
            type: "singleInstance",
            subject: "Lunch",
            startDt: "2026-05-21T11:00:00Z",
            endDt: "2026-05-21T12:00:00Z",
            scanGeneration: 1,
        };
        const a = await svc.addEvent(newRow, { seed: false });
        const b = await svc.addEvent(newRow, { seed: false });
        assert.deepEqual(a, { created: true });
        assert.deepEqual(b, { created: false });
        assert.equal(captured.length, 0);
    });
});

describe("CalendarService.endRefresh", () => {
    it("emits one calendar:delete:<pluginId> per pruned row", async () => {
        const calendar = sampleCalendar({ id: "7", pluginId: "ms365" });
        const stale = [
            sampleEvent({ id: "ms365:a", calendarId: "7", subject: "Old A" }),
            sampleEvent({ id: "ms365:b", calendarId: "7", subject: null }),
        ];
        const captured: NewEvent[] = [];
        const svc = build({
            calendars: [calendar],
            events: [],
            captureEmits: captured,
            endRefreshRows: stale,
        });
        const result = await svc.endRefresh("7", 5);
        assert.equal(result.removed, 2);
        assert.equal(captured.length, 2);
        assert.equal(captured[0].topic, "calendar:delete:ms365");
        assert.equal(captured[0].idempotencyKey, "calendar:delete:ms365:ms365:a");
        assert.equal(captured[1].idempotencyKey, "calendar:delete:ms365:ms365:b");
        assert.equal((captured[0].payload as CalendarChangePayload).verb, "delete");
        assert.equal(captured[1].prompt, "A calendar event was deleted: (no subject).");
    });

    it("is a no-op for emits when no rows were pruned", async () => {
        const calendar = sampleCalendar({ id: "7", pluginId: "ms365" });
        const captured: NewEvent[] = [];
        const svc = build({
            calendars: [calendar],
            events: [],
            captureEmits: captured,
            endRefreshRows: [],
        });
        const result = await svc.endRefresh("7", 5);
        assert.equal(result.removed, 0);
        assert.equal(captured.length, 0);
    });
});

interface BuildOptions {
    readonly calendars: readonly CalendarRow[];
    readonly events?: readonly CalendarEventRow[];
    readonly captureEmits?: NewEvent[];
    readonly upsertResults?: Array<{ created: boolean }>;
    readonly endRefreshRows?: readonly CalendarEventRow[];
    readonly configMap?: Record<string, string>;
}

function build(opts: BuildOptions): CalendarService {
    const eventMap = new Map<string, CalendarEventRow>();
    for (const e of opts.events ?? []) {
        eventMap.set(e.id, e);
    }
    const calendarMap = new Map<string, CalendarRow>();
    for (const c of opts.calendars) {
        calendarMap.set(c.id, c);
    }
    const upsertResults = [...(opts.upsertResults ?? [])];
    const store: Partial<CalendarStore> = {
        listCalendars: async () => opts.calendars,
        getCalendar: async (id: string) => calendarMap.get(id) ?? null,
        getEvent: async (id: string) => eventMap.get(id) ?? null,
        upsertEvent: async () => upsertResults.shift() ?? { created: true },
        endRefresh: async () => ({
            removed: opts.endRefreshRows?.length ?? 0,
            rows: opts.endRefreshRows ?? [],
        }),
    };
    const eventsFactory: () => Promise<EventBus> = async () =>
        ({
            add: async (event: NewEvent) => {
                opts.captureEmits?.push(event);
                return {} as EventRow;
            },
        }) as unknown as EventBus;
    return new CalendarService({
        store: store as CalendarStore,
        registry: new CalendarRegistry(),
        events: eventsFactory,
        config: stubConfig(opts.configMap ?? {}),
        log: stubLogger(),
    });
}

function sampleCalendar(overrides: Partial<CalendarRow>): CalendarRow {
    return {
        id: "1",
        pluginId: "ms365",
        uniqueKey: "key",
        name: "Calendar",
        type: "own",
        ownerName: null,
        isDefault: false,
        scanGeneration: 0,
        createdAt: new Date(0),
        ...overrides,
    };
}

function sampleEvent(overrides: Partial<CalendarEventRow>): CalendarEventRow {
    return {
        id: "ms365:abc",
        calendarId: "1",
        seriesMasterId: null,
        type: "singleInstance",
        subject: "Lunch",
        startDt: "2026-05-21T11:00:00Z",
        endDt: "2026-05-21T12:00:00Z",
        eventTz: null,
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
        scanGeneration: 1,
        createdAt: new Date(0),
        updatedAt: new Date("2026-05-21T09:00:00.000Z"),
        ...overrides,
    };
}

function stubConfig(map: Record<string, string>): ConfigService {
    return {
        getString: ((key: string, def?: unknown) =>
            map[key] ?? def ?? "") as ConfigService["getString"],
        getNumber: ((_key: string, def?: unknown) => def ?? 0) as ConfigService["getNumber"],
        getBool: ((_key: string, def?: unknown) => def ?? false) as ConfigService["getBool"],
        getArray: ((_key: string, def?: unknown) => def ?? []) as ConfigService["getArray"],
        set: async (_key: string, _value: unknown) => {},
    } as ConfigService;
}

function stubLogger(): Logger {
    const noop = () => {};
    const logger = {
        info: noop,
        warn: noop,
        error: noop,
        debug: noop,
        trace: noop,
        fatal: noop,
        child: () => logger,
    } as unknown as Logger;
    return logger;
}
