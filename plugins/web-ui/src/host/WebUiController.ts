import type { WebAuthPageView, WebUi, WebUiEnv } from "@getfamiliar/shared";
import { type Context, Hono } from "hono";

/** Serves everything that is not an API route: the UI pages and their assets. */
export interface UiAssetHandler {
    handle(c: Context<WebUiEnv>): Promise<Response>;
}

/** Renders the login-flow pages the core webserver asks for. */
export interface AuthPageSource {
    renderAuthPage(view: WebAuthPageView): Promise<string>;
}

/**
 * Assemble what the plugin's `webUi` hook hands the core.
 *
 * @param assets Page / asset handler.
 * @param authPages Login-page renderer.
 * @returns Root controller plus login-page renderer.
 */
export function buildWebUi(assets: UiAssetHandler, authPages: AuthPageSource): WebUi {
    return {
        controller: buildWebUiController(assets),
        renderAuthPage: (view) => authPages.renderAuthPage(view),
    };
}

/**
 * Build the web UI's root controller: the JSON API under `/api` and,
 * for every other path, the UI itself (Vite in dev mode, the built
 * bundle otherwise). Authentication happened in the core webserver
 * before any of these routes run.
 *
 * @param assets Page / asset handler.
 * @returns The Hono app the plugin's `webUi` hook returns.
 */
export function buildWebUiController(assets: UiAssetHandler): Hono<WebUiEnv> {
    const app = new Hono<WebUiEnv>();
    app.get("/api/me", (c) => {
        const { login, displayName, via } = c.get("principal");
        return c.json({ login, displayName, via });
    });
    app.all("/api/*", (c) =>
        c.json({ error: `unknown API route ${c.req.method} ${c.req.path}` }, 404),
    );
    app.all("*", (c) => assets.handle(c));
    return app;
}
