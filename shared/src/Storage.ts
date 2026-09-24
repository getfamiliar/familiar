/**
 * Cloud-storage provider SPI. Lives in `shared/` because the host (which
 * owns the `StorageService`, the `storage_*` agent tools and the
 * `familiar storage` CLI) and the provider plugins (ms365, later gdrive,
 * dropbox, …) trade in the same shapes.
 *
 * Division of labour:
 *
 * - **Providers** speak their API: they address items by their native
 *   id (`realId`), stream bytes between the provider and a host-side
 *   file, and map API failures onto {@link StorageError} codes. They
 *   never see mounts, refs, policy, quotas or the agent.
 * - **The host `StorageService`** owns everything that must behave the
 *   same for every provider: mount aliases, ref parsing, path
 *   resolution for id-addressed providers, write policy, search
 *   fan-out, cross-mount copies and the per-run byte quota.
 *
 * Credentials never leave the provider: the agent only ever sees mount
 * aliases, refs, metadata and files placed in its scratch directory.
 * Hard delete is deliberately absent from the SPI.
 */

/** Kind of a storage item. `native` = provider document without bytes (Google Docs, …). */
export type StorageItemKind = "file" | "folder" | "native";

/** Hash algorithms a provider may report for file content. */
export type StorageHashAlgo = "sha1" | "sha256" | "md5" | "quickXor" | "dropbox";

/** Provider-reported content hash. */
export interface StorageContentHash {
    readonly algo: StorageHashAlgo;
    readonly value: string;
}

/**
 * Normalized item metadata. `realId` / `parentRealId` are provider-native
 * and only ever reach the agent wrapped inside an id ref (`mount#<id>`).
 */
export interface StorageItem {
    readonly realId: string;
    /** `null` for the drive root and for parentless items (gdrive "shared with me"). */
    readonly parentRealId: string | null;
    readonly name: string;
    /**
     * Absolute path within the drive (`/folder/file.ext`, root = `/`),
     * or `null` when the provider cannot tell cheaply. The service fills
     * it in where it can.
     */
    readonly path: string | null;
    readonly kind: StorageItemKind;
    readonly mimeType: string | null;
    /** Bytes; `null` for folders and native docs. */
    readonly size: number | null;
    /** UTC ISO-8601. */
    readonly createdUtc: string | null;
    /** UTC ISO-8601. */
    readonly modifiedUtc: string | null;
    readonly modifiedBy: string | null;
    /** Opaque concurrency token (OneDrive eTag, Dropbox rev, gdrive version). */
    readonly revision: string | null;
    readonly contentHash: StorageContentHash | null;
    readonly webUrl: string | null;
    readonly isShared: boolean;
}

/** Feature flags the service adapts to. Reported to the agent in summary form. */
export interface StorageCapabilities {
    /** `path` = the provider resolves `/a/b` natively; `id` = the service walks the tree. */
    readonly addressing: "path" | "id";
    /** `false` when siblings may share a name (Google Drive). */
    readonly uniqueNames: boolean;
    /** Full-text search over file contents. */
    readonly contentSearch: boolean;
    /** Search hits can carry a snippet. */
    readonly searchSnippets: boolean;
    /** Soft delete into a recoverable trash / recycle bin. */
    readonly trash: boolean;
    /** Byte-less provider documents exist and are exported on download. */
    readonly nativeDocs: boolean;
    /** Same-drive copies happen server-side. */
    readonly serverSideCopy: boolean;
}

/** Kind of a drive as offered to the user in `familiar storage list`. */
export type StorageDriveKind = "personal" | "shared" | "team";

/**
 * One drive of one account: a OneDrive, a SharePoint document library,
 * a Google shared drive, … Opaque to the service beyond these fields.
 */
export interface StorageDrive {
    /** Account key the drive belongs to (UPN, e-mail, dbid, …). */
    readonly account: string;
    /**
     * Value to put into a mount's `drive:` field. `null` = the account's
     * primary drive (the default when `drive:` is omitted).
     */
    readonly selector: string | null;
    /** Provider-native drive id. Never shown to the agent. */
    readonly id: string;
    /** Human-readable name, e.g. "OneDrive" or "Verwaltung / Dokumente". */
    readonly name: string;
    readonly kind: StorageDriveKind;
}

/** Search criteria. The service post-filters kind / mime / modified / subtree, so providers may ignore them. */
export interface StorageSearchQuery {
    /** Plain keywords; providers must escape their own query syntax. */
    readonly text: string;
    /** Folder to scope the search to (provider-native id). */
    readonly underRealId?: string;
    /** Absolute path of that folder, when known. */
    readonly underPath?: string;
    readonly kind?: StorageItemKind;
    readonly mimePrefix?: string;
    /** Inclusive lower bound, UTC ISO. */
    readonly modifiedFromUtc?: string;
    /** Exclusive upper bound, UTC ISO. */
    readonly modifiedToUtc?: string;
}

/** Where a search matched. */
export type StorageMatchedIn = "name" | "content" | "unknown";

/** One search hit. */
export interface StorageSearchHit {
    readonly item: StorageItem;
    readonly matchedIn: StorageMatchedIn;
    readonly snippet?: string;
}

/** One page of results with an opaque continuation cursor (`null` on the last page). */
export interface StoragePage<T> {
    readonly entries: readonly T[];
    readonly nextCursor: string | null;
}

/** Paging options. */
export interface StoragePageOptions {
    readonly cursor?: string;
    readonly limit: number;
    readonly signal?: AbortSignal;
}

/** Order for folder listings. Providers that cannot sort leave it to the service. */
export type StorageListOrder = "name" | "modified_desc";

/** Conflict behaviour on create. */
export type StorageConflict = "fail" | "rename" | "replace";

/** Host-side file to upload. */
export interface StorageUploadSource {
    /** Absolute host path of a regular file. */
    readonly path: string;
    readonly size: number;
    readonly mimeType?: string;
}

/** Result of a download. */
export interface StorageDownloadResult {
    readonly bytes: number;
    readonly mimeType: string | null;
    /** File name to store under; for native docs it carries the export extension. */
    readonly fileName: string;
}

/**
 * The provider contract. One instance per plugin, covering every
 * account the plugin is logged into. Implementations must be **lazy**:
 * providers register during `prepare()` (so the CLI can use them
 * without the daemon), which forbids network access, so the first
 * network call happens inside a method.
 *
 * Every method may throw {@link StorageError}; anything else is treated
 * as `ProviderUnavailable` by the service.
 */
export interface StorageProvider {
    readonly pluginId: string;
    /** Capabilities for one drive (content search may depend on the tenant / plan). */
    capabilities(drive: StorageDrive): StorageCapabilities;
    /** Accounts this plugin is logged into (lower-cased keys). */
    listAccounts(): Promise<readonly string[]>;
    /** CLI hint telling the user how to (re-)login `account`. */
    loginCommand(account: string): string;
    /** Drives the account can reach: personal, shared and team drives / libraries. */
    listDrives(
        account: string,
        options: { readonly limit: number; readonly search?: string },
    ): Promise<readonly StorageDrive[]>;
    /**
     * Open one drive by its config selector (`null` = primary drive).
     *
     * @throws StorageError `NotFound` when the selector matches nothing.
     */
    openDrive(account: string, selector: string | null): Promise<StorageDrive>;
    /** Provider id of the drive's root folder. */
    rootRealId(drive: StorageDrive): Promise<string>;
    /** Metadata of one item, or `null` if it does not exist. */
    stat(drive: StorageDrive, realId: string): Promise<StorageItem | null>;
    /**
     * Resolve an absolute path natively. Only required when
     * `capabilities.addressing === "path"`. Returns `[]` when not found,
     * several items when names are ambiguous.
     */
    resolvePath?(drive: StorageDrive, path: string): Promise<readonly StorageItem[]>;
    /** One page of the direct children of a folder. */
    list(
        drive: StorageDrive,
        folderRealId: string,
        options: StoragePageOptions & { readonly order?: StorageListOrder },
    ): Promise<StoragePage<StorageItem>>;
    /** One page of search hits. */
    search(
        drive: StorageDrive,
        query: StorageSearchQuery,
        options: StoragePageOptions,
    ): Promise<StoragePage<StorageSearchHit>>;
    /**
     * Stream the item's bytes into `destPath` (created / truncated). Native
     * docs are exported server-side in a provider-chosen format; a native
     * type without an export mapping throws `Unsupported`.
     */
    download(
        drive: StorageDrive,
        realId: string,
        destPath: string,
        options?: { readonly signal?: AbortSignal },
    ): Promise<StorageDownloadResult>;
    /**
     * Upload a host-side file as `name` into `parentRealId`. The provider
     * picks simple vs. resumable upload.
     *
     * - `conflict: "fail"` — throw `NameConflict` if the name is taken
     *   (only meaningful with `uniqueNames`).
     * - `conflict: "rename"` — let the provider pick a free name.
     * - `conflict: "replace"` — overwrite the content of the item
     *   `replaceRealId` (required; replacing by name is ambiguous on
     *   id-addressed providers). With `ifRevision`, the replace must be
     *   guarded by that revision (atomically where the API allows) and
     *   throw `RevisionMismatch` otherwise.
     */
    upload(
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
    ): Promise<StorageItem>;
    /** Create a folder. `reuse` returns an existing folder of that name. */
    createFolder(
        drive: StorageDrive,
        parentRealId: string,
        name: string,
        options: { readonly conflict: "fail" | "rename" | "reuse" },
    ): Promise<StorageItem>;
    /** Move and / or rename within one drive. */
    move(
        drive: StorageDrive,
        realId: string,
        target: { readonly parentRealId?: string; readonly name?: string },
        options: { readonly ifRevision?: string },
    ): Promise<StorageItem>;
    /** Server-side copy within one drive; resolves once the copy is complete. */
    copy(
        drive: StorageDrive,
        realId: string,
        target: { readonly parentRealId: string; readonly name?: string },
        options: { readonly conflict: "fail" | "rename" },
    ): Promise<StorageItem>;
    /** Soft delete into the provider's trash. Folders go with their contents. */
    trash(
        drive: StorageDrive,
        realId: string,
        options: { readonly ifRevision?: string },
    ): Promise<void>;
}

/** Normalized provider failure codes. */
export type StorageErrorCode =
    | "NotFound"
    | "NameConflict"
    | "RevisionMismatch"
    | "Unsupported"
    | "AuthExpired"
    | "RateLimited"
    | "QuotaExceeded"
    | "ProviderUnavailable";

/**
 * Error a provider throws with a normalized code. The service maps it
 * onto an agent-readable `ToolError`.
 */
export class StorageError extends Error {
    constructor(
        public readonly code: StorageErrorCode,
        message: string,
    ) {
        super(message);
        this.name = "StorageError";
    }
}

/** Plugin-facing registration surface (`ctx.storage`). */
export interface StorageApi {
    /**
     * Register the plugin's storage provider. Call from `prepare()` so
     * CLI commands reach it too. Throws if the same `pluginId`
     * registers twice.
     */
    registerProvider(provider: StorageProvider): void;
}
