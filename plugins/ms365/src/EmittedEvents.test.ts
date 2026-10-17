import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { ConfigService, HostContext } from "@getfamiliar/shared";
import { listMs365EmittedEvents } from "./EmittedEvents.js";

/**
 * Minimal {@link HostContext} whose config answers `overrides[key]` and
 * otherwise the caller's default.
 *
 * @param overrides Dotted config keys with the value to return.
 * @returns A context exposing only `config`.
 */
function contextWith(overrides: Readonly<Record<string, unknown>>): HostContext {
    const read = (key: string, defaultValue?: unknown): unknown =>
        key in overrides ? overrides[key] : defaultValue;
    const config = new Proxy({}, { get: () => read }) as ConfigService;
    return { config } as unknown as HostContext;
}

/**
 * Topics of {@link listMs365EmittedEvents} under the given overrides.
 *
 * @param overrides Dotted config keys with the value to return.
 * @returns The declared topics in order.
 */
function topicsWith(overrides: Readonly<Record<string, unknown>>): string[] {
    return listMs365EmittedEvents(contextWith(overrides)).map((d) => d.topic);
}

describe("listMs365EmittedEvents", () => {
    it("declares mail and calendar topics on defaults", () => {
        assert.deepEqual(topicsWith({}), [
            "mail:new:ms365",
            "calendar:new:ms365",
            "calendar:update:ms365",
            "calendar:delete:ms365",
        ]);
    });

    it("omits the mail topic when mail or its poller is off", () => {
        assert.ok(!topicsWith({ "ms365.mail.enabled": false }).includes("mail:new:ms365"));
        assert.ok(!topicsWith({ "ms365.mail.polling": false }).includes("mail:new:ms365"));
    });

    it("omits the calendar topics when the calendar is off", () => {
        assert.deepEqual(topicsWith({ "ms365.calendar.enabled": false }), ["mail:new:ms365"]);
    });
});
