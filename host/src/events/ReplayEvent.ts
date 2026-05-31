import { promises as fs } from "node:fs";
import path from "node:path";
import type { EventBus, EventRow, NewEvent } from "@getfamiliar/shared";

/**
 * Insert a replay row for `source` and copy its scratch dir into the
 * new event's scratch dir inside the same transaction. Returns the
 * inserted row and the number of files that were copied.
 *
 * Roll-back path mirrors `HostContextImpl.emitAndAwait`: if anything
 * after the source dir is read throws, the partially-staged target dir
 * is `rm -rf`'d before the error escapes, so a failed replay never
 * leaves orphaned scratch state.
 *
 * @param bus Event bus the replay row is inserted through.
 * @param source The original event row being copied.
 * @param scratchDir Absolute path of the scratch root.
 * @returns The inserted replay row and the count of scratch files copied.
 */
export async function replayOne(
    bus: EventBus,
    source: EventRow,
    scratchDir: string,
): Promise<{ row: EventRow; fileCount: number }> {
    const replay: NewEvent = {
        topic: source.topic,
        prompt: source.prompt,
        payload: source.payload,
        priority: source.priority,
        isChat: source.isChat,
        preferredChatChannelId: source.preferredChatChannelId,
        privileged: source.privileged,
        outputChatOnFailure: source.outputChatOnFailure,
        idempotencyKey:
            source.idempotencyKey === null ? undefined : `${source.idempotencyKey}-replay`,
        startHandler: source.startHandler ?? undefined,
    };
    const sourceDir = path.join(scratchDir, source.id);
    const sourceEntries = await listScratchFiles(sourceDir);

    let stagedTargetDir: string | undefined;
    let fileCount = 0;
    try {
        const row = await bus.add(replay, async (insertedRow) => {
            if (sourceEntries.length === 0) {
                return;
            }
            const targetDir = path.join(scratchDir, insertedRow.id);
            stagedTargetDir = targetDir;
            await fs.mkdir(targetDir, { recursive: true });
            for (const name of sourceEntries) {
                await fs.copyFile(path.join(sourceDir, name), path.join(targetDir, name));
            }
            fileCount = sourceEntries.length;
        });
        return { row, fileCount };
    } catch (err) {
        if (stagedTargetDir) {
            await fs.rm(stagedTargetDir, { recursive: true, force: true });
        }
        throw err;
    }
}

/**
 * Return the basenames of every regular file directly under `dir`.
 * Returns `[]` when `dir` is absent (the common case once `ScratchGc`
 * has swept it) and ignores sub-directories — emit-time staging only
 * ever writes flat files, so a nested dir would be operator-created
 * state we shouldn't silently duplicate.
 *
 * @param dir Absolute path of the scratch directory to scan.
 * @returns File basenames; `[]` if `dir` does not exist.
 */
export async function listScratchFiles(dir: string): Promise<string[]> {
    let entries: import("node:fs").Dirent[];
    try {
        entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            return [];
        }
        throw err;
    }
    return entries.filter((e) => e.isFile()).map((e) => e.name);
}
