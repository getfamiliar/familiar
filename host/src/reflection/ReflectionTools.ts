import type { PluginTool, PostgresConnection } from "@getfamiliar/shared";
import { buildAgentrunReportTool } from "./tools/AgentrunReport.js";
import { buildAgentrunSyspromptTool } from "./tools/AgentrunSysprompt.js";
import { buildEventListTool } from "./tools/EventList.js";
import { buildEventReplayTool } from "./tools/EventReplay.js";
import { buildEventReportTool } from "./tools/EventReport.js";
import { buildInferenceStatusTool } from "./tools/InferenceStatus.js";
import { buildLogSearchTool } from "./tools/LogSearch.js";
import { buildSystemStatusTool } from "./tools/SystemStatus.js";

/**
 * Dependencies the reflection tools need at build time.
 *
 * Tool discovery (`tool_list`) and dynamic invocation (`tool_call`) now
 * live container-side in `ToolsFactory`, where the full live per-tool
 * pool (built-ins ∪ every connected MCP's tools ∪ plugin tools) is
 * available — so the old host-side per-MCP-server `tool_list` and its
 * registry deps were removed.
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
 * side `get_scheduled_subagents` already lives in the same group.
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
    ];
}
