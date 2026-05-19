import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { CalendarRow, ConfigService, EventBus, Logger } from "@getfamiliar/shared";
import { CalendarRegistry } from "./CalendarRegistry.js";
import { CalendarService } from "./CalendarService.js";
import type { CalendarStore } from "./CalendarStore.js";

describe("CalendarService.resolveCalendarRef", () => {
    it("returns null for an unknown name", async () => {
        const svc = build([sampleCalendar({ pluginId: "ms365", name: "Work" })]);
        assert.equal(await svc.resolveCalendarRef("Home"), null);
    });

    it("matches a unique unprefixed name", async () => {
        const svc = build([sampleCalendar({ pluginId: "ms365", name: "Work" })]);
        const cal = await svc.resolveCalendarRef("Work");
        assert.equal(cal?.name, "Work");
        assert.equal(cal?.pluginId, "ms365");
    });

    it("throws on ambiguous unprefixed name across providers", async () => {
        const svc = build([
            sampleCalendar({ pluginId: "ms365", name: "Work" }),
            sampleCalendar({ pluginId: "gcal", name: "Work" }),
        ]);
        await assert.rejects(svc.resolveCalendarRef("Work"), /ambiguous/);
    });

    it("disambiguates with the pluginId prefix", async () => {
        const svc = build([
            sampleCalendar({ pluginId: "ms365", name: "Work" }),
            sampleCalendar({ pluginId: "gcal", name: "Work" }),
        ]);
        const cal = await svc.resolveCalendarRef("gcal:Work");
        assert.equal(cal?.pluginId, "gcal");
    });

    it("returns null when the qualified name doesn't match either part", async () => {
        const svc = build([sampleCalendar({ pluginId: "ms365", name: "Work" })]);
        assert.equal(await svc.resolveCalendarRef("ms365:Home"), null);
        assert.equal(await svc.resolveCalendarRef("gcal:Work"), null);
    });
});

describe("CalendarService.resolveDefaultCalendar", () => {
    it("returns null when core.defaultCalendar is unset AND no calendar is flagged default", async () => {
        const svc = build([sampleCalendar({ pluginId: "ms365", name: "Work" })], {});
        assert.equal(await svc.resolveDefaultCalendar(), null);
    });

    it("resolves the configured default", async () => {
        const svc = build([sampleCalendar({ pluginId: "ms365", name: "Work" })], {
            "core.defaultCalendar": "Work",
        });
        const cal = await svc.resolveDefaultCalendar();
        assert.equal(cal?.name, "Work");
    });

    it("falls back to the first is_default calendar when config is unset", async () => {
        const svc = build(
            [
                sampleCalendar({ id: "1", pluginId: "ms365", name: "Other", isDefault: false }),
                sampleCalendar({ id: "2", pluginId: "ms365", name: "Kalender", isDefault: true }),
            ],
            {},
        );
        const cal = await svc.resolveDefaultCalendar();
        assert.equal(cal?.name, "Kalender");
    });
});

function build(
    rows: readonly CalendarRow[],
    configMap: Record<string, string> = {},
): CalendarService {
    const store: Partial<CalendarStore> = {
        listCalendars: async () => rows,
    };
    return new CalendarService({
        store: store as CalendarStore,
        registry: new CalendarRegistry(),
        events: (async () => ({}) as unknown) as () => Promise<EventBus>,
        config: stubConfig(configMap),
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
