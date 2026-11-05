import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { scratchSpillFileName, type ToolRunContext } from "@getfamiliar/shared";

/**
 * Build a {@link ToolRunContext} for container-side tools. Spills land
 * under `/scratch/<eventId>/` — the same bind-mount the agent reads
 * with `fs_read` and the host already uses for attachments.
 *
 * The suggested name from the runner (e.g. `result.json`) becomes a
 * hidden file with a short random hex ({@link scratchSpillFileName}), so
 * concurrent tool calls never collide on disk and spills stay out of the
 * file listings meant for the model and the user.
 */
export function buildContainerToolRunContext(eventId: string, limit: number): ToolRunContext {
    const scratchDir = path.join("/scratch", eventId);
    return {
        limit,
        spill: async (suggestedName, contents) => {
            await mkdir(scratchDir, { recursive: true });
            const filename = scratchSpillFileName(suggestedName);
            const fullPath = path.join(scratchDir, filename);
            await writeFile(fullPath, contents);
            return fullPath;
        },
    };
}
