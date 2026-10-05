import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Logger } from "@getfamiliar/shared";
import type { McpEntry } from "../McpEntry.js";
import { mcpMountDirFor } from "../RuntimeImages.js";

/**
 * What an offline (`network.disable: true`) npm/pypi MCP's `/work` cache
 * was prepped for. The phase-2 container can only read packages from
 * that cache, so it stays usable only while all of these are unchanged:
 * a different package/version/command was never fetched, and a rebuilt
 * runtime image may ship a package manager with a new cache layout (uv
 * 0.12 reads `simple-v25/`, a cache written by an older uv only has
 * `simple-v21/`).
 */
export interface OfflinePrepStamp {
    readonly package: string;
    readonly version: string | null;
    readonly command: string | null;
    /** `docker image inspect` id of the runtime image the prep ran in. */
    readonly runtimeImageId: string;
}

/** Outcome of {@link prepareOfflineMount}. */
export interface OfflineMountState {
    /** `true` when the mount dir is empty and the transport must run prep. */
    readonly isPrepNeeded: boolean;
    /** Write the stamp for this entry; call once prep has succeeded. */
    readonly writeStamp: () => void;
}

/**
 * Host path of an MCP's prep stamp. Deliberately a sibling of the
 * mount dir, not inside it: the offline container owns `/work` and must
 * not be able to forge a stamp that skips the next re-prep.
 *
 * @param tmpDir The project's `tmp/` directory.
 * @param id The MCP's `mcp.yml` key.
 * @returns Absolute path `tmp/mcp-mount-<id>.prep.json`.
 */
export function prepStampFileFor(tmpDir: string, id: string): string {
    return `${mcpMountDirFor(tmpDir, id)}.prep.json`;
}

/**
 * Build the stamp an entry's cache must carry to be reusable.
 *
 * @param entry The parsed `mcp.yml` entry (npm or pypi source).
 * @param runtimeImageId Id of the runtime image the MCP runs in.
 * @returns The expected stamp.
 * @throws When the entry has no `package` (the source requires one).
 */
export function buildPrepStamp(entry: McpEntry, runtimeImageId: string): OfflinePrepStamp {
    if (entry.package === undefined) {
        throw new Error(`MCP "${entry.id}": ${entry.source} source requires a "package" field.`);
    }
    return {
        package: entry.package,
        version: entry.version ?? null,
        command: entry.command,
        runtimeImageId,
    };
}

/**
 * Read a prep stamp from disk.
 *
 * @param file Path from {@link prepStampFileFor}.
 * @returns The stamp, or `null` when the file is missing or not a
 *   well-formed stamp (both mean "unknown prep, redo it").
 */
export function readPrepStamp(file: string): OfflinePrepStamp | null {
    if (!existsSync(file)) {
        return null;
    }
    try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<OfflinePrepStamp>;
        if (typeof parsed.package !== "string" || typeof parsed.runtimeImageId !== "string") {
            return null;
        }
        return {
            package: parsed.package,
            version: typeof parsed.version === "string" ? parsed.version : null,
            command: typeof parsed.command === "string" ? parsed.command : null,
            runtimeImageId: parsed.runtimeImageId,
        };
    } catch {
        // A truncated / hand-edited stamp is treated like a missing one.
        return null;
    }
}

/**
 * Describe how a recorded stamp differs from the expected one.
 *
 * @param recorded The stamp on disk, or `null` when there is none.
 * @param expected The stamp the current entry and image require.
 * @returns A human-readable reason, or `null` when the stamps match.
 */
export function describePrepStampMismatch(
    recorded: OfflinePrepStamp | null,
    expected: OfflinePrepStamp,
): string | null {
    if (recorded === null) {
        return "no prep stamp recorded";
    }
    const changes: string[] = [];
    for (const field of ["package", "version", "command", "runtimeImageId"] as const) {
        if (recorded[field] !== expected[field]) {
            changes.push(
                `${field} ${recorded[field] ?? "(none)"} → ${expected[field] ?? "(none)"}`,
            );
        }
    }
    return changes.length === 0 ? null : changes.join(", ");
}

/**
 * Make an offline MCP's mount dir ready for its transport. A missing
 * dir is created and flagged for prep. An existing dir is reused only
 * when its stamp matches the entry and runtime image; otherwise the dir
 * is wiped (never re-prepped in place — prep runs with full network, and
 * must not see anything the offline container stashed in `/work`) and
 * flagged for prep.
 *
 * Only for `network.disable: true` entries. Online MCPs resolve their
 * packages themselves and may keep login state in `/work` (e.g. totem's
 * `.env`), so their mount dir is never touched by this.
 *
 * @param entry The offline npm/pypi entry.
 * @param tmpDir The project's `tmp/` directory.
 * @param runtimeImageId Id of the runtime image the MCP runs in.
 * @param log Logger for the wipe notice.
 * @returns Whether prep is needed, and the stamp writer for after it.
 */
export function prepareOfflineMount(
    entry: McpEntry,
    tmpDir: string,
    runtimeImageId: string,
    log: Logger,
): OfflineMountState {
    const mountDir = mcpMountDirFor(tmpDir, entry.id);
    const stampFile = prepStampFileFor(tmpDir, entry.id);
    const expected = buildPrepStamp(entry, runtimeImageId);
    const writeStamp = (): void => {
        writeFileSync(stampFile, `${JSON.stringify(expected, null, 2)}\n`);
    };

    if (existsSync(mountDir)) {
        const mismatch = describePrepStampMismatch(readPrepStamp(stampFile), expected);
        if (mismatch === null) {
            return { isPrepNeeded: false, writeStamp };
        }
        log.info(
            `offline mcp '${entry.id}': package cache in ${mountDir} is stale (${mismatch}); wiping it for a fresh prep`,
        );
        rmSync(mountDir, { recursive: true, force: true });
    }
    rmSync(stampFile, { force: true });
    mkdirSync(mountDir, { recursive: true });
    return { isPrepNeeded: true, writeStamp };
}
