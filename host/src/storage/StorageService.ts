import { randomBytes } from "node:crypto";
import { copyFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
    type Logger,
    type StorageCapabilities,
    type StorageDrive,
    StorageError,
    type StorageItem,
    type StorageItemKind,
    type StorageListOrder,
    type StorageMatchedIn,
    type StorageProvider,
    ToolError,
} from "@getfamiliar/shared";
import { isPathInside, type MountConfig, type StorageSettings } from "./StorageConfig.js";
import {
    formatIdRef,
    joinPath,
    normalizeItemPath,
    parseRef,
    type StorageRef,
    splitParent,
} from "./StorageRefs.js";
import type { StorageRegistry } from "./StorageRegistry.js";
import { allocateDownloadPath, resolveScratchInput } from "./StorageScratch.js";
import { TtlCache } from "./TtlCache.js";

/** An item together with the mount it was found on. `item.path` is filled where known. */
export interface MountedItem {
    readonly mount: string;
    readonly item: StorageItem;
}

/** A mount that resolved to a provider and a drive. */
interface OpenMount {
    readonly config: MountConfig;
    readonly provider: StorageProvider;
    readonly drive: StorageDrive;
    readonly caps: StorageCapabilities;
}

/** One row of {@link StorageService.listMounts}. */
export interface MountStatus {
    readonly mount: string;
    readonly provider: string;
    /** Effective access (`read` whenever `storage.allowWrite` is false). */
    readonly access: "read" | "readwrite";
    /** Only set when `access` is `readwrite`. */
    readonly writeRoots?: readonly string[];
    readonly contentSearch: boolean | null;
    readonly available: boolean;
    readonly error?: string;
}

/** Per-call identity used for scratch placement and the byte quota. */
export interface StorageCallContext {
    readonly eventId: string;
    readonly agentrunId: string;
}

/** Search arguments after the tool layer converted days to UTC. */
export interface StorageSearchArgs {
    readonly text: string;
    readonly mounts?: readonly string[];
    readonly under?: string;
    readonly kind?: StorageItemKind;
    readonly mimePrefix?: string;
    readonly modifiedFromUtc?: string;
    readonly modifiedToUtc?: string;
    readonly limit: number;
    readonly cursor?: string;
}

/** One search hit, mounted. */
export interface MountedSearchHit extends MountedItem {
    readonly matchedIn: StorageMatchedIn;
    readonly snippet?: string;
}

/** Result of a search fan-out. */
export interface StorageSearchResult {
    readonly searched: readonly string[];
    readonly hits: readonly MountedSearchHit[];
    readonly failed: readonly { readonly mount: string; readonly reason: string }[];
    readonly nextCursor: string | null;
}

/** Per-ref result of a download. */
export type DownloadOutcome =
    | { readonly ref: string; readonly ok: true; readonly path: string; readonly bytes: number }
    | { readonly ref: string; readonly ok: false; readonly error: string };

/** Arguments of {@link StorageService.write}. */
export interface StorageWriteArgs {
    readonly ref: string;
    readonly content?: string;
    readonly scratchPath?: string;
    readonly ifRevision?: string;
    readonly conflict?: "fail" | "rename";
    readonly mimeType?: string;
}

/** Everything the service needs from the host. */
export interface StorageServiceDeps {
    readonly registry: StorageRegistry;
    /** Current settings; read on every call so config policy applies at call time. */
    readonly settings: () => StorageSettings;
    /** Host path of `tmp/scratch`. */
    readonly scratchDir: string;
    /** Host dir for transient staging files (never visible to the agent). */
    readonly stagingDir: string;
    readonly log: Logger;
    /** Clock, injectable for tests. */
    readonly now?: () => number;
}

/** Mutating operations the policy gate knows. */
export type StorageWriteOp = "write" | "mkdir" | "move" | "copy" | "trash";

const PATH_CACHE_TTL_MS = 60_000;
const QUOTA_ENTRY_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PARENT_WALK = 64;
const RESOLVE_PAGE_SIZE = 200;

/**
 * Provider-agnostic storage core: mount registry, ref resolution,
 * write policy, search fan-out, cross-mount copy and the per-run byte
 * quota. Everything here behaves identically for every provider; the
 * `storage_*` tools are thin shells around it.
 *
 * Every public method throws {@link ToolError} with an agent-readable
 * message; provider {@link StorageError}s are mapped on the way out.
 */
export class StorageService {
    private readonly drives = new Map<string, { signature: string; drive: StorageDrive }>();
    private readonly pathCache: TtlCache<readonly string[]>;
    private readonly quota = new Map<string, { used: number; touchedAt: number }>();
    private readonly now: () => number;

    /** @param deps - Host collaborators. */
    constructor(private readonly deps: StorageServiceDeps) {
        this.now = deps.now ?? Date.now;
        this.pathCache = new TtlCache(PATH_CACHE_TTL_MS, 5000, this.now);
    }

    /** @returns The current settings. */
    settings(): StorageSettings {
        return this.deps.settings();
    }

    // ---- discovery ----------------------------------------------------

    /**
     * Report every configured mount with its effective access. Mounts
     * that cannot be opened (missing plugin, expired login, unknown
     * drive) are reported as unavailable with the reason.
     */
    async listMounts(): Promise<readonly MountStatus[]> {
        const settings = this.settings();
        const rows: MountStatus[] = [];
        for (const config of settings.mounts) {
            const effective =
                settings.allowWrite && config.access === "readwrite" ? "readwrite" : "read";
            const base = {
                mount: config.alias,
                provider: config.plugin,
                access: effective,
                ...(effective === "readwrite" ? { writeRoots: config.writeRoots } : {}),
            } as const;
            try {
                const open = await this.openMount(config.alias);
                rows.push({ ...base, contentSearch: open.caps.contentSearch, available: true });
            } catch (err) {
                rows.push({
                    ...base,
                    contentSearch: null,
                    available: false,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }
        return rows;
    }

    /**
     * List one page of a folder's direct children.
     *
     * @throws ToolError `NotAFolder` when the ref is a file.
     */
    async list(
        ref: string,
        options: {
            readonly limit: number;
            readonly cursor?: string;
            readonly order: StorageListOrder;
        },
    ): Promise<{ folder: MountedItem; items: readonly MountedItem[]; nextCursor: string | null }> {
        const folder = await this.resolveRef(ref);
        if (folder.item.kind !== "folder") {
            throw new ToolError("NotAFolder", `${ref} is a ${folder.item.kind}, not a folder`);
        }
        const open = await this.openMount(folder.mount);
        const page = await this.call(open, () =>
            open.provider.list(open.drive, folder.item.realId, {
                limit: options.limit,
                cursor: options.cursor,
                order: options.order,
            }),
        );
        const items = page.entries.map((item) => ({
            mount: folder.mount,
            item: withPath(item, childPath(folder.item.path, item)),
        }));
        return { folder, items: sortItems(items, options.order), nextCursor: page.nextCursor };
    }

    /** Full metadata of one item. */
    async stat(ref: string): Promise<MountedItem> {
        return this.resolveRef(ref);
    }

    /**
     * Search the selected mounts in parallel, each under its own
     * timeout. Results stay grouped per mount (provider scores are not
     * comparable); failed and timed-out mounts are reported.
     */
    async search(args: StorageSearchArgs): Promise<StorageSearchResult> {
        const settings = this.settings();
        const cursors = args.cursor !== undefined ? decodeCursor(args.cursor) : undefined;
        let underItem: MountedItem | undefined;
        if (args.under !== undefined) {
            underItem = await this.resolveRef(args.under);
            if (underItem.item.kind !== "folder") {
                throw new ToolError("NotAFolder", `under=${args.under} is not a folder`);
            }
        }
        const selected = cursors
            ? Object.keys(cursors)
            : underItem
              ? [underItem.mount]
              : (args.mounts ??
                settings.mounts.filter((m) => m.searchByDefault).map((m) => m.alias));
        if (selected.length === 0) {
            throw new ToolError(
                "UnknownMount",
                "no mounts to search — storage_list_mounts shows the configured ones",
            );
        }
        for (const alias of selected) {
            this.mountConfig(alias);
        }
        const perMount = Math.max(1, Math.ceil(args.limit / selected.length));
        const outcomes = await Promise.all(
            selected.map(async (alias) => {
                try {
                    const hits = await withTimeout(settings.searchTimeoutMs, async (signal) => {
                        const open = await this.openMount(alias);
                        return this.call(open, () =>
                            open.provider.search(
                                open.drive,
                                {
                                    text: args.text,
                                    underRealId:
                                        underItem?.mount === alias
                                            ? underItem.item.realId
                                            : undefined,
                                    underPath:
                                        underItem?.mount === alias
                                            ? (underItem.item.path ?? undefined)
                                            : undefined,
                                    kind: args.kind,
                                    mimePrefix: args.mimePrefix,
                                    modifiedFromUtc: args.modifiedFromUtc,
                                    modifiedToUtc: args.modifiedToUtc,
                                },
                                { limit: perMount, cursor: cursors?.[alias] ?? undefined, signal },
                            ),
                        );
                    });
                    return { alias, ok: true as const, page: hits };
                } catch (err) {
                    const reason =
                        err instanceof TimeoutError
                            ? `timed out after ${settings.searchTimeoutMs} ms`
                            : errorMessage(err);
                    return { alias, ok: false as const, reason };
                }
            }),
        );
        const hits: MountedSearchHit[] = [];
        const failed: { mount: string; reason: string }[] = [];
        const next: Record<string, string> = {};
        for (const outcome of outcomes) {
            if (!outcome.ok) {
                failed.push({ mount: outcome.alias, reason: outcome.reason });
                continue;
            }
            for (const hit of outcome.page.entries) {
                if (
                    !matchesFilters(
                        hit.item,
                        args,
                        underItem?.mount === outcome.alias ? underItem.item.path : null,
                    )
                ) {
                    continue;
                }
                hits.push({
                    mount: outcome.alias,
                    item: hit.item,
                    matchedIn: hit.matchedIn,
                    ...(hit.snippet !== undefined ? { snippet: hit.snippet } : {}),
                });
            }
            if (outcome.page.nextCursor !== null) {
                next[outcome.alias] = outcome.page.nextCursor;
            }
        }
        return {
            searched: selected,
            hits,
            failed,
            nextCursor: Object.keys(next).length > 0 ? encodeCursor(next) : null,
        };
    }

    // ---- content ------------------------------------------------------

    /**
     * Download files unchanged into `/scratch/<eventId>/storage/<mount>/`.
     * Partial success: every ref gets its own outcome.
     */
    async download(
        refs: readonly string[],
        ctx: StorageCallContext,
    ): Promise<readonly DownloadOutcome[]> {
        const used = new Map<string, Set<string>>();
        const outcomes: DownloadOutcome[] = [];
        for (const ref of refs) {
            try {
                const target = await this.resolveRef(ref);
                if (target.item.kind === "folder") {
                    throw new ToolError(
                        "IsAFolder",
                        `${ref} is a folder — download files one by one (storage_list shows the children)`,
                    );
                }
                this.assertQuota(ctx.agentrunId, target.item.size ?? 0);
                const open = await this.openMount(target.mount);
                const staging = await this.stagingPath();
                try {
                    const result = await this.call(open, () =>
                        open.provider.download(open.drive, target.item.realId, staging),
                    );
                    this.chargeBytes(ctx.agentrunId, result.bytes);
                    const dest = await allocateDownloadPath(
                        this.deps.scratchDir,
                        ctx.eventId,
                        target.mount,
                        result.fileName || target.item.name,
                        used,
                    );
                    await rename(staging, dest.hostPath).catch(
                        async (err: NodeJS.ErrnoException) => {
                            if (err.code !== "EXDEV") {
                                throw err;
                            }
                            await copyFile(staging, dest.hostPath);
                        },
                    );
                    outcomes.push({ ref, ok: true, path: dest.containerPath, bytes: result.bytes });
                } finally {
                    await rm(staging, { force: true });
                }
            } catch (err) {
                outcomes.push({ ref, ok: false, error: errorMessage(err) });
            }
        }
        return outcomes;
    }

    // ---- writes -------------------------------------------------------

    /**
     * Create or replace a file (see the `storage_write` tool for the
     * exact conflict semantics).
     *
     * @returns The written item and the number of bytes uploaded.
     */
    async write(
        args: StorageWriteArgs,
        ctx: StorageCallContext,
    ): Promise<{ written: MountedItem; bytes: number }> {
        const hasContent = typeof args.content === "string";
        const hasScratch = typeof args.scratchPath === "string";
        if (hasContent === hasScratch) {
            throw new ToolError("BadArgs", "pass exactly one of `content` or `scratch_path`");
        }
        const target = await this.resolveTarget(args.ref);
        const open = await this.openMount(target.mount);
        const existing = target.existing;
        const targetPath = existing ? existing.item.path : target.path;
        this.assertAllowed("write", open.config, [targetPath]);

        let parentRealId: string;
        let name: string;
        let conflict: "fail" | "rename" | "replace";
        let replaceRealId: string | undefined;
        if (existing) {
            if (existing.item.kind === "folder") {
                throw new ToolError("IsAFolder", `${args.ref} is a folder`);
            }
            if (existing.item.kind === "native") {
                throw new ToolError(
                    "Unsupported",
                    `${open.config.plugin}: ${args.ref} is a native document and cannot be overwritten — write a .docx / .xlsx / .pptx next to it instead`,
                );
            }
            parentRealId = existing.item.parentRealId ?? (await this.rootOf(open));
            name = existing.item.name;
            if (args.ifRevision !== undefined) {
                conflict = "replace";
                replaceRealId = existing.item.realId;
            } else if (args.conflict === "rename") {
                conflict = "rename";
            } else {
                throw new ToolError(
                    "NameConflict",
                    `${displayRefOf(existing)} exists (rev ${existing.item.revision ?? "?"}). Read it first and pass \`if_revision\` to replace it, or use conflict=rename to keep both.`,
                );
            }
        } else {
            if (target.path === null || target.leaf === null) {
                throw new ToolError(
                    "NotFound",
                    `${args.ref} does not exist — use a path ref ("mount:/folder/file.ext") to create a new file`,
                );
            }
            if (args.ifRevision !== undefined) {
                throw new ToolError(
                    "NotFound",
                    `${args.ref} does not exist, so \`if_revision\` cannot match — drop it to create the file`,
                );
            }
            parentRealId = await this.ensureFolderPath(open, splitParent(target.path).parent);
            name = target.leaf;
            conflict = args.conflict === "rename" ? "rename" : "fail";
        }

        let sourcePath: string;
        let size: number;
        let staged: string | undefined;
        if (hasScratch) {
            const input = await resolveScratchInput(
                args.scratchPath as string,
                this.deps.scratchDir,
                ctx.eventId,
            );
            sourcePath = input.hostPath;
            size = input.size;
        } else {
            const bytes = Buffer.from(args.content as string, "utf8");
            size = bytes.length;
            this.assertQuota(ctx.agentrunId, size);
            staged = await this.stagingPath();
            await writeFile(staged, bytes);
            sourcePath = staged;
        }
        try {
            this.chargeBytes(ctx.agentrunId, size);
            const item = await this.call(open, () =>
                open.provider.upload(
                    open.drive,
                    parentRealId,
                    name,
                    { path: sourcePath, size, mimeType: args.mimeType },
                    { conflict, replaceRealId, ifRevision: args.ifRevision },
                ),
            );
            this.invalidate(open.config.alias);
            const written = await this.mounted(open, item);
            this.deps.log.info(
                `storage: run ${ctx.agentrunId} wrote ${displayRefOf(written)} (${formatIdRef(written.mount, written.item.realId)}, ${formatBytes(size)}, ${conflict})`,
            );
            return { written, bytes: size };
        } finally {
            if (staged) {
                await rm(staged, { force: true });
            }
        }
    }

    /**
     * Create a folder and any missing parents; a no-op when it exists.
     *
     * @throws ToolError `BadRef` for id refs (a new folder has no id yet).
     */
    async mkdir(ref: string): Promise<{ folder: MountedItem; created: boolean }> {
        const parsed = parseRef(ref);
        if (parsed.form !== "path") {
            throw new ToolError("BadRef", 'storage_mkdir needs a path ref ("mount:/folder/sub")');
        }
        const open = await this.openMount(parsed.mount);
        this.assertAllowed("mkdir", open.config, [parsed.path]);
        const existing = await this.tryResolvePath(open, parsed.path);
        if (existing) {
            if (existing.item.kind !== "folder") {
                throw new ToolError("NameConflict", `${ref} exists and is a ${existing.item.kind}`);
            }
            return { folder: existing, created: false };
        }
        const realId = await this.ensureFolderPath(open, parsed.path);
        this.deps.log.info(`storage: created folder ${ref}`);
        return { folder: await this.statMounted(open, realId, parsed.path), created: true };
    }

    /**
     * Create a folder path on behalf of the **user** (the
     * `familiar storage lint --fix` CLI), bypassing the agent write
     * policy. Never reachable from an agent tool.
     *
     * @returns Whether anything had to be created.
     */
    async createFolderPathAsUser(alias: string, folderPath: string): Promise<boolean> {
        const open = await this.openMount(alias);
        const normalized = normalizeItemPath(folderPath);
        if (await this.tryResolvePath(open, normalized)) {
            return false;
        }
        await this.ensureFolderPath(open, normalized, false);
        return true;
    }

    /** Move and / or rename within one mount. */
    async move(args: {
        readonly ref: string;
        readonly toFolder?: string;
        readonly newName?: string;
        readonly ifRevision?: string;
    }): Promise<MountedItem> {
        if (args.toFolder === undefined && args.newName === undefined) {
            throw new ToolError("BadArgs", "pass `to_folder`, `new_name`, or both");
        }
        if (args.newName !== undefined) {
            assertValidName(args.newName);
        }
        const source = await this.resolveRef(args.ref);
        const open = await this.openMount(source.mount);
        if (source.item.parentRealId === null && source.item.path === "/") {
            throw new ToolError("BadArgs", "the mount root cannot be moved");
        }
        let destFolder: MountedItem | undefined;
        if (args.toFolder !== undefined) {
            destFolder = await this.resolveRef(args.toFolder);
            if (destFolder.mount !== source.mount) {
                throw new ToolError(
                    "CrossMountMove",
                    `moves stay within one mount (${source.mount} → ${destFolder.mount}). Use storage_copy to the other mount, then storage_delete the original.`,
                );
            }
            if (destFolder.item.kind !== "folder") {
                throw new ToolError("NotAFolder", `to_folder ${args.toFolder} is not a folder`);
            }
        }
        const parentPath = destFolder ? destFolder.item.path : parentPathOf(source.item.path);
        const destPath =
            parentPath === null ? null : joinPath(parentPath, args.newName ?? source.item.name);
        this.assertAllowed("move", open.config, [source.item.path, destPath]);
        const moved = await this.call(open, () =>
            open.provider.move(
                open.drive,
                source.item.realId,
                { parentRealId: destFolder?.item.realId, name: args.newName },
                { ifRevision: args.ifRevision },
            ),
        );
        this.invalidate(open.config.alias);
        const result = await this.mounted(open, moved, destPath);
        this.deps.log.info(`storage: moved ${displayRefOf(source)} → ${displayRefOf(result)}`);
        return result;
    }

    /**
     * Copy a file into a folder, possibly on another mount. Same-mount
     * copies are delegated to the provider; cross-mount copies stream
     * through a host staging file. Only the target's write policy is
     * checked — reading the source is always allowed.
     */
    async copy(
        args: {
            readonly ref: string;
            readonly toFolder: string;
            readonly newName?: string;
            readonly conflict?: "fail" | "rename";
        },
        ctx: StorageCallContext,
    ): Promise<{ copied: MountedItem; bytes: number | null }> {
        if (args.newName !== undefined) {
            assertValidName(args.newName);
        }
        const source = await this.resolveRef(args.ref);
        const dest = await this.resolveRef(args.toFolder);
        if (dest.item.kind !== "folder") {
            throw new ToolError("NotAFolder", `to_folder ${args.toFolder} is not a folder`);
        }
        const destOpen = await this.openMount(dest.mount);
        const conflict = args.conflict ?? "fail";
        const sameMount = source.mount === dest.mount;
        if (sameMount && destOpen.caps.serverSideCopy && source.item.kind !== "native") {
            const destPath =
                dest.item.path === null
                    ? null
                    : joinPath(dest.item.path, args.newName ?? source.item.name);
            this.assertAllowed("copy", destOpen.config, [destPath]);
            const copied = await this.call(destOpen, () =>
                destOpen.provider.copy(
                    destOpen.drive,
                    source.item.realId,
                    { parentRealId: dest.item.realId, name: args.newName },
                    { conflict },
                ),
            );
            this.invalidate(destOpen.config.alias);
            const result = await this.mounted(destOpen, copied, destPath);
            this.deps.log.info(
                `storage: copied ${displayRefOf(source)} → ${displayRefOf(result)} (server-side)`,
            );
            return { copied: result, bytes: null };
        }
        if (source.item.kind === "folder") {
            throw new ToolError(
                "Unsupported",
                "folders can only be copied within one mount — copy the files one by one",
            );
        }
        const sourceOpen = await this.openMount(source.mount);
        // The native export may change the extension, so the final name is
        // only known after the download; check the folder now, the full path later.
        this.assertAllowed("copy", destOpen.config, [
            dest.item.path === null
                ? null
                : joinPath(dest.item.path, args.newName ?? source.item.name),
        ]);
        this.assertQuota(ctx.agentrunId, source.item.size ?? 0);
        const staging = await this.stagingPath();
        try {
            const result = await this.call(sourceOpen, () =>
                sourceOpen.provider.download(sourceOpen.drive, source.item.realId, staging),
            );
            const name = args.newName ?? result.fileName;
            assertValidName(name);
            this.assertAllowed("copy", destOpen.config, [
                dest.item.path === null ? null : joinPath(dest.item.path, name),
            ]);
            this.chargeBytes(ctx.agentrunId, result.bytes);
            const copied = await this.call(destOpen, () =>
                destOpen.provider.upload(
                    destOpen.drive,
                    dest.item.realId,
                    name,
                    { path: staging, size: result.bytes, mimeType: result.mimeType ?? undefined },
                    { conflict },
                ),
            );
            this.invalidate(destOpen.config.alias);
            const mountedCopy = await this.mounted(destOpen, copied);
            this.deps.log.info(
                `storage: run ${ctx.agentrunId} copied ${displayRefOf(source)} → ${displayRefOf(mountedCopy)} (cross-mount, ${formatBytes(result.bytes)})`,
            );
            return { copied: mountedCopy, bytes: result.bytes };
        } finally {
            await rm(staging, { force: true });
        }
    }

    /**
     * Move an item to the provider's trash. Never falls back to a hard
     * delete.
     */
    async delete(args: {
        readonly ref: string;
        readonly ifRevision?: string;
    }): Promise<MountedItem> {
        const target = await this.resolveRef(args.ref);
        const open = await this.openMount(target.mount);
        if (target.item.path === "/") {
            throw new ToolError("BadArgs", "the mount root cannot be deleted");
        }
        this.assertAllowed("trash", open.config, [target.item.path]);
        if (!open.caps.trash) {
            throw new ToolError(
                "Unsupported",
                `${open.config.plugin} has no trash for mount ${open.config.alias}; permanent deletion is not supported`,
            );
        }
        await this.call(open, () =>
            open.provider.trash(open.drive, target.item.realId, { ifRevision: args.ifRevision }),
        );
        this.invalidate(open.config.alias);
        this.deps.log.info(
            `storage: trashed ${displayRefOf(target)} (${formatIdRef(target.mount, target.item.realId)})`,
        );
        return target;
    }

    // ---- policy & quota -----------------------------------------------

    /**
     * The policy gate for every mutating operation: `storage.allowWrite`,
     * then the mount's `access`, then its `writeRoots`. A `null` path
     * (unresolvable location) is denied.
     *
     * @param op - Operation, for the message.
     * @param mount - Mount being changed.
     * @param paths - Every in-mount path the op changes (move: source and destination).
     * @throws ToolError `PolicyDenied`.
     */
    assertAllowed(op: StorageWriteOp, mount: MountConfig, paths: readonly (string | null)[]): void {
        const tail = " Tell the user; do not look for a workaround.";
        if (!this.settings().allowWrite) {
            throw new ToolError(
                "PolicyDenied",
                `${op} denied: writing to cloud storage is disabled (\`storage.allowWrite: false\` in the Familiar config).${tail}`,
            );
        }
        if (mount.access !== "readwrite") {
            throw new ToolError(
                "PolicyDenied",
                `${op} denied: mount "${mount.alias}" is read-only (\`access: read\`).${tail}`,
            );
        }
        for (const p of paths) {
            if (p === null) {
                throw new ToolError(
                    "PolicyDenied",
                    `${op} denied on mount "${mount.alias}": the item's location cannot be determined, and changes are only allowed inside ${mount.writeRoots.join(", ")}.${tail}`,
                );
            }
            if (!mount.writeRoots.some((root) => isPathInside(p, root))) {
                throw new ToolError(
                    "PolicyDenied",
                    `${op} denied: ${mount.alias}:${p} is outside the writable roots of mount "${mount.alias}" (${mount.writeRoots.join(", ")}).${tail}`,
                );
            }
        }
    }

    /**
     * Charge `bytes` against the run's quota.
     *
     * @throws ToolError `QuotaExceeded` when the budget would be exceeded.
     */
    chargeBytes(agentrunId: string, bytes: number): void {
        this.assertQuota(agentrunId, bytes);
        const entry = this.quotaEntry(agentrunId);
        entry.used += bytes;
    }

    /** @returns Bytes charged to the run so far. */
    bytesUsed(agentrunId: string): number {
        return this.quota.get(agentrunId)?.used ?? 0;
    }

    /**
     * Throw when charging `bytes` would exceed the run's quota.
     *
     * @throws ToolError `QuotaExceeded`.
     */
    private assertQuota(agentrunId: string, bytes: number): void {
        const limit = this.settings().runQuotaBytes;
        const used = this.quotaEntry(agentrunId).used;
        if (used + bytes > limit) {
            throw new ToolError(
                "QuotaExceeded",
                `storage byte budget for this run exhausted (${formatBytes(used)} of ${formatBytes(limit)} used, ${formatBytes(bytes)} requested; \`storage.runQuotaMb\`). Work with what you have or tell the user.`,
            );
        }
    }

    private quotaEntry(agentrunId: string): { used: number; touchedAt: number } {
        const now = this.now();
        for (const [id, entry] of this.quota) {
            if (now - entry.touchedAt > QUOTA_ENTRY_TTL_MS) {
                this.quota.delete(id);
            }
        }
        let entry = this.quota.get(agentrunId);
        if (!entry) {
            entry = { used: 0, touchedAt: now };
            this.quota.set(agentrunId, entry);
        }
        entry.touchedAt = now;
        return entry;
    }

    // ---- resolution ---------------------------------------------------

    /**
     * Resolve a ref to an existing item.
     *
     * @throws ToolError `NotFound`, `AmbiguousPath`, `UnknownMount`, `BadRef`.
     */
    async resolveRef(ref: string): Promise<MountedItem> {
        const parsed = parseRef(ref);
        const open = await this.openMount(parsed.mount);
        if (parsed.form === "id") {
            const item = await this.call(open, () => open.provider.stat(open.drive, parsed.realId));
            if (!item) {
                throw new ToolError("NotFound", `${ref} not found (it may have been deleted)`);
            }
            return this.mounted(open, item);
        }
        const found = await this.tryResolvePath(open, parsed.path);
        if (!found) {
            throw new ToolError("NotFound", `${ref} not found`);
        }
        return found;
    }

    /**
     * Resolve a create target: the item if it exists, otherwise the
     * normalized path and leaf name to create.
     */
    async resolveTarget(ref: string): Promise<{
        mount: string;
        path: string | null;
        leaf: string | null;
        existing: MountedItem | null;
    }> {
        const parsed: StorageRef = parseRef(ref);
        if (parsed.form === "id") {
            const existing = await this.resolveRef(ref);
            return {
                mount: parsed.mount,
                path: existing.item.path,
                leaf: existing.item.name,
                existing,
            };
        }
        const open = await this.openMount(parsed.mount);
        const { leaf } = splitParent(parsed.path);
        assertValidName(leaf);
        const existing = await this.tryResolvePath(open, parsed.path);
        return { mount: parsed.mount, path: parsed.path, leaf, existing };
    }

    /**
     * Resolve a path to one item, `null` when absent.
     *
     * @throws ToolError `AmbiguousPath` when several items match.
     */
    private async tryResolvePath(open: OpenMount, itemPath: string): Promise<MountedItem | null> {
        const normalized = normalizeItemPath(itemPath);
        let items: readonly StorageItem[];
        if (normalized === "/") {
            const root = await this.rootOf(open);
            const item = await this.call(open, () => open.provider.stat(open.drive, root));
            items = item ? [withPath(item, "/")] : [];
        } else if (open.caps.addressing === "path" && open.provider.resolvePath) {
            const resolvePath = open.provider.resolvePath.bind(open.provider);
            items = await this.call(open, () => resolvePath(open.drive, normalized));
        } else {
            items = await this.walkPath(open, normalized);
        }
        if (items.length === 0) {
            return null;
        }
        if (items.length > 1) {
            const candidates = items
                .map(
                    (i) =>
                        `${formatIdRef(open.config.alias, i.realId)} (modified ${i.modifiedUtc ?? "?"})`,
                )
                .join(", ");
            throw new ToolError(
                "AmbiguousPath",
                `${open.config.alias}:${normalized} matches ${items.length} items: ${candidates}. Use the id ref of the one you mean.`,
            );
        }
        return { mount: open.config.alias, item: withPath(items[0] as StorageItem, normalized) };
    }

    /** Walk the tree segment by segment for id-addressed providers, with a TTL cache. */
    private async walkPath(open: OpenMount, itemPath: string): Promise<readonly StorageItem[]> {
        const segments = itemPath.split("/").filter((s) => s.length > 0);
        let parents: readonly string[] = [await this.rootOf(open)];
        let prefix = "";
        let matches: StorageItem[] = [];
        for (const [index, segment] of segments.entries()) {
            prefix = `${prefix}/${segment}`;
            const isLast = index === segments.length - 1;
            const cacheKey = `${open.config.alias}\u0000${prefix}`;
            const cached = isLast ? undefined : this.pathCache.get(cacheKey);
            if (cached) {
                parents = cached;
                continue;
            }
            matches = [];
            for (const parentId of parents) {
                matches.push(...(await this.childrenNamed(open, parentId, segment)));
            }
            if (matches.length === 0) {
                return [];
            }
            if (!isLast) {
                const folders = matches.filter((m) => m.kind === "folder");
                if (folders.length === 0) {
                    return [];
                }
                parents = folders.map((m) => m.realId);
                this.pathCache.set(cacheKey, parents);
            }
        }
        return matches;
    }

    /** All children of `parentId` named exactly `name` (all pages). */
    private async childrenNamed(
        open: OpenMount,
        parentId: string,
        name: string,
    ): Promise<StorageItem[]> {
        const out: StorageItem[] = [];
        let cursor: string | undefined;
        do {
            const page = await this.call(open, () =>
                open.provider.list(open.drive, parentId, { limit: RESOLVE_PAGE_SIZE, cursor }),
            );
            out.push(...page.entries.filter((e) => e.name === name));
            cursor = page.nextCursor ?? undefined;
        } while (cursor !== undefined);
        return out;
    }

    /**
     * Make sure every folder along `folderPath` exists, creating missing
     * ones (each checked against the write policy).
     *
     * @returns The realId of the deepest folder.
     */
    private async ensureFolderPath(
        open: OpenMount,
        folderPath: string,
        enforcePolicy = true,
    ): Promise<string> {
        const segments = folderPath.split("/").filter((s) => s.length > 0);
        let currentId = await this.rootOf(open);
        let currentPath = "/";
        for (const segment of segments) {
            currentPath = joinPath(currentPath, segment);
            const existing = await this.tryResolvePath(open, currentPath);
            if (existing) {
                if (existing.item.kind !== "folder") {
                    throw new ToolError(
                        "NameConflict",
                        `${open.config.alias}:${currentPath} exists and is not a folder`,
                    );
                }
                currentId = existing.item.realId;
                continue;
            }
            if (enforcePolicy) {
                this.assertAllowed("mkdir", open.config, [currentPath]);
            }
            const parentId = currentId;
            const created = await this.call(open, () =>
                open.provider.createFolder(open.drive, parentId, segment, { conflict: "reuse" }),
            );
            currentId = created.realId;
            this.invalidate(open.config.alias);
        }
        return currentId;
    }

    /** Stat `realId` and return it mounted, with a known path. */
    private async statMounted(
        open: OpenMount,
        realId: string,
        knownPath: string,
    ): Promise<MountedItem> {
        const item = await this.call(open, () => open.provider.stat(open.drive, realId));
        if (!item) {
            throw new ToolError("NotFound", `${formatIdRef(open.config.alias, realId)} vanished`);
        }
        return { mount: open.config.alias, item: withPath(item, knownPath) };
    }

    /** Wrap an item with its mount, filling in the path by walking parents if needed. */
    private async mounted(
        open: OpenMount,
        item: StorageItem,
        knownPath?: string | null,
    ): Promise<MountedItem> {
        if (item.path !== null) {
            return { mount: open.config.alias, item };
        }
        const resolved = knownPath ?? (await this.pathByParents(open, item));
        return { mount: open.config.alias, item: withPath(item, resolved) };
    }

    /** Compute an item's path by walking its parent chain; `null` if it leaves the drive. */
    private async pathByParents(open: OpenMount, item: StorageItem): Promise<string | null> {
        const root = await this.rootOf(open);
        if (item.realId === root) {
            return "/";
        }
        const names = [item.name];
        let parentId = item.parentRealId;
        for (let depth = 0; depth < MAX_PARENT_WALK; depth++) {
            if (parentId === null) {
                return null;
            }
            if (parentId === root) {
                return `/${names.reverse().join("/")}`;
            }
            const current = parentId;
            const parent = await this.call(open, () => open.provider.stat(open.drive, current));
            if (!parent) {
                return null;
            }
            names.push(parent.name);
            parentId = parent.parentRealId;
        }
        return null;
    }

    private async rootOf(open: OpenMount): Promise<string> {
        return this.call(open, () => open.provider.rootRealId(open.drive));
    }

    /** Drop cached path lookups for a mount after a mutation. */
    private invalidate(alias: string): void {
        this.pathCache.deletePrefix(`${alias}\u0000`);
    }

    // ---- mounts -------------------------------------------------------

    /**
     * Look up a mount's config.
     *
     * @throws ToolError `UnknownMount`.
     */
    private mountConfig(alias: string): MountConfig {
        const mounts = this.settings().mounts;
        const config = mounts.find((m) => m.alias === alias);
        if (!config) {
            const known = mounts.map((m) => m.alias).join(", ") || "none configured";
            throw new ToolError("UnknownMount", `unknown mount "${alias}" (mounts: ${known})`);
        }
        return config;
    }

    /**
     * Resolve a mount to its provider and (memoized) drive handle.
     *
     * @throws ToolError `UnknownMount`, `ProviderUnavailable`, `AuthExpired`, `NotFound`.
     */
    async openMount(alias: string): Promise<OpenMount> {
        const config = this.mountConfig(alias);
        const provider = this.deps.registry.byPluginId(config.plugin);
        if (!provider) {
            throw new ToolError(
                "ProviderUnavailable",
                `mount "${alias}" uses plugin "${config.plugin}", which provides no storage (is the plugin enabled?)`,
            );
        }
        const signature = `${config.plugin}\u0000${config.account}\u0000${config.drive ?? ""}`;
        const cached = this.drives.get(alias);
        let drive = cached?.signature === signature ? cached.drive : undefined;
        if (!drive) {
            drive = await mapErrors(provider, config.account, () =>
                provider.openDrive(config.account, config.drive),
            );
            this.drives.set(alias, { signature, drive });
        }
        return { config, provider, drive, caps: provider.capabilities(drive) };
    }

    /** Run a provider call, mapping its errors. */
    private call<T>(open: OpenMount, fn: () => Promise<T>): Promise<T> {
        return mapErrors(open.provider, open.config.account, fn);
    }

    /** A fresh staging file path (the directory is created on demand). */
    private async stagingPath(): Promise<string> {
        await mkdir(this.deps.stagingDir, { recursive: true });
        return path.join(this.deps.stagingDir, `${randomBytes(8).toString("hex")}.part`);
    }
}

// ---- helpers ------------------------------------------------------------

/**
 * Run `fn`, mapping provider failures onto agent-readable
 * {@link ToolError}s.
 */
async function mapErrors<T>(
    provider: StorageProvider,
    account: string,
    fn: () => Promise<T>,
): Promise<T> {
    try {
        return await fn();
    } catch (err) {
        throw toToolError(err, provider, account);
    }
}

/**
 * Map an arbitrary error from a provider call to a {@link ToolError}.
 *
 * @param err - What the provider threw.
 * @param provider - For the plugin id and the login hint.
 * @param account - Account the call ran under.
 */
export function toToolError(err: unknown, provider: StorageProvider, account: string): ToolError {
    if (err instanceof ToolError) {
        return err;
    }
    if (!(err instanceof StorageError)) {
        return new ToolError("ProviderUnavailable", `${provider.pluginId}: ${errorMessage(err)}`);
    }
    const base = err.message;
    switch (err.code) {
        case "RevisionMismatch":
            return new ToolError(
                err.code,
                `${base} — re-read the item (storage_stat) and retry with the new rev.`,
            );
        case "Unsupported":
            return new ToolError(
                err.code,
                base.startsWith(provider.pluginId) ? base : `${provider.pluginId}: ${base}`,
            );
        case "AuthExpired":
            return new ToolError(
                err.code,
                `${provider.pluginId} login for ${account} is missing or expired (${base}). Tell the user to run \`${provider.loginCommand(account)}\`.`,
            );
        case "RateLimited":
            return new ToolError(
                err.code,
                `${provider.pluginId} is rate-limiting requests (${base}); try again later.`,
            );
        default:
            return new ToolError(err.code, base);
    }
}

/** Timeout marker for the search fan-out. */
class TimeoutError extends Error {}

/**
 * Run `fn` with an abort signal that fires after `ms`; rejects with
 * {@link TimeoutError} even if `fn` ignores the signal.
 */
async function withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            controller.abort(new TimeoutError("timeout"));
            reject(new TimeoutError("timeout"));
        }, ms);
    });
    try {
        return await Promise.race([fn(controller.signal), timeout]);
    } finally {
        clearTimeout(timer);
    }
}

/** Encode the composite search cursor (`{mount: providerCursor}`). */
export function encodeCursor(cursors: Readonly<Record<string, string>>): string {
    return Buffer.from(JSON.stringify(cursors), "utf8").toString("base64url");
}

/**
 * Decode a composite search cursor.
 *
 * @throws ToolError `BadCursor`.
 */
export function decodeCursor(cursor: string): Record<string, string> {
    try {
        const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
        if (
            typeof parsed === "object" &&
            parsed !== null &&
            !Array.isArray(parsed) &&
            Object.values(parsed).every((v) => typeof v === "string")
        ) {
            return parsed as Record<string, string>;
        }
    } catch {
        // fall through to the agent-facing error below
    }
    throw new ToolError(
        "BadCursor",
        "invalid cursor — pass the next_cursor value from the previous result header unchanged",
    );
}

/** Service-side post-filter for search hits. */
function matchesFilters(
    item: StorageItem,
    args: StorageSearchArgs,
    underPath: string | null,
): boolean {
    if (args.kind !== undefined && item.kind !== args.kind) {
        return false;
    }
    if (args.mimePrefix !== undefined && !(item.mimeType ?? "").startsWith(args.mimePrefix)) {
        return false;
    }
    if (
        args.modifiedFromUtc !== undefined &&
        (item.modifiedUtc === null ||
            Date.parse(item.modifiedUtc) < Date.parse(args.modifiedFromUtc))
    ) {
        return false;
    }
    if (
        args.modifiedToUtc !== undefined &&
        (item.modifiedUtc === null ||
            Date.parse(item.modifiedUtc) >= Date.parse(args.modifiedToUtc))
    ) {
        return false;
    }
    if (
        underPath !== null &&
        item.path !== null &&
        (item.path === underPath || !isPathInside(item.path, underPath))
    ) {
        return false;
    }
    return true;
}

/** Sort a page client-side (providers may already have done so). */
function sortItems(items: readonly MountedItem[], order: StorageListOrder): MountedItem[] {
    const sorted = [...items];
    if (order === "modified_desc") {
        sorted.sort((a, b) => (b.item.modifiedUtc ?? "").localeCompare(a.item.modifiedUtc ?? ""));
    } else {
        sorted.sort((a, b) =>
            a.item.name.localeCompare(b.item.name, undefined, { sensitivity: "base" }),
        );
    }
    return sorted;
}

/** Return `item` with `path` set (unless already known). */
function withPath(item: StorageItem, itemPath: string | null): StorageItem {
    return item.path !== null || itemPath === null ? item : { ...item, path: itemPath };
}

/** Path of a child given its parent's path. */
function childPath(parentPath: string | null, child: StorageItem): string | null {
    return child.path ?? (parentPath === null ? null : joinPath(parentPath, child.name));
}

/** Parent path of an item path. */
function parentPathOf(itemPath: string | null): string | null {
    if (itemPath === null || itemPath === "/") {
        return null;
    }
    return splitParent(itemPath).parent;
}

/**
 * Reject names that cannot be a single path segment.
 *
 * @throws ToolError `BadName`.
 */
function assertValidName(name: string): void {
    if (
        name.length === 0 ||
        name === "." ||
        name === ".." ||
        /[/\\]/.test(name) ||
        name.includes("\0")
    ) {
        throw new ToolError("BadName", `invalid file name "${name}"`);
    }
}

/** Display ref for messages: path form when known, else id form. */
function displayRefOf(m: MountedItem): string {
    return m.item.path !== null ? `${m.mount}:${m.item.path}` : formatIdRef(m.mount, m.item.realId);
}

/** Human-readable byte count (`4.2 kB`, `12.0 MB`). */
export function formatBytes(bytes: number): string {
    if (bytes < 1000) {
        return `${bytes} B`;
    }
    const units = ["kB", "MB", "GB", "TB"];
    let value = bytes / 1000;
    let unit = 0;
    while (value >= 1000 && unit < units.length - 1) {
        value /= 1000;
        unit++;
    }
    return `${value.toFixed(1)} ${units[unit]}`;
}

/** Message of an unknown throwable. */
function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
