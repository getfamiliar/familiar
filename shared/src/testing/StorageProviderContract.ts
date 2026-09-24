import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
    type StorageDrive,
    StorageError,
    type StorageItem,
    type StorageProvider,
} from "../Storage.js";

/** Settings for one contract run. */
export interface StorageContractOptions {
    /** Account to test against; must be logged in. */
    readonly account: string;
    /** Drive selector (`null` = primary drive). */
    readonly selector: string | null;
    /**
     * Existing folder path (absolute within the drive) the suite may write
     * into. The suite creates and trashes a uniquely named sub-folder.
     * Default: the drive root.
     */
    readonly basePath?: string;
    /** Also upload a file of this many bytes (exercises resumable uploads). */
    readonly largeFileBytes?: number;
}

/**
 * Shared behavioural contract every {@link StorageProvider} must pass.
 * Registered as a `node:test` suite; run it from a provider package's
 * test file against the in-memory fake (always) and against a real
 * account behind an env flag, e.g.:
 *
 * ```ts
 * const upn = process.env.FAMILIAR_LIVE_MS365;
 * if (upn) runStorageProviderContract("ms365 live", () => makeProvider(), { account: upn, selector: null });
 * ```
 *
 * @param name - Suite name.
 * @param makeProvider - Factory for the provider under test.
 * @param options - Account, drive and scratch-folder settings.
 */
export function runStorageProviderContract(
    name: string,
    makeProvider: () => StorageProvider | Promise<StorageProvider>,
    options: StorageContractOptions,
): void {
    describe(`StorageProvider contract: ${name}`, () => {
        let provider: StorageProvider;
        let drive: StorageDrive;
        let base: StorageItem;
        let localDir: string;

        before(async () => {
            provider = await makeProvider();
            drive = await provider.openDrive(options.account, options.selector);
            localDir = await mkdtemp(path.join(tmpdir(), "storage-contract-"));
            const parentId = await resolveBase(provider, drive, options.basePath);
            const suffix = randomBytes(4).toString("hex");
            base = await provider.createFolder(drive, parentId, `familiar-contract-${suffix}`, {
                conflict: "fail",
            });
        });

        after(async () => {
            if (base) {
                await provider.trash(drive, base.realId, {}).catch(() => undefined);
            }
            if (localDir) {
                await rm(localDir, { recursive: true, force: true });
            }
        });

        it("lists the account and opens its drive", async () => {
            const accounts = await provider.listAccounts();
            assert.ok(accounts.includes(options.account), `accounts: ${accounts.join(", ")}`);
            const drives = await provider.listDrives(options.account, { limit: 50 });
            assert.ok(
                drives.some((d) => d.id === drive.id),
                "opened drive is listed",
            );
        });

        it("rejects an unknown drive selector with NotFound", async () => {
            await assert.rejects(
                provider.openDrive(options.account, "drives/definitely-not-a-drive"),
                isStorageError("NotFound"),
            );
        });

        it("stats the root as a folder", async () => {
            const root = await provider.stat(drive, await provider.rootRealId(drive));
            assert.equal(root?.kind, "folder");
        });

        it("creates folders with fail / reuse semantics", async () => {
            const folder = await provider.createFolder(drive, base.realId, "sub", {
                conflict: "fail",
            });
            assert.equal(folder.kind, "folder");
            const again = await provider.createFolder(drive, base.realId, "sub", {
                conflict: "reuse",
            });
            assert.equal(again.realId, folder.realId);
            if (provider.capabilities(drive).uniqueNames) {
                await assert.rejects(
                    provider.createFolder(drive, base.realId, "sub", { conflict: "fail" }),
                    isStorageError("NameConflict"),
                );
            }
        });

        it("uploads, lists, stats and downloads a file byte-for-byte", async () => {
            const src = path.join(localDir, "hello.txt");
            await writeFile(src, "hello contract");
            const item = await provider.upload(
                drive,
                base.realId,
                "hello.txt",
                { path: src, size: 14, mimeType: "text/plain" },
                { conflict: "fail" },
            );
            assert.equal(item.kind, "file");
            assert.equal(item.size, 14);
            assert.ok(item.revision, "upload returns a revision");

            const page = await provider.list(drive, base.realId, { limit: 50 });
            assert.ok(page.entries.some((e) => e.realId === item.realId));

            const stat = await provider.stat(drive, item.realId);
            assert.equal(stat?.name, "hello.txt");

            const dest = path.join(localDir, "hello.down");
            const result = await provider.download(drive, item.realId, dest);
            assert.equal(result.bytes, 14);
            assert.equal(await readFile(dest, "utf8"), "hello contract");
        });

        it("honours conflict=fail and guarded replace", async () => {
            const src = path.join(localDir, "rev.txt");
            await writeFile(src, "v1");
            const v1 = await provider.upload(
                drive,
                base.realId,
                "rev.txt",
                { path: src, size: 2 },
                { conflict: "fail" },
            );
            if (provider.capabilities(drive).uniqueNames) {
                await assert.rejects(
                    provider.upload(
                        drive,
                        base.realId,
                        "rev.txt",
                        { path: src, size: 2 },
                        { conflict: "fail" },
                    ),
                    isStorageError("NameConflict"),
                );
            }
            await writeFile(src, "v2!");
            const v2 = await provider.upload(
                drive,
                base.realId,
                "rev.txt",
                { path: src, size: 3 },
                {
                    conflict: "replace",
                    replaceRealId: v1.realId,
                    ifRevision: v1.revision ?? undefined,
                },
            );
            assert.equal(v2.realId, v1.realId);
            assert.notEqual(v2.revision, v1.revision);
            await assert.rejects(
                provider.upload(
                    drive,
                    base.realId,
                    "rev.txt",
                    { path: src, size: 3 },
                    {
                        conflict: "replace",
                        replaceRealId: v1.realId,
                        ifRevision: v1.revision ?? "stale",
                    },
                ),
                isStorageError("RevisionMismatch"),
            );
        });

        it("renames, moves, copies and trashes", async () => {
            const src = path.join(localDir, "mv.txt");
            await writeFile(src, "move me");
            const file = await provider.upload(
                drive,
                base.realId,
                "mv.txt",
                { path: src, size: 7 },
                { conflict: "fail" },
            );
            const dest = await provider.createFolder(drive, base.realId, "dest", {
                conflict: "reuse",
            });
            const renamed = await provider.move(drive, file.realId, { name: "moved.txt" }, {});
            assert.equal(renamed.name, "moved.txt");
            const moved = await provider.move(
                drive,
                file.realId,
                { parentRealId: dest.realId },
                {},
            );
            assert.equal(moved.parentRealId, dest.realId);
            const copied = await provider.copy(
                drive,
                file.realId,
                { parentRealId: base.realId, name: "copy.txt" },
                { conflict: "fail" },
            );
            assert.equal(copied.name, "copy.txt");
            await provider.trash(drive, copied.realId, {});
            assert.equal(await provider.stat(drive, copied.realId), null);
        });

        it("resolves paths natively when path-addressed", async () => {
            if (provider.capabilities(drive).addressing !== "path" || !provider.resolvePath) {
                return;
            }
            const basePath = (await provider.stat(drive, base.realId))?.path;
            assert.ok(basePath, "path-addressed providers report paths");
            const hits = await provider.resolvePath(drive, `${basePath}/sub`);
            assert.equal(hits.length, 1);
            assert.deepEqual(
                await provider.resolvePath(drive, `${basePath}/nope-${Date.now()}`),
                [],
            );
        });

        it("uploads a large file", { skip: options.largeFileBytes === undefined }, async () => {
            const size = options.largeFileBytes ?? 0;
            const src = path.join(localDir, "large.bin");
            await writeFile(src, randomBytes(size));
            const item = await provider.upload(
                drive,
                base.realId,
                "large.bin",
                { path: src, size },
                { conflict: "fail" },
            );
            assert.equal(item.size, size);
        });
    });
}

/**
 * Resolve the base folder the suite writes into.
 *
 * @throws Error when `basePath` does not resolve to exactly one folder.
 */
async function resolveBase(
    provider: StorageProvider,
    drive: StorageDrive,
    basePath: string | undefined,
): Promise<string> {
    const root = await provider.rootRealId(drive);
    if (basePath === undefined || basePath === "/") {
        return root;
    }
    if (!provider.resolvePath) {
        throw new Error("basePath requires a path-addressed provider");
    }
    const hits = await provider.resolvePath(drive, basePath);
    const folder = hits.length === 1 ? hits[0] : undefined;
    if (folder?.kind !== "folder") {
        throw new Error(`basePath ${basePath} is not a single folder`);
    }
    return folder.realId;
}

/** `assert.rejects` matcher for a {@link StorageError} with `code`. */
function isStorageError(code: StorageError["code"]): (err: unknown) => boolean {
    return (err) => err instanceof StorageError && err.code === code;
}
