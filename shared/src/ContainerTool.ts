/**
 * Metadata for one container-side built-in tool (`send_chat`, `fs_*`,
 * `bash`, …), as the agent container reports it to the host on startup.
 *
 * Container built-ins are constructed per-agentrun *inside* the
 * container and never pass through any host-side registry, so the host
 * cannot read them directly. Instead the container enumerates them once
 * at startup (`ToolsFactory.catalog()`) and POSTs this projection to the
 * bastion's `/container-tools/` endpoint; the host keeps the latest
 * report in an in-memory registry that both the `tools list` CLI and the
 * `tool_list` reflection tool read. This is the single source of truth —
 * there is no hand-maintained host-side copy to drift out of sync.
 */
export interface ContainerToolInfo {
    /** Agent-facing tool name / registration key (e.g. `fs_read`). */
    readonly name: string;
    /** Human-readable description, verbatim from the tool's builder. */
    readonly description: string;
    /** Raw JSON Schema for the tool's arguments. */
    readonly inputSchema: object;
    /**
     * Curated groups this built-in joins (mirrors
     * `CONTAINER_TOOL_GROUPS` in the container), e.g. `["core", "fs"]`
     * for `fs_read` or `["bash"]` for `bash`.
     */
    readonly groups: readonly string[];
}
