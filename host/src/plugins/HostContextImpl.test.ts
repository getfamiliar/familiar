import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { ConfigService, Logger, NewEvent } from "@getfamiliar/shared";
import { HostContextImpl, type HostContextImplDeps, isUsableChannelId } from "./HostContextImpl.js";

describe("isUsableChannelId", () => {
    it("accepts a non-empty string", () => {
        assert.equal(isUsableChannelId("telegram"), true);
        assert.equal(isUsableChannelId(" "), true); // whitespace counts; we don't trim
        assert.equal(isUsableChannelId("cli"), true);
    });

    it("rejects an empty string", () => {
        assert.equal(isUsableChannelId(""), false);
    });

    it("rejects null and undefined", () => {
        assert.equal(isUsableChannelId(null), false);
        assert.equal(isUsableChannelId(undefined), false);
    });

    it("rejects booleans", () => {
        assert.equal(isUsableChannelId(false), false);
        assert.equal(isUsableChannelId(true), false);
    });

    it("rejects numbers (including 0)", () => {
        assert.equal(isUsableChannelId(0), false);
        assert.equal(isUsableChannelId(42), false);
        assert.equal(isUsableChannelId(Number.NaN), false);
    });

    it("rejects objects and arrays", () => {
        assert.equal(isUsableChannelId({}), false);
        assert.equal(isUsableChannelId({ id: "telegram" }), false);
        assert.equal(isUsableChannelId(["telegram"]), false);
    });

    it("acts as a TypeScript type guard", () => {
        const candidate: unknown = "telegram";
        if (isUsableChannelId(candidate)) {
            // Compile-time assertion: inside this branch, `candidate`
            // is narrowed to `string`. The `.toUpperCase()` would not
            // typecheck against `unknown`.
            assert.equal(candidate.toUpperCase(), "TELEGRAM");
        } else {
            assert.fail("string should pass the guard");
        }
    });
});

describe("HostContextImpl ctx.mail.emitMailEvent", () => {
    const mailEvent: NewEvent = {
        topic: "mail:ms365",
        prompt: "A new e-mail was received",
        idempotencyKey: "mail:ms365:<abc@example.com>",
    };

    it("suppresses the event in dev mode when mail.emitEventsInDev is unset", async () => {
        const ctx = buildContext({ devMode: true, bools: {} });
        assert.equal(await ctx.mail.emitMailEvent(mailEvent), null);
    });

    it("delegates to the bus in dev mode when mail.emitEventsInDev is true", async () => {
        const ctx = buildContext({ devMode: true, bools: { "mail.emitEventsInDev": true } });
        await assert.rejects(ctx.mail.emitMailEvent(mailEvent), /reached the bus/);
    });

    it("delegates to the bus outside dev mode", async () => {
        const ctx = buildContext({ devMode: false, bools: {} });
        await assert.rejects(ctx.mail.emitMailEvent(mailEvent), /reached the bus/);
    });

    it("rejects non-mail topics", async () => {
        const ctx = buildContext({ devMode: false, bools: {} });
        await assert.rejects(
            ctx.mail.emitMailEvent({ ...mailEvent, topic: "calendar:new:ms365" }),
            /not a mail topic/,
        );
    });
});

/**
 * Build a context whose only live dependencies are config, logger and
 * the dev flag. `ensureConnection` throws a sentinel so a test can tell
 * "emission reached the bus" apart from "suppressed" without postgres.
 */
function buildContext(opts: { devMode: boolean; bools: Record<string, boolean> }): HostContextImpl {
    const config = {
        getBool: ((key: string, def?: unknown) =>
            opts.bools[key] ?? def) as ConfigService["getBool"],
    } as ConfigService;
    const noop = () => {};
    const log = { debug: noop, info: noop, warn: noop, error: noop } as unknown as Logger;
    const deps = {
        pluginId: "ms365",
        config,
        log,
        devMode: opts.devMode,
        ensureConnection: async () => {
            throw new Error("reached the bus");
        },
    } as unknown as HostContextImplDeps;
    return new HostContextImpl(deps);
}
