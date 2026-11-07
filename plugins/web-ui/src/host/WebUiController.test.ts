import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { WebMenuEntry, WebUiEnv } from "@getfamiliar/shared";
import { Hono } from "hono";
import { buildWebUi, buildWebUiController, type ShellSource } from "./WebUiController.js";

/** Asset handler that names the path it was asked for. */
const ASSETS = {
    handle: async (c: { req: { path: string }; text: (t: string) => Response }) =>
        c.text(`asset ${c.req.path}`),
};

/**
 * A shell source with a fixed menu.
 *
 * @param menu Menu items.
 * @returns The source.
 */
function shellWith(menu: WebMenuEntry[]): ShellSource {
    return {
        familiarVersion: "1.2.3",
        assistantName: "Jeeves",
        listMenuItems: () => menu,
        listPages: () => [],
    };
}

/**
 * Mount the controller below a stand-in for the core auth middleware.
 *
 * @param shell Version and menu.
 * @returns The app.
 */
function mounted(shell: ShellSource = shellWith([])): Hono<WebUiEnv> {
    const app = new Hono<WebUiEnv>();
    app.use(async (c, next) => {
        c.set("principal", { login: "me@example.com", displayName: "Jürgen Weiß", via: "session" });
        await next();
    });
    app.route("/", buildWebUiController(ASSETS as never, shell));
    return app;
}

describe("buildWebUiController", () => {
    it("answers /api/shell with the principal, the name, the version and the menu", async () => {
        const menu: WebMenuEntry[] = [
            { pluginId: "mail", icon: "mail", label: "Mail", route: "/mail" },
        ];
        const res = await mounted(shellWith(menu)).request("/api/shell");
        assert.deepEqual(await res.json(), {
            user: { login: "me@example.com", displayName: "Jürgen Weiß", via: "session" },
            assistantName: "Jeeves",
            version: "1.2.3",
            menu,
            pages: [],
        });
    });

    it("opens the first menu route on /, and the start page without a menu", async () => {
        const empty = await mounted().request("/");
        assert.equal(await empty.text(), "asset /");

        const withMenu = mounted(
            shellWith([
                {
                    pluginId: "mail",
                    icon: "mail",
                    label: "Mail",
                    children: [{ label: "Inbox", route: "/mail/inbox" }],
                },
                { pluginId: "chat", icon: "message-circle", label: "Chat", route: "/chat" },
            ]),
        );
        const redirect = await withMenu.request("/");
        assert.equal(redirect.status, 302);
        assert.equal(redirect.headers.get("location"), "/mail/inbox");
        assert.equal(await (await withMenu.request("/mail/inbox")).text(), "asset /mail/inbox");
    });

    it("404s unknown API routes as JSON and hands everything else to the assets", async () => {
        const app = mounted();
        const unknown = await app.request("/api/nope", { method: "POST" });
        assert.equal(unknown.status, 404);
        assert.match((await unknown.json()).error, /POST \/api\/nope/);
        assert.equal(await (await app.request("/settings")).text(), "asset /settings");
    });

    it("hands the core the controller and the login-page renderer", async () => {
        const ui = buildWebUi(
            ASSETS as never,
            { renderAuthPage: async (view, name) => `rendered ${view.kind} for ${name}` },
            shellWith([]),
        );
        assert.equal(await (await ui.controller.request("/x")).text(), "asset /x");
        assert.equal(
            await ui.renderAuthPage?.({ kind: "signedOut", loginCommand: "familiar web login" }),
            "rendered signedOut for Jeeves",
        );
    });
});
