import { type PluginTool, runTextTool } from "@getfamiliar/shared";
import type { ReflectionToolsDeps } from "../ReflectionTools.js";

interface ToolListArgs {
    readonly search?: string;
}

/**
 * Static manifest of every container-built-in tool. Kept in sync
 * with `CONTAINER_TOOL_GROUPS` in
 * `container/src/tools/ToolsFactory.ts` — if a new built-in is
 * added there, add it here too. Built-ins don't move through any
 * host-side registry, so duplicating the names is the cheapest path
 * to a complete catalog without adding a bastion route the agent
 * doesn't otherwise need.
 */
const CONTAINER_BUILTINS: ReadonlyArray<{ readonly name: string; readonly description: string }> = [
    {
        name: "send_chat",
        description: "Append an assistant message to the event's chat channel (chat events only).",
    },
    {
        name: "call_handler",
        description:
            "Synchronously call another handler as a subagent. Parks the current run " +
            "until the child settles; returns the child's result text.",
    },
    {
        name: "schedule_handler",
        description:
            "Fire-and-forget child handler under the current event, or — with `when` " +
            "— a future deferred wake-up under a fresh event.",
    },
    {
        name: "unschedule_handler",
        description: "Cancel a previously-scheduled handler by its `key`.",
    },
    {
        name: "get_scheduled_handlers",
        description:
            "List scheduled one-off handlers in a time range. (Already in the " +
            "`reflection` group alongside this tool.)",
    },
    { name: "fs_read", description: "Read a file from the agent's workspace or scratch." },
    {
        name: "fs_write",
        description: "Write a file. Workspace `.md` writes require a privileged agentrun.",
    },
    {
        name: "fs_str_replace",
        description: "Replace one occurrence of a literal string in a file.",
    },
    { name: "fs_append", description: "Append text to a file (create if absent)." },
    { name: "fs_ls", description: "List directory entries." },
    { name: "fs_glob", description: "Match paths against a glob pattern." },
    { name: "fs_grep", description: "Substring / regex search across files." },
    { name: "fs_remove", description: "Delete a file or empty directory." },
];

const DESCRIPTION_CHARS = 200;

/**
 * Build the `tool_list` reflection tool — a flat catalog of every
 * tool surface the daemon knows about (built-in container tools,
 * plugin tools registered via `PluginToolsRegistry`, MCPs declared
 * in `mcp.yml`). Note: for MCPs the catalog returns one entry per
 * MCP (not per upstream tool), because per-tool enumeration requires
 * actually connecting to the MCP — which only the container does. To
 * see an MCP's tools the agent must opt in via `tools: <mcp-id>` and
 * inspect what the model is offered.
 */
export function buildToolListTool(deps: ReflectionToolsDeps): PluginTool<ToolListArgs, string> {
    return {
        name: "tool_list",
        description:
            "List every tool surface the daemon knows about: container built-ins " +
            "(`send_chat`, `fs_*`, …), host plugin tools (`mail_*`, `cal_*`, …), and " +
            "registered MCPs (one row per MCP, not per upstream tool). Optional `search` " +
            "filters by case-insensitive substring against name OR description. The " +
            "result is a markdown table — Name | Source | Description.",
        groups: ["reflection"],
        inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
                search: {
                    type: "string",
                    description: "Case-insensitive substring matched against name or description.",
                },
            },
        },
        execute: (args, callCtx) =>
            runTextTool(async () => {
                const needle = args.search?.toLowerCase();
                const rows: Array<{ name: string; source: string; description: string }> = [];

                for (const builtin of CONTAINER_BUILTINS) {
                    rows.push({
                        name: builtin.name,
                        source: "builtin",
                        description: builtin.description,
                    });
                }
                for (const plugin of deps.pluginToolsRegistry.list()) {
                    rows.push({
                        name: plugin.key,
                        source:
                            plugin.pluginId === "core"
                                ? "plugin:core"
                                : `plugin:${plugin.pluginId}`,
                        description: plugin.description,
                    });
                }
                for (const mcp of deps.mcpRegistry.list()) {
                    rows.push({
                        name: mcp.id,
                        source: "mcp",
                        description:
                            mcp.description.length > 0
                                ? `${mcp.title}. ${mcp.description}`
                                : mcp.title,
                    });
                }

                const filtered =
                    needle === undefined
                        ? rows
                        : rows.filter(
                              (r) =>
                                  r.name.toLowerCase().includes(needle) ||
                                  r.description.toLowerCase().includes(needle),
                          );
                if (filtered.length === 0) {
                    return "(no matching tools)\n";
                }
                filtered.sort((a, b) => a.name.localeCompare(b.name));

                const lines: string[] = [];
                lines.push("| Name | Source | Description |");
                lines.push("| --- | --- | --- |");
                for (const row of filtered) {
                    lines.push(
                        `| \`${row.name}\` | ${row.source} | ${escapeCell(truncate(row.description))} |`,
                    );
                }
                return `${lines.join("\n")}\n`;
            }, callCtx.toolRunContext),
    };
}

function truncate(text: string): string {
    const flat = text.replace(/\s+/g, " ").trim();
    if (flat.length <= DESCRIPTION_CHARS) {
        return flat;
    }
    return `${flat.slice(0, DESCRIPTION_CHARS)}…`;
}

function escapeCell(text: string): string {
    return text.replace(/\|/g, "\\|");
}
