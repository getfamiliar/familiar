import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { CONTAINER_SCRATCH } from "../utils/ScratchInput.js";
import { dedupName } from "../utils/ScratchNames.js";

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
