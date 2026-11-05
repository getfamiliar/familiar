import { readFile, stat } from "node:fs/promises";
import path from "node:path";
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
    ".wasm": "application/wasm",
    ".webmanifest": "application/manifest+json",
    ".avif": "image/avif",
    ".pdf": "application/pdf",
    ".csv": "text/csv; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".xml": "application/xml",
    ".zip": "application/zip",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".wav": "audio/wav",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".ics": "text/calendar; charset=utf-8",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/**
 * Content type for a file name, by extension.
 *
 * @param fileName File name or path.
 * @returns The media type, `application/octet-stream` when unknown.
 */
export function contentTypeForFile(fileName: string): string {
    return CONTENT_TYPES[path.extname(fileName).toLowerCase()] ?? "application/octet-stream";
}

/** Options of {@link WebStaticAssets}. */
export interface WebStaticAssetsOptions {
    /**
     * URL prefix the directory is served under (e.g. `/plugins/web-chat/page`);
     * stripped from the request path before mapping it onto a file.
     * Default: the site root.
     */
    readonly urlPrefix?: string;
    /**
     * Answer unknown GET paths without a file extension with `index.html`,
     * so client-side routes of a single-page app survive a reload.
     */
    readonly spaFallback: boolean;
    /** Hint added to the 500 answer when the directory was never built (e.g. "run `npm run build` in plugins/web-chat"). */
    readonly missingBuildHint?: string;
}

/** Vite puts content-hashed bundles here; they never change under the same name. */
const HASHED_ASSETS_DIR = "assets/";

/**
 * Serve a directory of built web assets (a Vite build output) from a
 * Hono route, for web UI plugins and plugin pages.
 *
 * A request path maps onto a file below the directory; paths escaping it
 * are refused. Files under `assets/` (content-hashed) are cached forever,
 * everything else is revalidated (`no-cache`).
 */
export class WebStaticAssets {
    private readonly rootDir: string;
    private readonly options: WebStaticAssetsOptions;

    /**
     * @param rootDir Absolute path of the build output.
     * @param options URL prefix, SPA fallback, build hint.
     */
    constructor(rootDir: string, options: WebStaticAssetsOptions) {
        this.rootDir = path.resolve(rootDir);
        this.options = options;
    }

    /**
     * Answer one request.
     *
     * @param c Request context.
     * @returns The file, the SPA fallback, 404, or a 500 page when the
     *   directory was never built.
     */
    async handle(c: Context): Promise<Response> {
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
        if (!this.options.spaFallback || path.extname(requested) !== "") {
            return (await isDirectory(this.rootDir)) ? c.notFound() : this.missingBuild(c);
        }
        const indexFile = path.join(this.rootDir, "index.html");
        if (!(await isFile(indexFile))) {
            return this.missingBuild(c);
        }
        return this.sendFile(c, indexFile);
    }

    /**
     * The 500 answer for a directory that was never built.
     *
     * @param c Request context.
     * @returns The response.
     */
    private missingBuild(c: Context): Response {
        const hint = this.options.missingBuildHint ?? "build the package";
        return c.text(`the web assets in ${this.rootDir} are missing — ${hint}`, 500);
    }

    /**
     * Map a URL path onto a file path below {@link rootDir}.
     *
     * @param urlPath Request path.
     * @returns The absolute file path, or null when it lies outside the
     *   prefix, escapes the directory or is not decodable.
     */
    private resolveRequestPath(urlPath: string): string | null {
        const prefix = (this.options.urlPrefix ?? "").replace(/\/+$/, "");
        if (prefix !== "" && urlPath !== prefix && !urlPath.startsWith(`${prefix}/`)) {
            return null;
        }
        let decoded: string;
        try {
            decoded = decodeURIComponent(urlPath.slice(prefix.length));
        } catch {
            return null;
        }
        if (decoded.includes("\0")) {
            return null;
        }
        // The root resolves to the directory itself, which takes the SPA fallback.
        const relative = decoded.replace(/^\/+/, "");
        const resolved = path.resolve(this.rootDir, relative);
        if (resolved !== this.rootDir && !resolved.startsWith(this.rootDir + path.sep)) {
            return null;
        }
        return resolved;
    }

    /**
     * Send one file with content type and cache headers.
     *
     * @param c Request context.
     * @param file Absolute file path below the root.
     * @returns The response.
     */
    private async sendFile(c: Context, file: string): Promise<Response> {
        const body = await readFile(file);
        const relative = path.relative(this.rootDir, file).split(path.sep).join("/");
        const cacheControl = relative.startsWith(HASHED_ASSETS_DIR)
            ? "public, max-age=31536000, immutable"
            : "no-cache";
        return new Response(c.req.method === "HEAD" ? null : new Uint8Array(body), {
            status: 200,
            headers: {
                "content-type": contentTypeForFile(file),
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
 * @throws {Error} For errors other than "does not exist".
 */
async function isFile(file: string): Promise<boolean> {
    try {
        return (await stat(file)).isFile();
    } catch (err) {
        if (isMissing(err)) {
            return false;
        }
        throw err;
    }
}

/**
 * Whether `dir` exists and is a directory.
 *
 * @param dir Absolute path.
 * @returns True for a directory.
 * @throws {Error} For errors other than "does not exist".
 */
async function isDirectory(dir: string): Promise<boolean> {
    try {
        return (await stat(dir)).isDirectory();
    } catch (err) {
        if (isMissing(err)) {
            return false;
        }
        throw err;
    }
}

/**
 * Whether a fs error means "path does not exist".
 *
 * @param err The error.
 * @returns True for ENOENT / ENOTDIR.
 */
function isMissing(err: unknown): boolean {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR";
}
