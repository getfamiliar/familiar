import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { ToolError } from "@getfamiliar/shared";

/** Container-side mount point of the scratch directory. */
export const CONTAINER_SCRATCH = "/scratch";

/**
 * Inline-attachment ceiling per Graph's `fileAttachment` resource —
 * larger uploads require a `createUploadSession` flow that is not
 * implemented. Other providers may relax this, but one shared cap for
 * mail and calendar attachments keeps the tool surface predictable.
 * Binary form (3 × 1024 × 1024) so the bound is exact in bytes.
 */
export const INLINE_ATTACHMENT_LIMIT_BYTES = 3 * 1024 * 1024;

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

/**
 * Read an agent-supplied scratch file meant as an attachment: validated
 * like {@link resolveScratchInput} and capped at
 * {@link INLINE_ATTACHMENT_LIMIT_BYTES} before any byte is read.
 *
 * @param scratchPath - Container-visible absolute path.
 * @param scratchDir - Host path of `tmp/scratch`.
 * @param eventId - Current event id.
 * @returns The file's base name and bytes.
 * @throws ToolError `BadScratchPath` (see {@link resolveScratchInput}) or
 *   `AttachmentTooLarge` when the file exceeds the limit.
 */
export async function readScratchAttachment(
    scratchPath: string,
    scratchDir: string,
    eventId: string,
): Promise<{ readonly name: string; readonly contents: Buffer }> {
    const input = await resolveScratchInput(scratchPath, scratchDir, eventId);
    if (input.size > INLINE_ATTACHMENT_LIMIT_BYTES) {
        throw new ToolError(
            "AttachmentTooLarge",
            `attachment ${scratchPath} is ${input.size} bytes; the limit is ` +
                `${INLINE_ATTACHMENT_LIMIT_BYTES} bytes per file — large-file upload ` +
                "sessions are not implemented.",
        );
    }
    return { name: path.posix.basename(scratchPath), contents: await readFile(input.hostPath) };
}
