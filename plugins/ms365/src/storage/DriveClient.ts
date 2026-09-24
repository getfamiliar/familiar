import { createWriteStream } from "node:fs";
import { open } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { GraphError, graphFetch, sleep, type TokenProvider } from "../graph/GraphHttp.js";

const GRAPH = "https://graph.microsoft.com/v1.0";

/** Files up to this size go through a single PUT; larger ones use an upload session. */
export const SIMPLE_UPLOAD_LIMIT = 4 * 1024 * 1024;
/** Upload-session chunk size; must be a multiple of 320 KiB. */
export const UPLOAD_CHUNK_BYTES = 32 * 320 * 1024;
/** How long to wait for an asynchronous copy to finish. */
const COPY_MONITOR_TIMEOUT_MS = 5 * 60 * 1000;

const ITEM_SELECT =
    "id,name,size,file,folder,package,root,parentReference,createdDateTime,lastModifiedDateTime,lastModifiedBy,eTag,webUrl,shared";

/** The subset of a Graph `driveItem` the provider reads. */
export interface GraphDriveItem {
    readonly id: string;
    readonly name: string;
    readonly size?: number;
    readonly file?: {
        readonly mimeType?: string;
        readonly hashes?: {
            readonly quickXorHash?: string;
            readonly sha1Hash?: string;
            readonly sha256Hash?: string;
        };
    };
    readonly folder?: { readonly childCount?: number };
    readonly package?: { readonly type?: string };
    readonly root?: object;
    readonly parentReference?: {
        readonly id?: string;
        readonly driveId?: string;
        readonly path?: string;
    };
    readonly createdDateTime?: string;
    readonly lastModifiedDateTime?: string;
    readonly lastModifiedBy?: { readonly user?: { readonly displayName?: string } };
    readonly eTag?: string;
    readonly webUrl?: string;
    readonly shared?: object;
}

/** The subset of a Graph `drive` the provider reads. */
export interface GraphDrive {
    readonly id: string;
    readonly name: string;
    readonly driveType?: string;
    readonly webUrl?: string;
}

/** The subset of a Graph `site`. */
export interface GraphSite {
    readonly id: string;
    readonly name?: string;
    readonly displayName?: string;
    readonly webUrl?: string;
}

/** One page of a Graph collection, with the `$skiptoken` of the next page. */
export interface GraphPage<T> {
    readonly value: readonly T[];
    readonly skipToken: string | null;
}

/**
 * Thin Microsoft Graph client for OneDrive / SharePoint drive items.
 * Speaks raw Graph shapes; the {@link Ms365StorageProvider} maps them.
 * Every call goes through {@link graphFetch} (throttling retries).
 *
 * Paging cursors are the bare `$skiptoken` value — never the full
 * `@odata.nextLink`, which embeds drive and item ids the agent must
 * not see.
 */
export class DriveClient {
    /** @param tokenProvider - Bearer token source (storage scopes). */
    constructor(private readonly tokenProvider: TokenProvider) {}

    /** `GET /me/drive`. */
    async getMyDrive(): Promise<GraphDrive> {
        return this.json<GraphDrive>("GET", `${GRAPH}/me/drive?$select=id,name,driveType,webUrl`);
    }

    /** `GET /drives/{id}`, or `null` on 404 / 400 (malformed id). */
    async getDrive(driveId: string): Promise<GraphDrive | null> {
        return this.jsonOrNull<GraphDrive>(
            `${GRAPH}/drives/${enc(driveId)}?$select=id,name,driveType,webUrl`,
            [400, 404],
        );
    }

    /** Hostname of the tenant's root SharePoint site. */
    async getRootSiteHostname(): Promise<string> {
        const site = await this.json<{ siteCollection?: { hostname?: string } }>(
            "GET",
            `${GRAPH}/sites/root?$select=siteCollection`,
        );
        const hostname = site.siteCollection?.hostname;
        if (!hostname) {
            throw new GraphError(404, `${GRAPH}/sites/root`, "tenant has no root site hostname");
        }
        return hostname;
    }

    /** `GET /sites/{hostname}:/{serverRelativePath}`, or `null` on 404. */
    async getSiteByPath(hostname: string, serverRelativePath: string): Promise<GraphSite | null> {
        const encodedPath = serverRelativePath.split("/").map(enc).join("/");
        return this.jsonOrNull<GraphSite>(
            `${GRAPH}/sites/${enc(hostname)}:/${encodedPath}?$select=id,name,displayName,webUrl`,
            [404],
        );
    }

    /** `GET /sites/root`. */
    async getRootSite(): Promise<GraphSite> {
        return this.json<GraphSite>(
            "GET",
            `${GRAPH}/sites/root?$select=id,name,displayName,webUrl`,
        );
    }

    /** Document libraries of a site. */
    async listSiteDrives(siteId: string): Promise<readonly GraphDrive[]> {
        const page = await this.json<{ value: GraphDrive[] }>(
            "GET",
            `${GRAPH}/sites/${enc(siteId)}/drives?$select=id,name,driveType,webUrl`,
        );
        return page.value;
    }

    /** Sites the user follows. */
    async listFollowedSites(): Promise<readonly GraphSite[]> {
        const page = await this.json<{ value: GraphSite[] }>(
            "GET",
            `${GRAPH}/me/followedSites?$select=id,name,displayName,webUrl`,
        );
        return page.value;
    }

    /** `GET /sites?search=` — sites the user can reach (first page). */
    async searchSites(query: string, top: number): Promise<readonly GraphSite[]> {
        const params = new URLSearchParams({ search: query, $top: String(top) });
        const page = await this.json<{ value: GraphSite[] }>(
            "GET",
            `${GRAPH}/sites?${params.toString()}`,
        );
        return page.value;
    }

    /** Root folder item of a drive. */
    async getRoot(driveId: string): Promise<GraphDriveItem> {
        return this.json<GraphDriveItem>(
            "GET",
            `${GRAPH}/drives/${enc(driveId)}/root?$select=${ITEM_SELECT}`,
        );
    }

    /** One item, or `null` on 404. */
    async getItem(driveId: string, itemId: string): Promise<GraphDriveItem | null> {
        return this.jsonOrNull<GraphDriveItem>(
            `${GRAPH}/drives/${enc(driveId)}/items/${enc(itemId)}?$select=${ITEM_SELECT}`,
            [400, 404],
        );
    }

    /** Item by absolute path (`/a/b.txt`), or `null` on 404. */
    async getItemByPath(driveId: string, path: string): Promise<GraphDriveItem | null> {
        return this.jsonOrNull<GraphDriveItem>(
            `${GRAPH}/drives/${enc(driveId)}/root:${encodePath(path)}:?$select=${ITEM_SELECT}`,
            [404],
        );
    }

    /** Child `name` of a folder, or `null` on 404. */
    async getChildByName(
        driveId: string,
        parentId: string,
        name: string,
    ): Promise<GraphDriveItem | null> {
        return this.jsonOrNull<GraphDriveItem>(
            `${GRAPH}/drives/${enc(driveId)}/items/${enc(parentId)}:/${enc(name)}:?$select=${ITEM_SELECT}`,
            [404],
        );
    }

    /** One page of a folder's children. */
    async listChildren(
        driveId: string,
        folderId: string,
        top: number,
        skipToken: string | undefined,
    ): Promise<GraphPage<GraphDriveItem>> {
        const params = new URLSearchParams({ $top: String(top), $select: ITEM_SELECT });
        if (skipToken !== undefined) {
            params.set("$skiptoken", skipToken);
        }
        return this.page(
            `${GRAPH}/drives/${enc(driveId)}/items/${enc(folderId)}/children?${params.toString()}`,
        );
    }

    /** One page of search hits, scoped to `folderId` when given. */
    async search(
        driveId: string,
        text: string,
        folderId: string | undefined,
        top: number,
        skipToken: string | undefined,
        signal?: AbortSignal,
    ): Promise<GraphPage<GraphDriveItem>> {
        const scope = folderId !== undefined ? `items/${enc(folderId)}` : "root";
        const q = enc(text.replace(/'/g, "''"));
        const params = new URLSearchParams({ $top: String(top), $select: ITEM_SELECT });
        if (skipToken !== undefined) {
            params.set("$skiptoken", skipToken);
        }
        return this.page(
            `${GRAPH}/drives/${enc(driveId)}/${scope}/search(q='${q}')?${params.toString()}`,
            signal,
        );
    }

    /**
     * Stream an item's content into `destPath`. `/content` answers with a
     * redirect to a pre-authenticated URL; fetch follows it and drops the
     * Authorization header on the cross-origin hop.
     *
     * @returns Bytes written.
     */
    async downloadTo(
        driveId: string,
        itemId: string,
        destPath: string,
        signal?: AbortSignal,
    ): Promise<number> {
        const response = await graphFetch(
            this.tokenProvider,
            "GET",
            `${GRAPH}/drives/${enc(driveId)}/items/${enc(itemId)}/content`,
            { signal, headers: { Accept: "*/*" } },
        );
        if (!response.body) {
            throw new GraphError(response.status, response.url, "download response has no body");
        }
        let bytes = 0;
        const source = Readable.fromWeb(response.body as WebReadableStream<Uint8Array>);
        source.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
        });
        await pipeline(source, createWriteStream(destPath), { signal });
        return bytes;
    }

    /**
     * Upload a host file as a new child `name` of `parentId`.
     *
     * @param conflict - Graph conflict behaviour for the name.
     */
    async uploadNew(
        driveId: string,
        parentId: string,
        name: string,
        sourcePath: string,
        size: number,
        conflict: "fail" | "rename",
        signal?: AbortSignal,
    ): Promise<GraphDriveItem> {
        const target = `${GRAPH}/drives/${enc(driveId)}/items/${enc(parentId)}:/${enc(name)}:`;
        if (size <= SIMPLE_UPLOAD_LIMIT) {
            const params = new URLSearchParams({ "@microsoft.graph.conflictBehavior": conflict });
            return this.putSmall(`${target}/content?${params.toString()}`, sourcePath, {}, signal);
        }
        const session = await this.json<{ uploadUrl: string }>(
            "POST",
            `${target}/createUploadSession`,
            {
                jsonBody: { item: { "@microsoft.graph.conflictBehavior": conflict } },
            },
        );
        return this.uploadChunks(session.uploadUrl, sourcePath, size, signal);
    }

    /**
     * Overwrite the content of an existing item, guarded by `ifMatch`
     * (its eTag) when given.
     */
    async uploadReplace(
        driveId: string,
        itemId: string,
        sourcePath: string,
        size: number,
        ifMatch: string | undefined,
        signal?: AbortSignal,
    ): Promise<GraphDriveItem> {
        const target = `${GRAPH}/drives/${enc(driveId)}/items/${enc(itemId)}`;
        const headers: Record<string, string> =
            ifMatch !== undefined ? { "If-Match": ifMatch } : {};
        if (size <= SIMPLE_UPLOAD_LIMIT) {
            return this.putSmall(`${target}/content`, sourcePath, headers, signal);
        }
        const session = await this.json<{ uploadUrl: string }>(
            "POST",
            `${target}/createUploadSession`,
            {
                headers,
                jsonBody: { item: { "@microsoft.graph.conflictBehavior": "replace" } },
            },
        );
        return this.uploadChunks(session.uploadUrl, sourcePath, size, signal);
    }

    /** Create a folder. */
    async createFolder(
        driveId: string,
        parentId: string,
        name: string,
        conflict: "fail" | "rename",
    ): Promise<GraphDriveItem> {
        return this.json<GraphDriveItem>(
            "POST",
            `${GRAPH}/drives/${enc(driveId)}/items/${enc(parentId)}/children`,
            {
                jsonBody: { name, folder: {}, "@microsoft.graph.conflictBehavior": conflict },
            },
        );
    }

    /** Move and / or rename. */
    async patchItem(
        driveId: string,
        itemId: string,
        patch: { readonly parentId?: string; readonly name?: string },
        ifMatch: string | undefined,
    ): Promise<GraphDriveItem> {
        const body: Record<string, unknown> = {};
        if (patch.parentId !== undefined) {
            body.parentReference = { id: patch.parentId };
        }
        if (patch.name !== undefined) {
            body.name = patch.name;
        }
        return this.json<GraphDriveItem>(
            "PATCH",
            `${GRAPH}/drives/${enc(driveId)}/items/${enc(itemId)}`,
            {
                jsonBody: body,
                headers: ifMatch !== undefined ? { "If-Match": ifMatch } : {},
            },
        );
    }

    /**
     * Server-side copy. Graph answers 202 with a monitor URL; poll it
     * (unauthenticated, per the docs) until the copy completes.
     *
     * @returns The id of the new item.
     */
    async copyItem(
        driveId: string,
        itemId: string,
        parentId: string,
        name: string | undefined,
        conflict: "fail" | "rename",
    ): Promise<string> {
        const params = new URLSearchParams({ "@microsoft.graph.conflictBehavior": conflict });
        const response = await graphFetch(
            this.tokenProvider,
            "POST",
            `${GRAPH}/drives/${enc(driveId)}/items/${enc(itemId)}/copy?${params.toString()}`,
            {
                jsonBody: {
                    parentReference: { driveId, id: parentId },
                    ...(name !== undefined ? { name } : {}),
                },
            },
        );
        const monitor = response.headers.get("location");
        await response.body?.cancel().catch(() => undefined);
        if (!monitor) {
            throw new GraphError(
                response.status,
                response.url,
                "copy accepted without a monitor URL",
            );
        }
        const deadline = Date.now() + COPY_MONITOR_TIMEOUT_MS;
        let delayMs = 500;
        while (Date.now() < deadline) {
            const status = await graphFetch(this.tokenProvider, "GET", monitor, {
                authenticate: false,
                redirect: "manual",
                acceptStatuses: [202, 303],
            });
            if (status.status === 303) {
                // Some tenants answer a finished copy with a redirect to the new item.
                await status.body?.cancel().catch(() => undefined);
                const match = /\/items\/([^/?]+)/.exec(status.headers.get("location") ?? "");
                if (match?.[1]) {
                    return decodeURIComponent(match[1]);
                }
                throw new GraphError(500, monitor, "copy finished without a resource id");
            }
            const json = (await status.json().catch(() => ({}))) as {
                status?: string;
                resourceId?: string;
                error?: { code?: string; message?: string };
            };
            if (json.status === "completed" && json.resourceId) {
                return json.resourceId;
            }
            if (json.status === "failed") {
                const code = json.error?.code === "nameAlreadyExists" ? 409 : 500;
                throw new GraphError(
                    code,
                    monitor,
                    JSON.stringify({ error: json.error ?? { message: "copy failed" } }),
                );
            }
            await sleep(delayMs);
            delayMs = Math.min(delayMs * 2, 5000);
        }
        throw new GraphError(504, monitor, "copy did not finish within 5 minutes");
    }

    /** Move an item to the recycle bin (Graph `DELETE` is a soft delete). */
    async deleteItem(driveId: string, itemId: string, ifMatch: string | undefined): Promise<void> {
        const response = await graphFetch(
            this.tokenProvider,
            "DELETE",
            `${GRAPH}/drives/${enc(driveId)}/items/${enc(itemId)}`,
            { headers: ifMatch !== undefined ? { "If-Match": ifMatch } : {} },
        );
        await response.body?.cancel().catch(() => undefined);
    }

    // ---- internals ----------------------------------------------------

    /** Single PUT of a small file (read fully — bounded by {@link SIMPLE_UPLOAD_LIMIT}). */
    private async putSmall(
        url: string,
        sourcePath: string,
        headers: Record<string, string>,
        signal?: AbortSignal,
    ): Promise<GraphDriveItem> {
        const { readFile } = await import("node:fs/promises");
        const bytes = await readFile(sourcePath);
        const response = await graphFetch(this.tokenProvider, "PUT", url, {
            body: bytes,
            headers: { ...headers, "Content-Type": "application/octet-stream" },
            signal,
        });
        return (await response.json()) as GraphDriveItem;
    }

    /**
     * Send a file to an upload session in {@link UPLOAD_CHUNK_BYTES}
     * chunks, reusing one buffer so memory stays bounded. On failure the
     * session is cancelled.
     */
    private async uploadChunks(
        uploadUrl: string,
        sourcePath: string,
        size: number,
        signal?: AbortSignal,
    ): Promise<GraphDriveItem> {
        const handle = await open(sourcePath, "r");
        const buffer = Buffer.alloc(Math.min(UPLOAD_CHUNK_BYTES, size));
        try {
            let offset = 0;
            while (offset < size) {
                const length = Math.min(buffer.length, size - offset);
                const { bytesRead } = await handle.read(buffer, 0, length, offset);
                if (bytesRead !== length) {
                    throw new Error(`short read from ${sourcePath} at ${offset}`);
                }
                const response = await graphFetch(this.tokenProvider, "PUT", uploadUrl, {
                    authenticate: false,
                    body: buffer.subarray(0, length),
                    headers: {
                        "Content-Length": String(length),
                        "Content-Range": `bytes ${offset}-${offset + length - 1}/${size}`,
                    },
                    signal,
                });
                offset += length;
                if (response.status === 200 || response.status === 201) {
                    return (await response.json()) as GraphDriveItem;
                }
                await response.body?.cancel().catch(() => undefined);
            }
            throw new Error("upload session ended without returning the item");
        } catch (err) {
            await graphFetch(this.tokenProvider, "DELETE", uploadUrl, {
                authenticate: false,
                acceptStatuses: [404],
            }).catch(() => undefined);
            throw err;
        } finally {
            await handle.close();
        }
    }

    private async json<T>(
        method: string,
        url: string,
        options: { readonly jsonBody?: unknown; readonly headers?: Record<string, string> } = {},
    ): Promise<T> {
        const response = await graphFetch(this.tokenProvider, method, url, options);
        return (await response.json()) as T;
    }

    private async jsonOrNull<T>(url: string, notFound: readonly number[]): Promise<T | null> {
        const response = await graphFetch(this.tokenProvider, "GET", url, {
            acceptStatuses: notFound,
        });
        if (notFound.includes(response.status)) {
            await response.body?.cancel().catch(() => undefined);
            return null;
        }
        return (await response.json()) as T;
    }

    private async page(url: string, signal?: AbortSignal): Promise<GraphPage<GraphDriveItem>> {
        const response = await graphFetch(this.tokenProvider, "GET", url, { signal });
        const json = (await response.json()) as {
            value: GraphDriveItem[];
            "@odata.nextLink"?: string;
        };
        return { value: json.value, skipToken: extractSkipToken(json["@odata.nextLink"]) };
    }
}

/**
 * Pull the `$skiptoken` out of an `@odata.nextLink`.
 *
 * @returns The token, or `null` when there is no next page.
 * @throws GraphError when a next link carries no `$skiptoken` (would
 *   otherwise silently truncate the listing).
 */
export function extractSkipToken(nextLink: string | undefined): string | null {
    if (nextLink === undefined) {
        return null;
    }
    const token = new URL(nextLink).searchParams.get("$skiptoken");
    if (token === null) {
        throw new GraphError(500, nextLink, "next page link without $skiptoken");
    }
    return token;
}

/** Encode an absolute path segment-wise for `root:/…:` addressing. */
export function encodePath(path: string): string {
    return path
        .split("/")
        .map((segment) => (segment.length > 0 ? enc(segment) : segment))
        .join("/");
}

function enc(value: string): string {
    return encodeURIComponent(value);
}
