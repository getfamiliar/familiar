import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { WebUiEnv } from "@getfamiliar/shared";
import type { Context } from "hono";

/** Content types of the files a Vite build emits. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".txt": "text/plain; charset=utf-8",
    ".webmanifest": "application/manifest+json",
};

/** Vite puts content-hashed bundles here; they never change under the same name. */
const HASHED_ASSETS_PREFIX = "/assets/";

/**
 * Serve the production client bundle (`build/client`) of the web UI.
 *
 * A request path maps onto a file below `clientDir`; paths escaping it
 * are refused. Unknown paths of GET requests that do not look like a
 * file (no extension) get `index.html`, so client-side routes survive a
 * reload (SPA fallback). Hashed bundles under `/assets/` are cached
 * forever, `index.html` never.
 */
export class StaticAssets {
    private readonly clientDir: string;

    /**
     * @param clientDir Absolute path of the Vite build output.
     */
    constructor(clientDir: string) {
        this.clientDir = path.resolve(clientDir);
    }

    /**
     * Answer one request.
     *
     * @param c Request context.
     * @returns The file, the SPA fallback, 404, or a 500 page when the bundle was never built.
     */
    async handle(c: Context<WebUiEnv>): Promise<Response> {
        if (c.req.method !== "GET" && c.req.method !== "HEAD") {
            return c.notFound();
        }
        const requested = this.resolveRequestPath(c.req.path);
        if (requested === null) {
            return c.notFound();
        }
        if (await isFile(requested)) {
            return this.sendFile(c, requested);
        }
        if (path.extname(requested) !== "") {
            return c.notFound();
        }
        const indexFile = path.join(this.clientDir, "index.html");
        if (!(await isFile(indexFile))) {
            return c.text(
                `web-ui: the client bundle is missing (${indexFile}) — run \`npm run build\` in plugins/web-ui`,
                500,
            );
        }
        return this.sendFile(c, indexFile);
    }

    /**
     * Map a URL path onto a file path below {@link clientDir}.
     *
     * @param urlPath Request path (`/assets/index-abc.js`).
     * @returns The absolute file path, or null when it escapes the
     *   client dir or is not decodable.
     */
    private resolveRequestPath(urlPath: string): string | null {
        let decoded: string;
        try {
            decoded = decodeURIComponent(urlPath);
        } catch {
            return null;
        }
        if (decoded.includes("\0")) {
            return null;
        }
        // `/` resolves to the client dir itself, which takes the SPA fallback.
        const relative = decoded.replace(/^\/+/, "");
        const resolved = path.resolve(this.clientDir, relative);
        if (resolved !== this.clientDir && !resolved.startsWith(this.clientDir + path.sep)) {
            return null;
        }
        return resolved;
    }

    /**
     * Send one file with content type and cache headers.
     *
     * @param c Request context.
     * @param file Absolute file path below the client dir.
     * @returns The response.
     */
    private async sendFile(c: Context<WebUiEnv>, file: string): Promise<Response> {
        const body = await readFile(file);
        const relative = `/${path.relative(this.clientDir, file).split(path.sep).join("/")}`;
        const cacheControl = relative.startsWith(HASHED_ASSETS_PREFIX)
            ? "public, max-age=31536000, immutable"
            : "no-cache";
        return new Response(c.req.method === "HEAD" ? null : new Uint8Array(body), {
            status: 200,
            headers: {
                "content-type":
                    CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
                "cache-control": cacheControl,
            },
        });
    }
}

/**
 * Whether `file` exists and is a regular file.
 *
 * @param file Absolute path.
 * @returns True for a regular file.
 */
async function isFile(file: string): Promise<boolean> {
    try {
        return (await stat(file)).isFile();
    } catch (err) {
        if (
            (err as NodeJS.ErrnoException).code === "ENOENT" ||
            (err as NodeJS.ErrnoException).code === "ENOTDIR"
        ) {
            return false;
        }
        throw err;
    }
}
