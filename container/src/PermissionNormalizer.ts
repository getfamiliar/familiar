import { execFileSync } from "node:child_process";
import {
    chmodSync,
    chownSync,
    existsSync,
    lchownSync,
    lstatSync,
    readdirSync,
    readFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { matchesAnyGlob } from "@getfamiliar/shared";

/**
 * Re-pins ownership and Unix modes across the agent's writable mounts so
 * files created by the agent — including by an arbitrary `bash` command
 * running as the least-privilege `unpriv` user — end up owned by the host
 * operator with the canonical mode for their location.
 *
 * This is the OS-layer counterpart to the `fs_*` tools' privilege gate
 * (`tools/fs.ts`): the same boundary (writable iff under
 * `core.writablePaths`, everything else protected) expressed as filesystem
 * permissions, with the shared `familiar` group's write bit deciding
 * whether `unpriv` may write. It runs as **root** (the only identity that
 * can `chown` `unpriv`-created files back to the operator and `chmod` files
 * it doesn't own) in exactly two places: once at container boot, and once
 * after every `bash` tool invocation. See the project plan and
 * `container/entrypoint.sh`.
 */

/** Absolute mount path of the workspace inside the agent container. */
const WORKSPACE_ROOT = "/workspace";
/** Absolute mount path of the shared per-event scratch dir. */
const SCRATCH_ROOT = "/scratch";
/** Runtime params written by the entrypoint (root) before dropping privileges. */
const PARAMS_FILE = "/etc/familiar/normalize.json";

/** Mode for protected (privilege-required) directories: setgid + owner rwx, group r-x. */
const PROTECTED_DIR_MODE = 0o2750;
/** Mode for writable directories: setgid + owner rwx, group rwx. */
const WRITABLE_DIR_MODE = 0o2770;
/** Mode for protected files: owner rw, group r. */
const PROTECTED_FILE_MODE = 0o640;
/** Mode for writable files: owner rw, group rw. */
const WRITABLE_FILE_MODE = 0o660;

/** Target ownership and the writable-path allowlist for a normalization pass. */
export interface NormalizeParams {
    /** uid every workspace/scratch entry is chowned to (the operator / `priv`). */
    readonly ownerUid: number;
    /** gid every entry is chowned to (the shared `familiar` group). */
    readonly ownerGid: number;
    /** `core.writablePaths` globs (e.g. `wiki/**`, `files/**`). */
    readonly writablePaths: readonly string[];
}

/**
 * Whether a workspace path (workspace-relative POSIX) is group-writable
 * under `core.writablePaths`. Mirrors `requiresPrivilegedWrite` in
 * `tools/fs.ts` for files; directories additionally test `rel + "/"` so a
 * `dir/**` glob marks the directory itself writable — the shared
 * {@link matchesAnyGlob} matcher is root-anchored, so a bare `dir` never
 * matches `^dir/.*`. The workspace root (`rel === ""`) is always protected.
 *
 * @param rel Workspace-relative POSIX path.
 * @param isDir Whether the entry is a directory.
 * @param writablePaths The `core.writablePaths` globs.
 * @returns True when the path is group-writable.
 */
export function isWritablePath(
    rel: string,
    isDir: boolean,
    writablePaths: readonly string[],
): boolean {
    if (rel === "") {
        return false;
    }
    return isDir ? matchesAnyGlob(writablePaths, `${rel}/`) : matchesAnyGlob(writablePaths, rel);
}

/**
 * Canonical octal mode for an entry given its writability and kind.
 *
 * @param writable Whether the entry is group-writable.
 * @param isDir Whether the entry is a directory.
 * @returns The octal mode constant.
 */
export function canonicalMode(writable: boolean, isDir: boolean): number {
    if (isDir) {
        return writable ? WRITABLE_DIR_MODE : PROTECTED_DIR_MODE;
    }
    return writable ? WRITABLE_FILE_MODE : PROTECTED_FILE_MODE;
}

/** Flips to false the first time `setfacl` is found to be unusable, to avoid log spam. */
let aclUsable = true;

/**
 * Apply (writable) or strip (protected) the default ACL on a directory so
 * files later created inside it inherit group-rwx regardless of the
 * writer's umask. Best-effort: default ACLs are only an inheritance
 * nicety — `chmod` + the setgid bit already enforce the canonical state,
 * and the post-bash pass re-runs anyway — so a missing `setfacl` binary or
 * a mount without ACL support is logged once and then skipped silently.
 *
 * @param dir Absolute directory path.
 * @param writable Whether the directory is group-writable.
 */
function applyDefaultAcl(dir: string, writable: boolean): void {
    if (!aclUsable) {
        return;
    }
    try {
        if (writable) {
            execFileSync("setfacl", ["-d", "-m", "g::rwX", "-m", "o::---", dir], {
                stdio: "ignore",
            });
        } else {
            execFileSync("setfacl", ["-k", dir], { stdio: "ignore" });
        }
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
            aclUsable = false;
            process.stderr.write(
                "familiar-normalize: setfacl unavailable; skipping default ACLs\n",
            );
            return;
        }
        process.stderr.write(
            `familiar-normalize: setfacl failed for ${dir}: ${(err as Error).message}\n`,
        );
    }
}

/**
 * Recursively normalize one entry and its descendants. Symlinks are
 * `lchown`ed (so the link itself is operator-owned) but never followed,
 * never `chmod`ed, and never recursed into — this stops an `unpriv`-planted
 * symlink (e.g. `files/x -> ../mail/index.md`) from tricking the root pass
 * into re-permissioning a protected target. `chown` runs before `chmod` so
 * the kernel clearing setgid/setuid on ownership change can't strip the
 * setgid bit the mode then sets.
 *
 * @param absolute Absolute path of the entry.
 * @param rel Workspace-relative POSIX path (`""` for a root).
 * @param params Target ownership and writable globs.
 * @param allWritable When true, every entry is treated as writable (scratch).
 */
function normalizeEntry(
    absolute: string,
    rel: string,
    params: NormalizeParams,
    allWritable: boolean,
): void {
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
        lchownSync(absolute, params.ownerUid, params.ownerGid);
        return;
    }
    if (!stat.isDirectory() && !stat.isFile()) {
        // Sockets, fifos, devices: chown for ownership hygiene, leave mode alone.
        chownSync(absolute, params.ownerUid, params.ownerGid);
        return;
    }

    const isDir = stat.isDirectory();
    const writable = allWritable || isWritablePath(rel, isDir, params.writablePaths);
    chownSync(absolute, params.ownerUid, params.ownerGid);
    chmodSync(absolute, canonicalMode(writable, isDir));

    if (!isDir) {
        return;
    }
    applyDefaultAcl(absolute, writable);
    for (const name of readdirSync(absolute)) {
        normalizeEntry(
            path.join(absolute, name),
            rel === "" ? name : `${rel}/${name}`,
            params,
            allWritable,
        );
    }
}

/**
 * Run a full normalization pass over the workspace (path-scoped writability)
 * and scratch (entirely writable). Missing roots are skipped.
 *
 * @param params Target ownership and writable globs.
 * @param roots Override mount roots (used by tests).
 */
export function normalizeAll(
    params: NormalizeParams,
    roots: { readonly workspaceRoot?: string; readonly scratchRoot?: string } = {},
): void {
    const workspaceRoot = roots.workspaceRoot ?? WORKSPACE_ROOT;
    const scratchRoot = roots.scratchRoot ?? SCRATCH_ROOT;
    if (existsSync(workspaceRoot)) {
        normalizeEntry(workspaceRoot, "", params, false);
    }
    if (existsSync(scratchRoot)) {
        normalizeEntry(scratchRoot, "", params, true);
    }
}

/**
 * Read {@link PARAMS_FILE} (written by the entrypoint) into params.
 *
 * @returns The normalization params.
 * @throws If the file is missing or malformed.
 */
function loadParams(): NormalizeParams {
    const raw = JSON.parse(readFileSync(PARAMS_FILE, "utf8")) as {
        hostUid?: number;
        hostGid?: number;
        writablePaths?: unknown;
    };
    if (typeof raw.hostUid !== "number" || typeof raw.hostGid !== "number") {
        throw new Error(`${PARAMS_FILE} must contain numeric hostUid and hostGid`);
    }
    const writablePaths = Array.isArray(raw.writablePaths)
        ? raw.writablePaths.filter((p): p is string => typeof p === "string")
        : [];
    return { ownerUid: raw.hostUid, ownerGid: raw.hostGid, writablePaths };
}

/** CLI entry: normalize using params from {@link PARAMS_FILE}. */
function main(): void {
    try {
        normalizeAll(loadParams());
    } catch (err) {
        process.stderr.write(`familiar-normalize failed: ${(err as Error).message}\n`);
        process.exitCode = 1;
    }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && fileURLToPath(import.meta.url) === path.resolve(invokedPath)) {
    main();
}
