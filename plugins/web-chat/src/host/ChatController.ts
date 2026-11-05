import type { WebUiEnv } from "@getfamiliar/shared";
import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { type ChatHub, ChatInputError, MAX_HISTORY_PAGE } from "./ChatHub.js";
import type { ChatServerEvent } from "./ChatProtocol.js";

/** Default history page size. */
const DEFAULT_HISTORY_PAGE = 50;

/** Interval of SSE keep-alive comments (proxies drop idle connections). */
const KEEP_ALIVE_MS = 25_000;

/** Serves the built page module (`build/page`). */
export interface PageAssetHandler {
    handle(c: Context): Promise<Response>;
}

/**
 * The web-chat controller, mounted by the core at `/plugins/web-chat`
 * behind its authentication. Concrete routes only — the page's browser
 * routes (`/plugins/web-chat`) fall through to the web UI.
 *
 * - `GET  /api/messages?before=<id>&limit=<n>` — history page of the web channel
 * - `POST /api/messages` `{ text }` — send a line (`{ eventId }`, or 400 `{ error }`)
 * - `GET  /api/handlers` — slash paths for autocompletion
 * - `GET  /api/events` — server-sent events (`snapshot`, `message`, `turn`)
 * - `GET  /page/*` — the page module
 *
 * @param hub The chat hub (resolved per request, so a restart swaps it).
 * @param page Static handler for the built page.
 * @returns The controller.
 */
export function buildChatController(hub: () => ChatHub, page: PageAssetHandler): Hono<WebUiEnv> {
    const app = new Hono<WebUiEnv>();

    app.get("/api/messages", async (c) => {
        const before = c.req.query("before");
        const limit = Number(c.req.query("limit") ?? DEFAULT_HISTORY_PAGE);
        if (before !== undefined && !/^\d+$/.test(before)) {
            return c.json({ error: "before must be a message id" }, 400);
        }
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HISTORY_PAGE) {
            return c.json({ error: `limit must be between 1 and ${MAX_HISTORY_PAGE}` }, 400);
        }
        return c.json(await hub().history(before, limit));
    });

    app.post("/api/messages", async (c) => {
        let text: unknown;
        try {
            text = ((await c.req.json()) as { text?: unknown }).text;
        } catch {
            return c.json({ error: "expected a JSON body { text }" }, 400);
        }
        if (typeof text !== "string") {
            return c.json({ error: "text must be a string" }, 400);
        }
        try {
            return c.json({ eventId: await hub().send(text) }, 202);
        } catch (err) {
            if (err instanceof ChatInputError) {
                return c.json({ error: err.message }, 400);
            }
            throw err;
        }
    });

    app.get("/api/handlers", async (c) => c.json(await hub().handlerPaths()));

    app.get("/api/events", (c) =>
        streamSSE(c, async (stream) => {
            // Serialize writes: hub events and keep-alives must not interleave.
            let queue = Promise.resolve();
            const send = (event: ChatServerEvent): void => {
                queue = queue
                    .then(() => stream.writeSSE({ event: event.type, data: JSON.stringify(event) }))
                    .catch(() => stream.abort());
            };
            const disconnect = hub().addClient(send);
            stream.onAbort(disconnect);
            while (!stream.aborted && !stream.closed) {
                await stream.sleep(KEEP_ALIVE_MS);
                queue = queue
                    .then(() => stream.write(": keep-alive\n\n"))
                    .then(
                        () => undefined,
                        () => stream.abort(),
                    );
            }
            disconnect();
        }),
    );

    app.get("/page/*", (c) => page.handle(c));
    return app;
}
