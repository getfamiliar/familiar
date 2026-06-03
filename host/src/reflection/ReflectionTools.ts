import type { PluginTool, PostgresConnection } from "@getfamiliar/shared";
import type { ContainerToolsRegistry } from "../container-tools/ContainerToolsRegistry.js";
import type { McpRegistry } from "../mcp/McpRegistry.js";
import type { PluginToolsRegistry } from "../plugins/ToolsRegistry.js";
import { buildAgentrunReportTool } from "./tools/AgentrunReport.js";
import { buildAgentrunSyspromptTool } from "./tools/AgentrunSysprompt.js";
import { buildEventListTool } from "./tools/EventList.js";
import { buildEventReplayTool } from "./tools/EventReplay.js";
import { buildEventReportTool } from "./tools/EventReport.js";
import { buildInferenceStatusTool } from "./tools/InferenceStatus.js";
import { buildLogSearchTool } from "./tools/LogSearch.js";
import { buildSystemStatusTool } from "./tools/SystemStatus.js";
import { buildToolListTool } from "./tools/ToolList.js";

/**
 * Dependencies the eight reflection tools need at build time. The
 * registries are closed over by reference, so the tool bodies read
 * whatever has been registered by the time the agent calls them —
 * not just what existed at registrar invocation.
 */
export interface ReflectionToolsDeps {
    /**
     * Lazy postgres connection getter. Reflection tools open
     * (and reuse) the daemon's shared connection just like every other
     * core tool, so the read path stays consistent with the rest of
     * the host.
     */
    readonly ensureConnection: () => Promise<PostgresConnection>;
    /** Absolute host path of the daemon's pino-rotated logs directory. */
    readonly logsDir: string;
    /** Absolute host path of the scratch root that mounts at `/scratch` in the agent container. */
    readonly scratchDir: string;
    /** Parsed `mcp.yml` catalog — `tool_list` enumerates per-MCP entries from here. */
    readonly mcpRegistry: McpRegistry;
    /** Plugin-tools catalog — `tool_list` enumerates plugin tools from here. */
    readonly pluginToolsRegistry: PluginToolsRegistry;
    /**
     * Container built-ins catalog the agent reported on startup —
     * `tool_list` enumerates built-ins from here (read by reference, so
     * it reflects the latest report).
     */
    readonly containerToolsRegistry: ContainerToolsRegistry;
}

/**
 * Build every host-owned reflection tool. Returned in alphabetical
 * order by tool name; the caller hands the array straight to
 * {@link PluginToolsRegistry.register} with `pluginId="core"` so the
 * tools land on the bare-key path (no `core_` prefix) — matching the
 * agent-facing names the user picked (`event_list`, not
 * `core_event_list`).
 *
 * Every tool declares `groups: ["reflection"]` so a handler can opt
 * in with frontmatter like `tools: core + reflection`. The container-
 * side `get_scheduled_handlers` already lives in the same group.
 */
export function buildReflectionTools(deps: ReflectionToolsDeps): readonly PluginTool[] {
    return [
        buildAgentrunReportTool(deps),
        buildAgentrunSyspromptTool(deps),
        buildEventListTool(deps),
        buildEventReplayTool(deps),
        buildEventReportTool(deps),
        buildInferenceStatusTool(deps),
        buildLogSearchTool(deps),
        buildSystemStatusTool(deps),
        buildToolListTool(deps),
    ];
}
