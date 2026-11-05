import { randomBytes } from "node:crypto";

/**
 * Per-event scratch folders (`/scratch/<event-id>/` in the containers,
 * `<scratchDir>/<event-id>/` on the host).
 *
 * Convention: files whose name starts with `.` are internal (spilled tool
 * results, plugin bookkeeping). They are left out wherever scratch files
 * are listed for the model ("staged files" in the prompt) or the user
 * (downloads in the web chat).
 */

/** A file in an event's scratch folder, as `ctx.scratch.listFiles` reports it. */
export interface ScratchFile {
    /** Basename inside `/scratch/<event-id>/`. */
    readonly name: string;
    /** Size in bytes. */
    readonly size: number;
    /** Last modification. */
    readonly modifiedAt: Date;
}

/**
 * Whether a scratch file is internal (dotfile) and must not be offered
 * to the model or the user as a staged or produced file.
 *
 * @param name Basename.
 * @returns True for hidden files.
 */
export function isHiddenScratchFile(name: string): boolean {
    return name.startsWith(".");
}

/**
 * File name for spilling an oversized tool result to scratch: hidden
 * (leading `.`, see {@link isHiddenScratchFile}) and with a 4-byte random
 * hex token before the extension, so concurrent spills with the same
 * suggestion never collide — `result.json` → `.result-a1b2c3d4.json`.
 *
 * @param suggestedName Name proposed by the tool runner.
 * @returns The basename to write.
 */
export function scratchSpillFileName(suggestedName: string): string {
    const suffix = randomBytes(4).toString("hex");
    const base = suggestedName.replace(/^\.+/, "");
    const dotIdx = base.lastIndexOf(".");
    const named =
        dotIdx <= 0
            ? `${base}-${suffix}`
            : `${base.slice(0, dotIdx)}-${suffix}${base.slice(dotIdx)}`;
    return `.${named}`;
}
