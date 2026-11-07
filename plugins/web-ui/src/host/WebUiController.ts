import {
    firstMenuRoute,
    type WebAuthPageView,
    type WebMenuEntry,
    type WebPageEntry,
    type WebUi,
    type WebUiEnv,
} from "@getfamiliar/shared";
import { type Context, Hono } from "hono";

/** Serves everything that is not an API route: the UI pages and their assets. */
export interface UiAssetHandler {
    handle(c: Context<WebUiEnv>): Promise<Response>;
}

/** Data from the core the app shell shows: name, version and menu, read per request. */
export interface ShellSource {
    /** Version of the running familiar host. */
    readonly familiarVersion: string;
    /** The assistant's name (`core.assistantName`, default `Familiar`). */
    readonly assistantName: string;
    /** The plugins' menu items, sorted. */
    listMenuItems(): readonly WebMenuEntry[];
    /** The plugin pages. */
    listPages(): readonly WebPageEntry[];
}

/** Renders the login-flow pages the core webserver asks for. */
export interface AuthPageSource {
    renderAuthPage(view: WebAuthPageView, assistantName: string): Promise<string>;
}

/**
 * Assemble what the plugin's `webUi` hook hands the core.
 *
 * @param assets Page / asset handler.
 * @param authPages Login-page renderer.
 * @param shell Name, version and menu from the core.
 * @returns Root controller plus login-page renderer.
 */
export function buildWebUi(
    assets: UiAssetHandler,
    authPages: AuthPageSource,
    shell: ShellSource,
): WebUi {
    return {
        controller: buildWebUiController(assets, shell),
        renderAuthPage: (view) => authPages.renderAuthPage(view, shell.assistantName),
    };
}

/**
 * Build the web UI's root controller: `GET /` opens the first menu
 * route (stays on the start page when the menu is empty), the JSON API
 * lives under `/api`, and every other path is the UI itself (Vite in dev
 * mode, the built bundle otherwise). Authentication happened in the core
 * webserver before any of these routes run.
 *
 * @param assets Page / asset handler.
 * @param shell Version and menu from the core.
 * @returns The Hono app.
 */
export function buildWebUiController(assets: UiAssetHandler, shell: ShellSource): Hono<WebUiEnv> {
    const app = new Hono<WebUiEnv>();
    app.get("/", (c) => {
        const route = firstMenuRoute(shell.listMenuItems());
        return route === null || route === "/" ? assets.handle(c) : c.redirect(route, 302);
    });
    app.get("/api/shell", (c) => {
        const { login, displayName, via } = c.get("principal");
        return c.json({
            user: { login, displayName, via },
            assistantName: shell.assistantName,
            version: shell.familiarVersion,
            menu: shell.listMenuItems(),
            pages: shell.listPages(),
        });
    });
    app.all("/api/*", (c) =>
        c.json({ error: `unknown API route ${c.req.method} ${c.req.path}` }, 404),
    );
    app.all("*", (c) => assets.handle(c));
    return app;
}
