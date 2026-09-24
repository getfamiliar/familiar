import { readFile, writeFile } from "node:fs/promises";
import {
    type StorageCapabilities,
    type StorageConflict,
    type StorageDownloadResult,
    type StorageDrive,
    StorageError,
    type StorageItem,
    type StorageItemKind,
    type StorageListOrder,
    type StoragePage,
    type StoragePageOptions,
    type StorageProvider,
    type StorageSearchHit,
    type StorageSearchQuery,
    type StorageUploadSource,
} from "../Storage.js";

/** Which real provider the fake imitates. */
export type FakeStorageFlavor = "onedrive" | "gdrive" | "dropbox";

/** Google-style native doc mime types and their export mapping. */
export const FAKE_NATIVE_EXPORTS: Readonly<Record<string, { mime: string; ext: string }>> = {
    "application/vnd.google-apps.document": {
        mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ext: ".docx",
    },
    "application/vnd.google-apps.spreadsheet": {
        mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ext: ".xlsx",
    },
    "application/vnd.google-apps.presentation": {
        mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        ext: ".pptx",
    },
    "application/vnd.google-apps.drawing": { mime: "application/pdf", ext: ".pdf" },
};

/** Behaviour knobs for tests. */
export interface FakeStorageOptions {
    readonly pluginId?: string;
    readonly flavor?: FakeStorageFlavor;
    /** Accounts and their drives (selector `null` = primary). Default: one account `a@x` with a primary drive. */
    readonly accounts?: Readonly<
        Record<string, readonly { selector: string | null; name: string }[]>
    >;
    /** Accounts whose calls throw `AuthExpired`. */
    readonly expiredAccounts?: readonly string[];
    /** Accounts whose `listDrives` throws `ProviderUnavailable`. */
    readonly brokenAccounts?: readonly string[];
    /** Artificial search latency (honours the abort signal). */
    readonly searchDelayMs?: number;
    /** Make every search throw this error. */
    readonly searchError?: Error;
    /** Override `contentSearch`. */
    readonly contentSearch?: boolean;
    /** Override `trash`. */
    readonly trash?: boolean;
}

interface FakeNode {
    realId: string;
    parentRealId: string | null;
    name: string;
    kind: StorageItemKind;
    mimeType: string | null;
    content: Buffer | null;
    createdUtc: string;
    modifiedUtc: string;
    revision: number;
    trashed: boolean;
}

interface FakeDriveState {
    readonly drive: StorageDrive;
    readonly rootId: string;
    readonly nodes: Map<string, FakeNode>;
}

/**
 * In-memory {@link StorageProvider} for service, tool, CLI and contract
 * tests. Imitates OneDrive (path addressing, unique names), Google
 * Drive (id addressing, duplicate names, native docs) or Dropbox
 * (path addressing, no content search). Content lives in memory;
 * download / upload still go through real host files so the byte paths
 * are exercised.
 */
export class FakeStorageProvider implements StorageProvider {
    readonly pluginId: string;
    readonly flavor: FakeStorageFlavor;
    private readonly drives = new Map<string, FakeDriveState>();
    private readonly options: FakeStorageOptions;
    private nextId = 1;
    private clock = Date.parse("2026-01-01T00:00:00Z");

    /**
     * @param options - Behaviour knobs; see {@link FakeStorageOptions}.
     */
    constructor(options: FakeStorageOptions = {}) {
        this.options = options;
        this.pluginId = options.pluginId ?? "fake";
        this.flavor = options.flavor ?? "onedrive";
        const accounts = options.accounts ?? { "a@x": [{ selector: null, name: "Primary" }] };
        for (const [account, drives] of Object.entries(accounts)) {
            for (const d of drives) {
                const id = `drv-${account}-${d.selector ?? "primary"}`;
                const rootId = this.newId();
                const drive: StorageDrive = {
                    account,
                    selector: d.selector,
                    id,
                    name: d.name,
                    kind: d.selector === null ? "personal" : "team",
                };
                const nodes = new Map<string, FakeNode>();
                nodes.set(rootId, this.makeNode(rootId, null, "", "folder", null, null));
                this.drives.set(driveKey(account, d.selector), { drive, rootId, nodes });
            }
        }
    }

    /** @returns The capabilities of the imitated provider. */
    capabilities(_drive: StorageDrive): StorageCapabilities {
        const isGdrive = this.flavor === "gdrive";
        return {
            addressing: isGdrive ? "id" : "path",
            uniqueNames: !isGdrive,
            contentSearch: this.options.contentSearch ?? this.flavor !== "dropbox",
            searchSnippets: false,
            trash: this.options.trash ?? true,
            nativeDocs: isGdrive,
            serverSideCopy: true,
        };
    }

    /** @returns All configured accounts. */
    async listAccounts(): Promise<readonly string[]> {
        return [...new Set([...this.drives.values()].map((d) => d.drive.account))];
    }

    /** @returns A fake login command. */
    loginCommand(account: string): string {
        return `familiar ${this.pluginId} login ${account}`;
    }

    /** @returns The account's drives, filtered and capped. */
    async listDrives(
        account: string,
        options: { readonly limit: number; readonly search?: string },
    ): Promise<readonly StorageDrive[]> {
        this.assertAccount(account);
        if (this.options.brokenAccounts?.includes(account)) {
            throw new StorageError("ProviderUnavailable", `fake outage for ${account}`);
        }
        const search = options.search?.toLowerCase();
        return [...this.drives.values()]
            .map((d) => d.drive)
            .filter((d) => d.account === account)
            .filter((d) => search === undefined || d.name.toLowerCase().includes(search))
            .slice(0, options.limit);
    }

    /** @returns The drive for `selector`. */
    async openDrive(account: string, selector: string | null): Promise<StorageDrive> {
        this.assertAccount(account);
        const state = this.drives.get(driveKey(account, selector));
        if (!state) {
            throw new StorageError(
                "NotFound",
                `no drive "${selector ?? "(primary)"}" for ${account}`,
            );
        }
        return state.drive;
    }

    /** @returns The root folder id. */
    async rootRealId(drive: StorageDrive): Promise<string> {
        return this.state(drive).rootId;
    }

    /** @returns The item or `null`. */
    async stat(drive: StorageDrive, realId: string): Promise<StorageItem | null> {
        const node = this.state(drive).nodes.get(realId);
        return node && !node.trashed ? this.toItem(drive, node) : null;
    }

    /** Native path resolution (only for path-addressed flavors). */
    get resolvePath():
        | ((drive: StorageDrive, path: string) => Promise<readonly StorageItem[]>)
        | undefined {
        if (this.flavor === "gdrive") {
            return undefined;
        }
        return async (drive, path) => {
            const state = this.state(drive);
            const segments = path.split("/").filter((s) => s.length > 0);
            let current = [state.nodes.get(state.rootId) as FakeNode];
            for (const seg of segments) {
                current = current.flatMap((parent) =>
                    this.children(state, parent.realId).filter(
                        (c) => c.name.toLowerCase() === seg.toLowerCase(),
                    ),
                );
            }
            return current.map((n) => this.toItem(drive, n));
        };
    }

    /** @returns One page of children. */
    async list(
        drive: StorageDrive,
        folderRealId: string,
        options: StoragePageOptions & { readonly order?: StorageListOrder },
    ): Promise<StoragePage<StorageItem>> {
        const state = this.state(drive);
        const folder = state.nodes.get(folderRealId);
        if (!folder || folder.trashed) {
            throw new StorageError("NotFound", `folder ${folderRealId} not found`);
        }
        const all = this.children(state, folderRealId).map((n) => this.toItem(drive, n));
        return paginate(all, options);
    }

    /** @returns One page of name / content hits. */
    async search(
        drive: StorageDrive,
        query: StorageSearchQuery,
        options: StoragePageOptions,
    ): Promise<StoragePage<StorageSearchHit>> {
        if (this.options.searchDelayMs !== undefined) {
            await delay(this.options.searchDelayMs, options.signal);
        }
        if (this.options.searchError) {
            throw this.options.searchError;
        }
        this.assertAccount(drive.account);
        const state = this.state(drive);
        const needle = query.text.toLowerCase();
        const contentSearch = this.capabilities(drive).contentSearch;
        const hits: StorageSearchHit[] = [];
        for (const node of state.nodes.values()) {
            if (node.trashed || node.realId === state.rootId) {
                continue;
            }
            if (node.name.toLowerCase().includes(needle)) {
                hits.push({ item: this.toItem(drive, node), matchedIn: "name" });
                continue;
            }
            if (contentSearch && node.content?.toString("utf8").toLowerCase().includes(needle)) {
                hits.push({ item: this.toItem(drive, node), matchedIn: "content" });
            }
        }
        return paginate(hits, options);
    }

    /** Write the bytes (or the native export) to `destPath`. */
    async download(
        drive: StorageDrive,
        realId: string,
        destPath: string,
    ): Promise<StorageDownloadResult> {
        const node = this.requireNode(drive, realId);
        if (node.kind === "folder") {
            throw new StorageError("Unsupported", `${node.name} is a folder`);
        }
        if (node.kind === "native") {
            const mapping = node.mimeType ? FAKE_NATIVE_EXPORTS[node.mimeType] : undefined;
            if (!mapping) {
                throw new StorageError(
                    "Unsupported",
                    `${this.pluginId}: native type ${node.mimeType} cannot be exported`,
                );
            }
            const bytes = Buffer.from(`exported:${node.name}`);
            await writeFile(destPath, bytes);
            return {
                bytes: bytes.length,
                mimeType: mapping.mime,
                fileName: node.name + mapping.ext,
            };
        }
        const bytes = node.content ?? Buffer.alloc(0);
        await writeFile(destPath, bytes);
        return { bytes: bytes.length, mimeType: node.mimeType, fileName: node.name };
    }

    /** Upload from a host file with conflict / revision semantics. */
    async upload(
        drive: StorageDrive,
        parentRealId: string,
        name: string,
        source: StorageUploadSource,
        options: {
            readonly conflict: StorageConflict;
            readonly replaceRealId?: string;
            readonly ifRevision?: string;
        },
    ): Promise<StorageItem> {
        const state = this.state(drive);
        this.requireFolder(state, parentRealId);
        const content = await readFile(source.path);
        if (options.conflict === "replace") {
            if (options.replaceRealId === undefined) {
                throw new Error("fake: conflict=replace requires replaceRealId");
            }
            const existing = this.requireNode(drive, options.replaceRealId);
            if (existing.kind !== "file") {
                throw new StorageError("Unsupported", `${existing.name} is not a file`);
            }
            this.checkRevision(existing, options.ifRevision);
            existing.content = content;
            existing.revision += 1;
            existing.modifiedUtc = this.tick();
            if (source.mimeType) {
                existing.mimeType = source.mimeType;
            }
            return this.toItem(drive, existing);
        }
        const clash =
            this.flavor === "gdrive" ? undefined : this.childNamed(state, parentRealId, name);
        if (clash) {
            if (options.conflict === "fail") {
                throw new StorageError("NameConflict", `${name} already exists`);
            }
            name = this.freeName(state, parentRealId, name);
        }
        const node = this.makeNode(
            this.newId(),
            parentRealId,
            name,
            "file",
            source.mimeType ?? "application/octet-stream",
            content,
        );
        state.nodes.set(node.realId, node);
        return this.toItem(drive, node);
    }

    /** Create a folder. */
    async createFolder(
        drive: StorageDrive,
        parentRealId: string,
        name: string,
        options: { readonly conflict: "fail" | "rename" | "reuse" },
    ): Promise<StorageItem> {
        const state = this.state(drive);
        this.requireFolder(state, parentRealId);
        const existing = this.childNamed(state, parentRealId, name);
        if (existing) {
            if (options.conflict === "reuse" && existing.kind === "folder") {
                return this.toItem(drive, existing);
            }
            if (options.conflict === "fail" || options.conflict === "reuse") {
                throw new StorageError("NameConflict", `${name} already exists`);
            }
            name = this.freeName(state, parentRealId, name);
        }
        const node = this.makeNode(this.newId(), parentRealId, name, "folder", null, null);
        state.nodes.set(node.realId, node);
        return this.toItem(drive, node);
    }

    /** Move / rename. */
    async move(
        drive: StorageDrive,
        realId: string,
        target: { readonly parentRealId?: string; readonly name?: string },
        options: { readonly ifRevision?: string },
    ): Promise<StorageItem> {
        const state = this.state(drive);
        const node = this.requireNode(drive, realId);
        this.checkRevision(node, options.ifRevision);
        const parent = target.parentRealId ?? node.parentRealId ?? state.rootId;
        this.requireFolder(state, parent);
        const name = target.name ?? node.name;
        const clash = this.childNamed(state, parent, name);
        if (clash && clash.realId !== node.realId && this.flavor !== "gdrive") {
            throw new StorageError("NameConflict", `${name} already exists`);
        }
        node.parentRealId = parent;
        node.name = name;
        node.revision += 1;
        node.modifiedUtc = this.tick();
        return this.toItem(drive, node);
    }

    /** Server-side copy (files only in the fake). */
    async copy(
        drive: StorageDrive,
        realId: string,
        target: { readonly parentRealId: string; readonly name?: string },
        options: { readonly conflict: "fail" | "rename" },
    ): Promise<StorageItem> {
        const state = this.state(drive);
        const node = this.requireNode(drive, realId);
        this.requireFolder(state, target.parentRealId);
        let name = target.name ?? node.name;
        if (this.childNamed(state, target.parentRealId, name) && this.flavor !== "gdrive") {
            if (options.conflict === "fail") {
                throw new StorageError("NameConflict", `${name} already exists`);
            }
            name = this.freeName(state, target.parentRealId, name);
        }
        const copy = this.makeNode(
            this.newId(),
            target.parentRealId,
            name,
            node.kind,
            node.mimeType,
            node.content,
        );
        state.nodes.set(copy.realId, copy);
        return this.toItem(drive, copy);
    }

    /** Soft delete (recursive). */
    async trash(
        drive: StorageDrive,
        realId: string,
        options: { readonly ifRevision?: string },
    ): Promise<void> {
        if (!this.capabilities(drive).trash) {
            throw new StorageError("Unsupported", `${this.pluginId} has no trash`);
        }
        const state = this.state(drive);
        const node = this.requireNode(drive, realId);
        this.checkRevision(node, options.ifRevision);
        const mark = (n: FakeNode): void => {
            n.trashed = true;
            for (const child of this.children(state, n.realId)) {
                mark(child);
            }
        };
        mark(node);
    }

    // ---- test seeding -------------------------------------------------

    /**
     * Seed an item under `parentPath` (folders are created as needed).
     * Duplicates are allowed for the gdrive flavor.
     *
     * @returns The seeded item's realId.
     */
    seed(
        account: string,
        selector: string | null,
        path: string,
        options: { kind?: StorageItemKind; content?: string; mimeType?: string } = {},
    ): string {
        const state = this.drives.get(driveKey(account, selector));
        if (!state) {
            throw new Error(`fake: no drive ${account}/${selector}`);
        }
        const segments = path.split("/").filter((s) => s.length > 0);
        let parentId = state.rootId;
        for (const seg of segments.slice(0, -1)) {
            const existing = this.childNamed(state, parentId, seg);
            if (existing) {
                parentId = existing.realId;
                continue;
            }
            const folder = this.makeNode(this.newId(), parentId, seg, "folder", null, null);
            state.nodes.set(folder.realId, folder);
            parentId = folder.realId;
        }
        const kind = options.kind ?? "file";
        const leaf = segments[segments.length - 1] ?? "";
        const node = this.makeNode(
            this.newId(),
            parentId,
            leaf,
            kind,
            kind === "folder" ? null : (options.mimeType ?? "text/plain"),
            kind === "file" ? Buffer.from(options.content ?? "") : null,
        );
        state.nodes.set(node.realId, node);
        return node.realId;
    }

    /** Test helper: raw content of an item, or `null`. */
    contentOf(account: string, selector: string | null, realId: string): string | null {
        return (
            this.drives
                .get(driveKey(account, selector))
                ?.nodes.get(realId)
                ?.content?.toString("utf8") ?? null
        );
    }

    /** Test helper: whether an item is in the trash. */
    isTrashed(account: string, selector: string | null, realId: string): boolean {
        return this.drives.get(driveKey(account, selector))?.nodes.get(realId)?.trashed === true;
    }

    // ---- internals ----------------------------------------------------

    private state(drive: StorageDrive): FakeDriveState {
        this.assertAccount(drive.account);
        const state = this.drives.get(driveKey(drive.account, drive.selector));
        if (!state) {
            throw new StorageError("NotFound", `unknown drive ${drive.id}`);
        }
        return state;
    }

    private assertAccount(account: string): void {
        if (this.options.expiredAccounts?.includes(account)) {
            throw new StorageError("AuthExpired", `login for ${account} expired`);
        }
        if (![...this.drives.values()].some((d) => d.drive.account === account)) {
            throw new StorageError("AuthExpired", `no login for ${account}`);
        }
    }

    private requireNode(drive: StorageDrive, realId: string): FakeNode {
        const node = this.state(drive).nodes.get(realId);
        if (!node || node.trashed) {
            throw new StorageError("NotFound", `item ${realId} not found`);
        }
        return node;
    }

    private requireFolder(state: FakeDriveState, realId: string): void {
        const node = state.nodes.get(realId);
        if (!node || node.trashed || node.kind !== "folder") {
            throw new StorageError("NotFound", `folder ${realId} not found`);
        }
    }

    private checkRevision(node: FakeNode, ifRevision: string | undefined): void {
        if (ifRevision !== undefined && ifRevision !== String(node.revision)) {
            throw new StorageError(
                "RevisionMismatch",
                `${node.name} changed (rev ${node.revision})`,
            );
        }
    }

    private children(state: FakeDriveState, parentId: string): FakeNode[] {
        return [...state.nodes.values()].filter((n) => n.parentRealId === parentId && !n.trashed);
    }

    private childNamed(
        state: FakeDriveState,
        parentId: string,
        name: string,
    ): FakeNode | undefined {
        return this.children(state, parentId).find(
            (n) => n.name.toLowerCase() === name.toLowerCase(),
        );
    }

    private freeName(state: FakeDriveState, parentId: string, name: string): string {
        const dot = name.lastIndexOf(".");
        const stem = dot > 0 ? name.slice(0, dot) : name;
        const ext = dot > 0 ? name.slice(dot) : "";
        for (let i = 1; ; i++) {
            const candidate = `${stem} ${i}${ext}`;
            if (!this.childNamed(state, parentId, candidate)) {
                return candidate;
            }
        }
    }

    private pathOf(state: FakeDriveState, node: FakeNode): string | null {
        const parts: string[] = [];
        let current: FakeNode | undefined = node;
        while (current && current.realId !== state.rootId) {
            parts.unshift(current.name);
            current = current.parentRealId ? state.nodes.get(current.parentRealId) : undefined;
            if (current === undefined) {
                return null;
            }
        }
        return `/${parts.join("/")}`;
    }

    private toItem(drive: StorageDrive, node: FakeNode): StorageItem {
        const state = this.state(drive);
        return {
            realId: node.realId,
            parentRealId: node.parentRealId,
            name: node.name,
            // The gdrive flavor, like the real API, does not report paths.
            path: this.flavor === "gdrive" ? null : this.pathOf(state, node),
            kind: node.kind,
            mimeType: node.mimeType,
            size: node.kind === "file" ? (node.content?.length ?? 0) : null,
            createdUtc: node.createdUtc,
            modifiedUtc: node.modifiedUtc,
            modifiedBy: "Fake User",
            revision: String(node.revision),
            contentHash: null,
            webUrl: `https://fake.example/${node.realId}`,
            isShared: false,
        };
    }

    private makeNode(
        realId: string,
        parentRealId: string | null,
        name: string,
        kind: StorageItemKind,
        mimeType: string | null,
        content: Buffer | null,
    ): FakeNode {
        const now = this.tick();
        return {
            realId,
            parentRealId,
            name,
            kind,
            mimeType,
            content,
            createdUtc: now,
            modifiedUtc: now,
            revision: 1,
            trashed: false,
        };
    }

    private newId(): string {
        return `id${this.nextId++}`;
    }

    private tick(): string {
        this.clock += 60_000;
        return new Date(this.clock).toISOString().replace(/\.\d{3}Z$/, "Z");
    }
}

/** Map key of one drive. */
function driveKey(account: string, selector: string | null): string {
    return `${account}\u0000${selector ?? ""}`;
}

/** Offset-cursor pagination over an in-memory array. */
function paginate<T>(all: readonly T[], options: StoragePageOptions): StoragePage<T> {
    const offset = options.cursor !== undefined ? Number.parseInt(options.cursor, 10) : 0;
    const entries = all.slice(offset, offset + options.limit);
    const next = offset + entries.length;
    return { entries, nextCursor: next < all.length ? String(next) : null };
}

/**
 * Sleep `ms`, rejecting early when `signal` aborts.
 *
 * @throws The signal's abort reason.
 */
function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                reject(signal.reason);
            },
            { once: true },
        );
    });
}
