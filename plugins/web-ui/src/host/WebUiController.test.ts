import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { WebUiEnv } from "@getfamiliar/shared";
import { Hono } from "hono";
import { buildWebUiController } from "./WebUiController.js";

/**
 * Mount the controller below a stand-in for the core auth middleware.
 *
 * @returns The app.
 */
function mounted(): Hono<WebUiEnv> {
    const app = new Hono<WebUiEnv>();
    app.use(async (c, next) => {
        c.set("principal", { login: "me@example.com", displayName: "Jürgen Weiß", via: "session" });
        await next();
    });
    app.route("/", buildWebUiController({ handle: async (c) => c.text(`asset ${c.req.path}`) }));
    return app;
}

describe("buildWebUiController", () => {
    it("answers /api/me with the principal the core resolved", async () => {
        const res = await mounted().request("/api/me");
        assert.deepEqual(await res.json(), {
            login: "me@example.com",
            displayName: "Jürgen Weiß",
            via: "session",
        });
    });

    it("404s unknown API routes as JSON and hands everything else to the assets", async () => {
        const app = mounted();
        const unknown = await app.request("/api/nope", { method: "POST" });
        assert.equal(unknown.status, 404);
        assert.match((await unknown.json()).error, /POST \/api\/nope/);
        assert.equal(await (await app.request("/settings")).text(), "asset /settings");
    });
});
