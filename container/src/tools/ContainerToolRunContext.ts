import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ToolRunContext } from "@getfamiliar/shared";

/**
 * Build a {@link ToolRunContext} for container-side tools. Spills land
 * under `/scratch/<eventId>/` — the same bind-mount the agent reads
 * with `file_read` and the host already uses for attachments.
 *
 * The suggested name from the runner (e.g. `result.json`) is suffixed
 * with a short random hex so concurrent tool calls in the same agentrun
 * never collide on disk — no directory-listing race, no dedup loop.
 */
export function buildContainerToolRunContext(eventId: string, limit: number): ToolRunContext {
    const scratchDir = path.join("/scratch", eventId);
    return {
        limit,
        spill: async (suggestedName, contents) => {
            await mkdir(scratchDir, { recursive: true });
            const filename = withRandomSuffix(suggestedName);
            const fullPath = path.join(scratchDir, filename);
            await writeFile(fullPath, contents);
            return fullPath;
        },
    };
}

/**
 * Splice a 4-byte hex token into the basename so two concurrent spills
 * with the same `suggestedName` always land on distinct paths.
 * `result.json` → `result-a1b2c3d4.json`; `payload` → `payload-a1b2c3d4`.
 */
function withRandomSuffix(suggestedName: string): string {
    const suffix = randomBytes(4).toString("hex");
    const dotIdx = suggestedName.lastIndexOf(".");
    if (dotIdx <= 0) {
        return `${suggestedName}-${suffix}`;
    }
    return `${suggestedName.slice(0, dotIdx)}-${suffix}${suggestedName.slice(dotIdx)}`;
}
