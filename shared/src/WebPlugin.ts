/**
 * Plugin pages and controllers of the web UI.
 *
 * A plugin's `webPlugin(ctx)` hook returns a {@link WebPluginUi}: a Hono
 * controller the core webserver mounts at `/plugins/<plugin-id>/`
 * (behind its authentication) and, optionally, a page module the web UI
 * plugin loads into its content area for every browser route under
 * `/plugins/<plugin-id>`.
 */

import type { Hono } from "hono";
import type { WebPrincipal, WebUiEnv } from "./WebAuth.js";

/** Where a plugin page's ES module comes from. */
export interface WebPageModule {
    /**
     * Path of the built module relative to the plugin's controller mount,
     * e.g. `page/page.js` → served as `/plugins/<id>/page/page.js` by the
     * plugin's own controller.
     */
    readonly module: string;
    /**
     * Dev mode only: absolute path of the page's source entry (`.tsx`).
     * A web UI with a dev server may load it from source instead (hot
     * reload, one React); omit it in production.
     */
    readonly sourceFile?: string;
}

/** What a plugin hands the core from its `webPlugin(ctx)` hook. */
export interface WebPluginUi {
    /**
     * Controller mounted at `/plugins/<plugin-id>/`, behind the core auth
     * middleware (`c.get("principal")` is set). Register concrete routes
     * only (e.g. `/api/*`, `/page/*`) and **no catch-all**: every path the
     * controller does not match falls through to the web UI, which is how
     * the browser routes of the plugin's page (`/plugins/<id>`, …) reach it.
     */
    readonly controller: Hono<WebUiEnv>;
    /** Optional page shown by the web UI for routes under `/plugins/<plugin-id>`. */
    readonly page?: WebPageModule;
}

/** A plugin page as the core lists it for the web UI (`ctx.web.listPages()`). */
export interface WebPageEntry {
    /** Plugin providing the page. */
    readonly pluginId: string;
    /** Browser route prefix the page owns: `/plugins/<plugin-id>`. */
    readonly basePath: string;
    /** URL of the built module (`/plugins/<plugin-id>/<module>`). */
    readonly moduleUrl: string;
    /** Dev mode: absolute source entry (see {@link WebPageModule.sourceFile}). */
    readonly sourceFile?: string;
}

/** What the web UI passes to a page module's `mount`. */
export interface WebPageContext {
    /** Route prefix of the page (`/plugins/<plugin-id>`). */
    readonly basePath: string;
    /** Current browser path (at or below `basePath`). */
    readonly pathname: string;
    /** The signed-in user. */
    readonly user: WebPrincipal;
    /** Navigate the web UI to another route. */
    navigate(to: string): void;
}

/**
 * Default export of a page module: render the page into `container`
 * (the web UI's content area) and return a function that unmounts it.
 * Framework-agnostic; a React page creates its own root.
 */
export type MountWebPage = (container: HTMLElement, context: WebPageContext) => () => void;

/** Route prefix of a plugin's controller and page. */
export function webPluginBasePath(pluginId: string): string {
    return `/plugins/${pluginId}`;
}
