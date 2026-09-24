import {
    type StorageCapabilities,
    type StorageConflict,
    type StorageDownloadResult,
    type StorageDrive,
    StorageError,
    type StorageItem,
    type StoragePage,
    type StoragePageOptions,
    type StorageProvider,
    type StorageSearchHit,
    type StorageSearchQuery,
    type StorageUploadSource,
} from "@getfamiliar/shared";
import { STORAGE_SCOPES } from "../auth/AppRegistration.js";
import type { LoginStore } from "../auth/LoginStore.js";
import { GraphError } from "../graph/GraphHttp.js";
import {
    DriveClient,
    type GraphDrive,
    type GraphDriveItem,
    type GraphSite,
} from "./DriveClient.js";

const CAPABILITIES: StorageCapabilities = {
    addressing: "path",
    uniqueNames: true,
    contentSearch: true,
    searchSnippets: false,
    trash: true,
    nativeDocs: false,
    serverSideCopy: true,
};

/** Site path kinds SharePoint uses in URLs (`/sites/x`, `/teams/x`). */
const SITE_KINDS = new Set(["sites", "teams"]);

/**
 * OneDrive (personal + business) and SharePoint document libraries via
 * Microsoft Graph. One instance serves every logged-in ms365 account;
 * tokens come from the shared {@link LoginStore} with the storage scopes.
 *
 * Drive selectors (the mount's `drive:` value):
 *
 * - omitted → the account's own OneDrive
 * - `sites/<site>/<library>` / `teams/<site>/<library>` → a document
 *   library of that SharePoint site on the tenant's root host
 * - `root/<library>` → a library of the tenant's root site
 * - `drives/<driveId>` → any drive by Graph id (fallback)
 *
 * Construction does no I/O (the provider registers during `prepare`).
 */
export class Ms365StorageProvider implements StorageProvider {
    readonly pluginId = "ms365";
    private store: LoginStore | undefined;
    private readonly clients = new Map<string, DriveClient>();
    private readonly rootIds = new Map<string, string>();
    private readonly hostnames = new Map<string, string>();

    /** @param makeStore - Lazily builds the login store on first use. */
    constructor(private readonly makeStore: () => LoginStore) {}

    /** @returns Static capabilities (content search works on every OneDrive / SharePoint plan). */
    capabilities(_drive: StorageDrive): StorageCapabilities {
        return CAPABILITIES;
    }

    /** @returns Every UPN with a cached login. */
    async listAccounts(): Promise<readonly string[]> {
        const store = await this.loginStore(true);
        return store.list().map((l) => l.upn);
    }

    /** @returns The device-code login command. */
    loginCommand(_account: string): string {
        return "familiar ms365 login";
    }

    /** Personal OneDrive plus the document libraries of reachable SharePoint sites. */
    async listDrives(
        account: string,
        options: { readonly limit: number; readonly search?: string },
    ): Promise<readonly StorageDrive[]> {
        return this.guard(async () => {
            const client = await this.client(account);
            const needle = options.search?.toLowerCase();
            const out: StorageDrive[] = [];
            const seen = new Set<string>();
            const push = (drive: StorageDrive): void => {
                if (seen.has(drive.id) || out.length >= options.limit) {
                    return;
                }
                if (needle !== undefined && !drive.name.toLowerCase().includes(needle)) {
                    return;
                }
                seen.add(drive.id);
                out.push(drive);
            };
            const personal = await client.getMyDrive();
            push({ account, selector: null, id: personal.id, name: "OneDrive", kind: "personal" });

            for (const site of await this.reachableSites(client, options)) {
                if (out.length >= options.limit) {
                    break;
                }
                const sitePath = siteSelectorPrefix(site);
                if (sitePath === null) {
                    continue;
                }
                const libraries = await client
                    .listSiteDrives(site.id)
                    .catch(ignoreAccessErrors([]));
                for (const lib of libraries) {
                    push({
                        account,
                        selector: `${sitePath}/${lib.name}`,
                        id: lib.id,
                        name: `${site.displayName ?? site.name ?? sitePath} / ${lib.name}`,
                        kind: "team",
                    });
                }
            }
            return out;
        });
    }

    /** Resolve a selector to a drive. */
    async openDrive(account: string, selector: string | null): Promise<StorageDrive> {
        return this.guard(async () => {
            const client = await this.client(account);
            if (selector === null) {
                const drive = await client.getMyDrive();
                return {
                    account,
                    selector: null,
                    id: drive.id,
                    name: "OneDrive",
                    kind: "personal",
                };
            }
            const drive = await this.resolveSelector(client, account, selector);
            if (!drive) {
                throw new StorageError(
                    "NotFound",
                    `no drive "${selector}" for ${account} — \`familiar storage list --account ${account}\` shows the available selectors`,
                );
            }
            return drive;
        });
    }

    /** @returns The drive's root item id (cached). */
    async rootRealId(drive: StorageDrive): Promise<string> {
        const cached = this.rootIds.get(drive.id);
        if (cached !== undefined) {
            return cached;
        }
        return this.guard(async () => {
            const root = await (await this.client(drive.account)).getRoot(drive.id);
            this.rootIds.set(drive.id, root.id);
            return root.id;
        });
    }

    /** @returns The item, or `null`. */
    async stat(drive: StorageDrive, realId: string): Promise<StorageItem | null> {
        return this.guard(async () => {
            const item = await (await this.client(drive.account)).getItem(drive.id, realId);
            return item ? toStorageItem(item) : null;
        });
    }

    /** Native path lookup; OneDrive names are unique per folder, so 0 or 1 hit. */
    async resolvePath(drive: StorageDrive, path: string): Promise<readonly StorageItem[]> {
        return this.guard(async () => {
            if (path === "/") {
                const root = await (await this.client(drive.account)).getRoot(drive.id);
                return [toStorageItem(root)];
            }
            const item = await (await this.client(drive.account)).getItemByPath(drive.id, path);
            return item ? [toStorageItem(item)] : [];
        });
    }

    /** One page of children (the service sorts). */
    async list(
        drive: StorageDrive,
        folderRealId: string,
        options: StoragePageOptions,
    ): Promise<StoragePage<StorageItem>> {
        return this.guard(async () => {
            const page = await (await this.client(drive.account)).listChildren(
                drive.id,
                folderRealId,
                options.limit,
                options.cursor,
            );
            return { entries: page.value.map(toStorageItem), nextCursor: page.skipToken };
        });
    }

    /** Graph drive search (names and contents; the match location is not reported). */
    async search(
        drive: StorageDrive,
        query: StorageSearchQuery,
        options: StoragePageOptions,
    ): Promise<StoragePage<StorageSearchHit>> {
        return this.guard(async () => {
            const page = await (await this.client(drive.account)).search(
                drive.id,
                query.text,
                query.underRealId,
                options.limit,
                options.cursor,
                options.signal,
            );
            return {
                entries: page.value.map((item) => ({
                    item: toStorageItem(item),
                    matchedIn: "unknown" as const,
                })),
                nextCursor: page.skipToken,
            };
        });
    }

    /** Stream a file's bytes to `destPath`. */
    async download(
        drive: StorageDrive,
        realId: string,
        destPath: string,
        options?: { readonly signal?: AbortSignal },
    ): Promise<StorageDownloadResult> {
        return this.guard(async () => {
            const client = await this.client(drive.account);
            const item = await client.getItem(drive.id, realId);
            if (!item) {
                throw new StorageError("NotFound", `item ${realId} not found`);
            }
            if (item.folder || item.root) {
                throw new StorageError("Unsupported", `ms365: ${item.name} is a folder`);
            }
            if (item.package) {
                throw new StorageError(
                    "Unsupported",
                    `ms365: ${item.name} is a ${item.package.type ?? "package"} (e.g. a OneNote notebook) and has no downloadable bytes`,
                );
            }
            const bytes = await client.downloadTo(drive.id, realId, destPath, options?.signal);
            return { bytes, mimeType: item.file?.mimeType ?? null, fileName: item.name };
        });
    }

    /** Simple PUT up to 4 MiB, chunked upload session above. */
    async upload(
        drive: StorageDrive,
        parentRealId: string,
        name: string,
        source: StorageUploadSource,
        options: {
            readonly conflict: StorageConflict;
            readonly replaceRealId?: string;
            readonly ifRevision?: string;
            readonly signal?: AbortSignal;
        },
    ): Promise<StorageItem> {
        return this.guard(async () => {
            const client = await this.client(drive.account);
            if (options.conflict === "replace") {
                if (options.replaceRealId === undefined) {
                    throw new StorageError(
                        "Unsupported",
                        "ms365: conflict=replace needs the item to replace",
                    );
                }
                const item = await client.uploadReplace(
                    drive.id,
                    options.replaceRealId,
                    source.path,
                    source.size,
                    options.ifRevision,
                    options.signal,
                );
                return toStorageItem(item);
            }
            const item = await client.uploadNew(
                drive.id,
                parentRealId,
                name,
                source.path,
                source.size,
                options.conflict,
                options.signal,
            );
            return toStorageItem(item);
        });
    }

    /** Create a folder; `reuse` returns an existing folder of that name. */
    async createFolder(
        drive: StorageDrive,
        parentRealId: string,
        name: string,
        options: { readonly conflict: "fail" | "rename" | "reuse" },
    ): Promise<StorageItem> {
        return this.guard(async () => {
            const client = await this.client(drive.account);
            try {
                const created = await client.createFolder(
                    drive.id,
                    parentRealId,
                    name,
                    options.conflict === "rename" ? "rename" : "fail",
                );
                return toStorageItem(created);
            } catch (err) {
                if (
                    options.conflict !== "reuse" ||
                    !(err instanceof GraphError) ||
                    err.status !== 409
                ) {
                    throw err;
                }
                const existing = await client.getChildByName(drive.id, parentRealId, name);
                if (!existing?.folder) {
                    throw new StorageError("NameConflict", `${name} exists and is not a folder`);
                }
                return toStorageItem(existing);
            }
        });
    }

    /** Move / rename, guarded by the eTag when given. */
    async move(
        drive: StorageDrive,
        realId: string,
        target: { readonly parentRealId?: string; readonly name?: string },
        options: { readonly ifRevision?: string },
    ): Promise<StorageItem> {
        return this.guard(async () => {
            const item = await (await this.client(drive.account)).patchItem(
                drive.id,
                realId,
                { parentId: target.parentRealId, name: target.name },
                options.ifRevision,
            );
            return toStorageItem(item);
        });
    }

    /** Server-side copy, waiting for Graph's async monitor. */
    async copy(
        drive: StorageDrive,
        realId: string,
        target: { readonly parentRealId: string; readonly name?: string },
        options: { readonly conflict: "fail" | "rename" },
    ): Promise<StorageItem> {
        return this.guard(async () => {
            const client = await this.client(drive.account);
            const newId = await client.copyItem(
                drive.id,
                realId,
                target.parentRealId,
                target.name,
                options.conflict,
            );
            const item = await client.getItem(drive.id, newId);
            if (!item) {
                throw new StorageError(
                    "ProviderUnavailable",
                    `ms365: copy finished but ${newId} is not visible yet`,
                );
            }
            return toStorageItem(item);
        });
    }

    /** Recycle-bin delete. */
    async trash(
        drive: StorageDrive,
        realId: string,
        options: { readonly ifRevision?: string },
    ): Promise<void> {
        return this.guard(async () => {
            await (await this.client(drive.account)).deleteItem(
                drive.id,
                realId,
                options.ifRevision,
            );
        });
    }

    // ---- internals ----------------------------------------------------

    /** Build (and optionally refresh) the login store. */
    private async loginStore(refresh = false): Promise<LoginStore> {
        if (!this.store) {
            this.store = this.makeStore();
            await this.store.refresh();
        } else if (refresh) {
            await this.store.refresh();
        }
        return this.store;
    }

    /**
     * Drive client for one account; token failures surface as `AuthExpired`.
     *
     * @throws StorageError `AuthExpired` when the account has no login.
     */
    private async client(account: string): Promise<DriveClient> {
        const key = account.toLowerCase();
        const cached = this.clients.get(key);
        if (cached) {
            return cached;
        }
        let auth = (await this.loginStore()).byUpn(key);
        if (!auth) {
            auth = (await this.loginStore(true)).byUpn(key);
        }
        if (!auth) {
            throw new StorageError("AuthExpired", `no ms365 login for ${account}`);
        }
        const graphAuth = auth;
        const client = new DriveClient(async () => {
            try {
                return await graphAuth.getAccessTokenSilent(STORAGE_SCOPES);
            } catch (err) {
                throw new StorageError(
                    "AuthExpired",
                    `token for ${account} unavailable (${err instanceof Error ? err.message : String(err)}); the login may predate the storage permissions`,
                );
            }
        });
        this.clients.set(key, client);
        return client;
    }

    /** Sites to offer: followed sites plus a (search-filtered) site search. */
    private async reachableSites(
        client: DriveClient,
        options: { readonly limit: number; readonly search?: string },
    ): Promise<readonly GraphSite[]> {
        const followed = await client
            .listFollowedSites()
            .catch(ignoreAccessErrors([] as GraphSite[]));
        const searched = await client
            .searchSites(options.search ?? "*", Math.min(options.limit, 200))
            .catch(ignoreAccessErrors([] as GraphSite[]));
        const byId = new Map<string, GraphSite>();
        for (const site of [...followed, ...searched]) {
            byId.set(site.id, site);
        }
        return [...byId.values()];
    }

    /** Resolve a non-null selector, or `null` when nothing matches. */
    private async resolveSelector(
        client: DriveClient,
        account: string,
        selector: string,
    ): Promise<StorageDrive | null> {
        const parts = selector.split("/").filter((p) => p.length > 0);
        const [head, ...rest] = parts;
        if (head === "drives" && rest.length === 1 && rest[0]) {
            const drive = await client.getDrive(rest[0]);
            return drive
                ? { account, selector, id: drive.id, name: drive.name, kind: kindOf(drive) }
                : null;
        }
        let site: GraphSite | null;
        let library: string;
        if (head === "root" && rest.length >= 1) {
            site = await client.getRootSite();
            library = rest.join("/");
        } else if (head !== undefined && SITE_KINDS.has(head) && rest.length >= 2 && rest[0]) {
            const hostname = await this.hostname(client, account);
            site = await client.getSiteByPath(hostname, `${head}/${rest[0]}`);
            library = rest.slice(1).join("/");
        } else {
            throw new StorageError(
                "NotFound",
                `unrecognized ms365 drive selector "${selector}" — use sites/<site>/<library>, teams/<site>/<library>, root/<library> or drives/<id>`,
            );
        }
        if (!site) {
            return null;
        }
        const libraries = await client.listSiteDrives(site.id);
        const lib = libraries.find((d) => d.name.toLowerCase() === library.toLowerCase());
        if (!lib) {
            return null;
        }
        return {
            account,
            selector,
            id: lib.id,
            name: `${site.displayName ?? site.name ?? head} / ${lib.name}`,
            kind: "team",
        };
    }

    /** Tenant root hostname per account (cached). */
    private async hostname(client: DriveClient, account: string): Promise<string> {
        const cached = this.hostnames.get(account);
        if (cached !== undefined) {
            return cached;
        }
        const hostname = await client.getRootSiteHostname();
        this.hostnames.set(account, hostname);
        return hostname;
    }

    /** Run a Graph call, mapping failures onto {@link StorageError}. */
    private async guard<T>(fn: () => Promise<T>): Promise<T> {
        try {
            return await fn();
        } catch (err) {
            throw toStorageError(err);
        }
    }
}

/**
 * Map a Graph failure onto a normalized {@link StorageError}.
 *
 * @param err - Whatever the Graph call threw.
 */
export function toStorageError(err: unknown): StorageError {
    if (err instanceof StorageError) {
        return err;
    }
    if (!(err instanceof GraphError)) {
        return new StorageError(
            "ProviderUnavailable",
            `ms365: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
    const detail = `ms365: ${err.graphMessage.slice(0, 300)}`;
    switch (err.status) {
        case 401:
            return new StorageError("AuthExpired", detail);
        case 403:
            return new StorageError("ProviderUnavailable", `${detail} (access denied)`);
        case 404:
            return new StorageError("NotFound", detail);
        case 409:
            return new StorageError("NameConflict", detail);
        case 412:
            return new StorageError("RevisionMismatch", detail);
        case 423:
            return new StorageError(
                "ProviderUnavailable",
                `${detail} (the item is locked, e.g. open for editing)`,
            );
        case 429:
            return new StorageError("RateLimited", detail);
        case 507:
            return new StorageError("QuotaExceeded", `${detail} (the drive is full)`);
        default:
            return new StorageError("ProviderUnavailable", `${detail} (HTTP ${err.status})`);
    }
}

/**
 * Map a Graph `driveItem` onto the normalized item shape.
 *
 * @param item - Raw Graph item.
 */
export function toStorageItem(item: GraphDriveItem): StorageItem {
    const isRoot = item.root !== undefined;
    const isFolder = item.folder !== undefined || isRoot;
    const parentPath = parentPathOf(item.parentReference?.path);
    const hashes = item.file?.hashes;
    const contentHash = hashes?.quickXorHash
        ? ({ algo: "quickXor", value: hashes.quickXorHash } as const)
        : hashes?.sha256Hash
          ? ({ algo: "sha256", value: hashes.sha256Hash } as const)
          : hashes?.sha1Hash
            ? ({ algo: "sha1", value: hashes.sha1Hash } as const)
            : null;
    return {
        realId: item.id,
        parentRealId: isRoot ? null : (item.parentReference?.id ?? null),
        name: isRoot ? "" : item.name,
        path: isRoot
            ? "/"
            : parentPath === null
              ? null
              : parentPath === "/"
                ? `/${item.name}`
                : `${parentPath}/${item.name}`,
        kind: isFolder ? "folder" : item.package ? "native" : "file",
        mimeType: item.file?.mimeType ?? null,
        size: item.file ? (item.size ?? null) : null,
        createdUtc: item.createdDateTime ?? null,
        modifiedUtc: item.lastModifiedDateTime ?? null,
        modifiedBy: item.lastModifiedBy?.user?.displayName ?? null,
        revision: item.eTag ?? null,
        contentHash,
        webUrl: item.webUrl ?? null,
        isShared: item.shared !== undefined,
    };
}

/**
 * Extract the in-drive path from `parentReference.path`
 * (`/drive/root:/A/B` or `/drives/<id>/root:`).
 *
 * @returns The absolute folder path, or `null` when absent.
 */
export function parentPathOf(referencePath: string | undefined): string | null {
    if (referencePath === undefined) {
        return null;
    }
    const idx = referencePath.indexOf("root:");
    if (idx < 0) {
        return null;
    }
    const raw = referencePath.slice(idx + "root:".length);
    let decoded = raw;
    try {
        decoded = decodeURIComponent(raw);
    } catch {
        // keep the raw path when it is not valid percent-encoding
    }
    return decoded.length === 0 ? "/" : decoded;
}

/** `sites/<name>` / `teams/<name>` / `root` for a site's web URL; `null` for other layouts. */
export function siteSelectorPrefix(site: GraphSite): string | null {
    if (!site.webUrl) {
        return null;
    }
    const segments = new URL(site.webUrl).pathname.split("/").filter((s) => s.length > 0);
    if (segments.length === 0) {
        return "root";
    }
    const [kind, name] = segments;
    if (kind !== undefined && name !== undefined && segments.length === 2 && SITE_KINDS.has(kind)) {
        return `${kind}/${decodeURIComponent(name)}`;
    }
    return null;
}

/** Drive kind from Graph's `driveType`. */
function kindOf(drive: GraphDrive): StorageDrive["kind"] {
    return drive.driveType === "personal" || drive.driveType === "business" ? "personal" : "team";
}

/**
 * `.catch` handler: swallow "this account has no SharePoint / may not
 * list sites" (400 / 403 / 404) and return `fallback`; rethrow the rest.
 */
function ignoreAccessErrors<T>(fallback: T): (err: unknown) => T {
    return (err) => {
        if (err instanceof GraphError && [400, 403, 404].includes(err.status)) {
            return fallback;
        }
        throw err;
    };
}
