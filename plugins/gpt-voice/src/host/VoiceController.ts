import type { WebUiEnv } from "@getfamiliar/shared";
import { type Context, Hono } from "hono";
import type { VoiceService } from "./VoiceService.js";

/** Serves the built page module (`build/page`). */
export interface PageAssetHandler {
    handle(c: Context): Promise<Response>;
}

/**
 * The voice plugin's HTTP routes, mounted by the core at
 * `/plugins/gpt-voice` behind its authentication. Concrete routes only —
 * the page's browser routes fall through to the web UI. (The call itself
 * runs over the plugin socket, not here.)
 *
 * - `GET /api/status` — {@link VoiceStatus}: is a key configured, is the request HTTPS
 * - `GET /page/*` — the page module
 *
 * @param service Resolves the running service per request (it changes on restart).
 * @param page Static handler for the built page.
 * @returns The controller.
 */
export function buildVoiceController(
    service: () => VoiceService,
    page: PageAssetHandler,
): Hono<WebUiEnv> {
    const app = new Hono<WebUiEnv>();
    app.get("/api/status", (c) => c.json(service().status(c.get("isHttps"))));
    app.get("/page/*", (c) => page.handle(c));
    return app;
}
