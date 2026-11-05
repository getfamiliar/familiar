import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { contentTypeForFile, type WebUiEnv } from "@getfamiliar/shared";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import type { ChatUpload } from "./ChatFiles.js";
import { type ChatDownload, type ChatHub, ChatInputError, MAX_HISTORY_PAGE } from "./ChatHub.js";
import { type ChatServerEvent, MAX_UPLOAD_BYTES } from "./ChatProtocol.js";

/** Room for the multipart framing and the text on top of the attachments. */
const BODY_OVERHEAD_BYTES = 1024 * 1024;

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
 * - `POST /api/messages` — send a line: JSON `{ text }`, or `multipart/form-data`
 *   with `text` and any number of `files` (`{ eventId }`, or 400 / 413 `{ error }`)
 * - `GET  /api/files/:eventId/:name` — download a file of an event's scratch folder
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

    app.post(
        "/api/messages",
        bodyLimit({
            maxSize: MAX_UPLOAD_BYTES + BODY_OVERHEAD_BYTES,
            onError: (c) =>
                c.json(
                    {
                        error: `the message is too large; at most ${MAX_UPLOAD_BYTES / 1024 / 1024} MB of attachments`,
                    },
                    413,
                ),
        }),
        async (c) => {
            const input = await readSendInput(c);
            if ("error" in input) {
                return c.json({ error: input.error }, 400);
            }
            try {
                return c.json({ eventId: await hub().send(input.text, input.uploads) }, 202);
            } catch (err) {
                if (err instanceof ChatInputError) {
                    return c.json({ error: err.message }, 400);
                }
                throw err;
            }
        },
    );

    app.get("/api/files/:eventId/:name", async (c) => {
        const file = await hub().download(c.req.param("eventId"), c.req.param("name"));
        if (file === null) {
            return c.json({ error: "no such file" }, 404);
        }
        return sendDownload(file);
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

/**
 * Read the text and attachments of a send request (JSON or multipart).
 *
 * @param c Request context.
 * @returns The input, or an error message for a malformed request.
 */
async function readSendInput(
    c: Context<WebUiEnv>,
): Promise<{ text: string; uploads: ChatUpload[] } | { error: string }> {
    const contentType = c.req.header("content-type") ?? "";
    if (contentType.startsWith("multipart/form-data")) {
        let body: Record<string, unknown>;
        try {
            body = await c.req.parseBody({ all: true });
        } catch {
            return { error: "malformed multipart body" };
        }
        const text = typeof body.text === "string" ? body.text : "";
        const rawFiles = body.files === undefined ? [] : [body.files].flat();
        const uploads: ChatUpload[] = [];
        for (const file of rawFiles) {
            if (!(file instanceof File)) {
                return { error: "files must be file parts" };
            }
            uploads.push({ name: file.name, contents: Buffer.from(await file.arrayBuffer()) });
        }
        return { text, uploads };
    }
    let text: unknown;
    try {
        text = ((await c.req.json()) as { text?: unknown }).text;
    } catch {
        return { error: "expected a JSON body { text } or multipart/form-data" };
    }
    if (typeof text !== "string") {
        return { error: "text must be a string" };
    }
    return { text, uploads: [] };
}

/**
 * Stream a scratch file. Only raster images are shown inline; everything
 * else is a download, served with `nosniff` and a sandboxing CSP, so a
 * file the assistant or the user put there (HTML, SVG, …) can never run
 * as a page of this origin.
 *
 * @param file The file.
 * @returns The response (404 when it vanished meanwhile).
 */
async function sendDownload(file: ChatDownload): Promise<Response> {
    let size: number;
    try {
        size = (await stat(file.path)).size;
    } catch {
        return new Response(JSON.stringify({ error: "no such file" }), {
            status: 404,
            headers: { "content-type": "application/json" },
        });
    }
    const disposition = file.isInline ? "inline" : "attachment";
    const asciiName = file.name.replace(/[^\x20-\x7e]|["\\]/g, "_");
    const stream = Readable.toWeb(createReadStream(file.path)) as ReadableStream<Uint8Array>;
    return new Response(stream, {
        status: 200,
        headers: {
            "content-type": file.isInline
                ? contentTypeForFile(file.name)
                : "application/octet-stream",
            "content-length": String(size),
            "content-disposition": `${disposition}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
            "x-content-type-options": "nosniff",
            "content-security-policy": "default-src 'none'; sandbox",
            "cache-control": "private, max-age=3600",
        },
    });
}
