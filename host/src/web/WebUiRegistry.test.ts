import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { WebUiEnv } from "@getfamiliar/shared";
import { Hono } from "hono";
import { WebUiRegistry } from "./WebUiRegistry.js";

describe("WebUiRegistry", () => {
    it("selects nothing, the only provider, or reports ambiguity", () => {
        const registry = new WebUiRegistry();
        assert.deepEqual(registry.select(undefined), { kind: "none" });

        const one = new Hono<WebUiEnv>();
        registry.set("one", one);
        assert.deepEqual(registry.select(undefined), {
            kind: "selected",
            pluginId: "one",
            app: one,
        });

        registry.set("two", new Hono<WebUiEnv>());
        assert.deepEqual(registry.select(undefined), {
            kind: "ambiguous",
            available: ["one", "two"],
        });
    });

    it("honours a preferred plugin id and reports when it provides nothing", () => {
        const registry = new WebUiRegistry();
        const two = new Hono<WebUiEnv>();
        registry.set("one", new Hono<WebUiEnv>());
        registry.set("two", two);
        assert.deepEqual(registry.select("two"), { kind: "selected", pluginId: "two", app: two });
        assert.deepEqual(registry.select("three"), {
            kind: "notProvided",
            preferredId: "three",
            available: ["one", "two"],
        });
    });

    it("notifies listeners on changes only, until unsubscribed", () => {
        const registry = new WebUiRegistry();
        let calls = 0;
        const unsubscribe = registry.onChange(() => {
            calls++;
        });
        registry.set("one", new Hono<WebUiEnv>());
        registry.unregisterPlugin("one");
        registry.unregisterPlugin("one");
        assert.equal(calls, 2);
        unsubscribe();
        registry.set("one", new Hono<WebUiEnv>());
        assert.equal(calls, 2);
    });
});
