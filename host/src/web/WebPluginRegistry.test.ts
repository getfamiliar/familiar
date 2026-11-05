import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { WebUiEnv } from "@getfamiliar/shared";
import { Hono } from "hono";
import { WebPluginRegistry } from "./WebPluginRegistry.js";

describe("WebPluginRegistry", () => {
    it("lists controllers and pages sorted by plugin id", () => {
        const registry = new WebPluginRegistry();
        registry.set("web-chat", {
            controller: new Hono<WebUiEnv>(),
            page: { module: "page/page.js", sourceFile: "/src/page.tsx" },
        });
        registry.set("api-only", { controller: new Hono<WebUiEnv>() });
        assert.deepEqual(
            registry.listControllers().map((entry) => entry.pluginId),
            ["api-only", "web-chat"],
        );
        assert.deepEqual(registry.listPages(), [
            {
                pluginId: "web-chat",
                basePath: "/plugins/web-chat",
                moduleUrl: "/plugins/web-chat/page/page.js",
                sourceFile: "/src/page.tsx",
            },
        ]);
    });

    it("rejects module paths outside the plugin's mount", () => {
        const registry = new WebPluginRegistry();
        for (const module of ["../x.js", "https://evil/x.js", " "]) {
            assert.throws(
                () => registry.set("p", { controller: new Hono<WebUiEnv>(), page: { module } }),
                /must be a path relative to \/plugins\/p\//,
            );
        }
        assert.deepEqual(registry.listControllers(), []);
    });

    it("notifies on changes until unsubscribed", () => {
        const registry = new WebPluginRegistry();
        let calls = 0;
        const unsubscribe = registry.onChange(() => {
            calls++;
        });
        registry.set("p", { controller: new Hono<WebUiEnv>() });
        registry.unregisterPlugin("p");
        registry.unregisterPlugin("p");
        unsubscribe();
        registry.set("p", { controller: new Hono<WebUiEnv>() });
        assert.equal(calls, 2);
    });
});
