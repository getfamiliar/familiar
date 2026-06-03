import type { ContainerToolInfo } from "@getfamiliar/shared";

/**
 * In-memory store for the agent container's built-in tool catalog. The
 * container POSTs its catalog to `/container-tools/` on startup; this
 * registry holds the latest report. Reads ({@link list}) reflect
 * whatever the container last reported — empty until the first report
 * lands, and replaced wholesale on every report so a restarted
 * container with a changed toolset is reflected without staleness.
 *
 * Held by reference by both the {@link ContainerToolsGateway} (which
 * fills it) and the `tool_list` reflection tool (which reads it), the
 * same closed-over-registry pattern the plugin-tools registry uses.
 */
export class ContainerToolsRegistry {
    private tools: readonly ContainerToolInfo[] = [];

    /** Replace the entire catalog with the container's latest report. */
    replace(tools: readonly ContainerToolInfo[]): void {
        this.tools = [...tools];
    }

    /** The container's last-reported built-in tools (empty before any report). */
    list(): readonly ContainerToolInfo[] {
        return this.tools;
    }
}
