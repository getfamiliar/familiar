import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { ToolError } from "@getfamiliar/shared";
import { dedupName } from "../utils/ScratchNames.js";

/** Container-side mount point of the scratch directory. */
const CONTAINER_SCRATCH = "/scratch";

/** A regular file inside the event's scratch dir, validated for upload. */
export interface ScratchInput {
    readonly hostPath: string;
    readonly size: number;
}

/**
 * Validate an agent-supplied `scratch_path` and map it to the host.
 * The path must lie inside this event's scratch directory
 * (`/scratch/<eventId>/…`) **after resolving symlinks**, and must be a
 * regular file.
 *
 * @param scratchPath - Container-visible absolute path.
 * @param scratchDir - Host path of `tmp/scratch`.
 * @param eventId - Current event id.
 * @returns Host path and size of the file.
 * @throws ToolError `BadScratchPath` on any escape attempt or non-file.
 */
export async function resolveScratchInput(
    scratchPath: string,
    scratchDir: string,
    eventId: string,
): Promise<ScratchInput> {
    const prefix = `${CONTAINER_SCRATCH}/${eventId}/`;
    const normalized = path.posix.normalize(scratchPath);
    if (!normalized.startsWith(prefix) || scratchPath.split("/").includes("..")) {
        throw new ToolError(
            "BadScratchPath",
            `scratch_path must be a file inside this run's scratch directory ${prefix} (got ${scratchPath})`,
        );
    }
    const eventDir = path.join(scratchDir, eventId);
    const candidate = path.join(eventDir, normalized.slice(prefix.length));
    let realBase: string;
    let realTarget: string;
    try {
        realBase = await realpath(eventDir);
        realTarget = await realpath(candidate);
    } catch {
        throw new ToolError("BadScratchPath", `scratch_path ${scratchPath} does not exist`);
    }
    if (!realTarget.startsWith(`${realBase}${path.sep}`)) {
        throw new ToolError(
            "BadScratchPath",
            `scratch_path ${scratchPath} resolves outside this run's scratch directory`,
        );
    }
    const stats = await lstat(realTarget);
    if (!stats.isFile()) {
        throw new ToolError("BadScratchPath", `scratch_path ${scratchPath} is not a regular file`);
    }
    return { hostPath: realTarget, size: stats.size };
}

/** Where one download lands. */
export interface DownloadTarget {
    /** Host path to write. */
    readonly hostPath: string;
    /** Container-visible path to report. */
    readonly containerPath: string;
}

/**
 * Allocate a fresh file path under `/scratch/<eventId>/storage/<mount>/`
 * for `fileName`, deduplicating against files already on disk and names
 * handed out earlier in the same call (`used`).
 *
 * @param scratchDir - Host path of `tmp/scratch`.
 * @param eventId - Current event id.
 * @param mount - Mount alias (validated: no separators).
 * @param fileName - Untrusted provider file name.
 * @param used - Per-directory set of names taken in this call; seeded from disk on first use.
 * @returns Host and container paths.
 */
export async function allocateDownloadPath(
    scratchDir: string,
    eventId: string,
    mount: string,
    fileName: string,
    used: Map<string, Set<string>>,
): Promise<DownloadTarget> {
    const dir = path.join(scratchDir, eventId, "storage", mount);
    let taken = used.get(dir);
    if (!taken) {
        await mkdir(dir, { recursive: true });
        taken = new Set(await readdir(dir));
        used.set(dir, taken);
    }
    const name = dedupName(fileName, taken);
    return {
        hostPath: path.join(dir, name),
        containerPath: `${CONTAINER_SCRATCH}/${eventId}/storage/${mount}/${name}`,
    };
}
