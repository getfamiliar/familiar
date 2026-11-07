import {
    type AvatarConfig,
    findAvatarConfigProblems,
    firstMenuRoute,
    normalizeAvatarConfig,
    type WebAssistantIdentity,
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

/** Data from the core the app shell shows: identity, version and menu, read per request. */
export interface ShellSource {
    /** Version of the running familiar host. */
    readonly familiarVersion: string;
    /** The assistant's name and avatar (`core.assistantName` / `core.assistantAvatar`). */
    readonly assistant: WebAssistantIdentity;
    /**
     * Store the assistant's avatar in `core.assistantAvatar`.
     *
     * @param avatar A complete, valid avatar.
     */
    saveAssistantAvatar(avatar: AvatarConfig): Promise<void>;
    /** The plugins' menu items, sorted. */
    listMenuItems(): readonly WebMenuEntry[];
    /** The plugin pages. */
    listPages(): readonly WebPageEntry[];
}

/** Renders the login-flow pages the core webserver asks for. */
export interface AuthPageSource {
    renderAuthPage(view: WebAuthPageView, assistant: WebAssistantIdentity): Promise<string>;
}

/**
 * Assemble what the plugin's `webUi` hook hands the core.
 *
 * @param assets Page / asset handler.
 * @param authPages Login-page renderer.
 * @param shell Identity, version and menu from the core.
 * @returns Root controller plus login-page renderer.
 */
export function buildWebUi(
    assets: UiAssetHandler,
    authPages: AuthPageSource,
    shell: ShellSource,
): WebUi {
    return {
        controller: buildWebUiController(assets, shell),
        renderAuthPage: (view) => authPages.renderAuthPage(view, shell.assistant),
    };
}

/**
 * Build the web UI's root controller: `GET /` opens the first menu
 * route (stays on the start page when the menu is empty), the JSON API
 * lives under `/api`, and every other path is the UI itself (Vite in dev
 * mode, the built bundle otherwise). `PUT /api/settings/avatar` stores the
 * assistant's avatar. Authentication (and the same-origin check for
 * writes) happened in the core webserver before any of these routes run.
 *
 * @param assets Page / asset handler.
 * @param shell Identity, version and menu from the core.
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
            assistant: shell.assistant,
            version: shell.familiarVersion,
            menu: shell.listMenuItems(),
            pages: shell.listPages(),
        });
    });
    app.put("/api/settings/avatar", async (c) => {
        let body: unknown;
        try {
            body = await c.req.json();
        } catch {
            return c.json({ error: "the request body is not JSON" }, 400);
        }
        const problems =
            typeof body === "object" && body !== null
                ? findAvatarConfigProblems(body)
                : ["must be a mapping of avatar options"];
        if (problems.length > 0) {
            return c.json({ error: `invalid avatar: ${problems.join("; ")}`, problems }, 400);
        }
        const avatar = normalizeAvatarConfig(body);
        await shell.saveAssistantAvatar(avatar);
        return c.json({ avatar });
    });
    app.all("/api/*", (c) =>
        c.json({ error: `unknown API route ${c.req.method} ${c.req.path}` }, 404),
    );
    app.all("*", (c) => assets.handle(c));
    return app;
}
