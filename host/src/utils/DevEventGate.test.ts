import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { ConfigService } from "@getfamiliar/shared";
import { isEventEmissionAllowed } from "./DevEventGate.js";

/**
 * Minimal config stub: `getBool` answers from `bools`, falling back to
 * the caller's default like the real service does for missing keys.
 */
function stubConfig(bools: Record<string, boolean>): ConfigService {
    return {
        getBool: ((key: string, def?: unknown) => bools[key] ?? def) as ConfigService["getBool"],
    } as ConfigService;
}

describe("isEventEmissionAllowed", () => {
    it("always allows outside dev mode", () => {
        assert.equal(isEventEmissionAllowed(stubConfig({}), "mail", false), true);
        assert.equal(
            isEventEmissionAllowed(
                stubConfig({ "calendar.emitEventsInDev": false }),
                "calendar",
                false,
            ),
            true,
        );
    });

    it("blocks in dev mode when the flag is unset", () => {
        assert.equal(isEventEmissionAllowed(stubConfig({}), "mail", true), false);
        assert.equal(isEventEmissionAllowed(stubConfig({}), "calendar", true), false);
    });

    it("blocks in dev mode when the flag is false", () => {
        assert.equal(
            isEventEmissionAllowed(stubConfig({ "mail.emitEventsInDev": false }), "mail", true),
            false,
        );
    });

    it("allows in dev mode when the domain's flag is true", () => {
        const config = stubConfig({ "mail.emitEventsInDev": true });
        assert.equal(isEventEmissionAllowed(config, "mail", true), true);
        assert.equal(isEventEmissionAllowed(config, "calendar", true), false);
    });
});
