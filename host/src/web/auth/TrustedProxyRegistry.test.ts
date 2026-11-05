import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { TrustedProxyRegistry } from "./TrustedProxyRegistry.js";

const SECRET_A = "a".repeat(32);
const SECRET_B = "b".repeat(32);

describe("TrustedProxyRegistry", () => {
    it("matches config and plugin proxies by secret", () => {
        const registry = new TrustedProxyRegistry();
        registry.setConfigProxies([
            { id: "config:authelia", secret: SECRET_A, userHeader: "Remote-User" },
        ]);
        registry.registerPluginProxy("tailscale", {
            secret: SECRET_B,
            userHeader: "Tailscale-User-Login",
        });
        assert.equal(registry.match(SECRET_A)?.id, "config:authelia");
        assert.equal(registry.match(SECRET_B)?.id, "plugin:tailscale");
        assert.equal(registry.match("c".repeat(32)), null);
        assert.equal(registry.match(""), null);
        assert.deepEqual(registry.listIds(), ["config:authelia", "plugin:tailscale"]);
    });

    it("rejects short secrets, empty user headers and double registration", () => {
        const registry = new TrustedProxyRegistry();
        assert.throws(
            () => registry.registerPluginProxy("x", { secret: "short", userHeader: "U" }),
            /at least 32 characters/,
        );
        assert.throws(
            () => registry.registerPluginProxy("x", { secret: SECRET_A, userHeader: " " }),
            /userHeader must not be empty/,
        );
        registry.registerPluginProxy("x", { secret: SECRET_A, userHeader: "U" });
        assert.throws(
            () => registry.registerPluginProxy("x", { secret: SECRET_B, userHeader: "U" }),
            /already registered/,
        );
    });

    it("forgets a plugin's proxy on unregister and config proxies on replace", () => {
        const registry = new TrustedProxyRegistry();
        registry.setConfigProxies([{ id: "config:a", secret: SECRET_A, userHeader: "U" }]);
        registry.registerPluginProxy("tailscale", { secret: SECRET_B, userHeader: "U" });
        registry.unregisterPlugin("tailscale");
        registry.setConfigProxies([]);
        assert.equal(registry.match(SECRET_A), null);
        assert.equal(registry.match(SECRET_B), null);
        registry.registerPluginProxy("tailscale", { secret: SECRET_B, userHeader: "U" });
        assert.equal(registry.match(SECRET_B)?.id, "plugin:tailscale");
    });
});
