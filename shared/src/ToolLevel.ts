/**
 * Security classification for a tool, controlling who may invoke it.
 *
 * - `default` — anyone may call it (read-only or low-risk tools).
 * - `approval` — will require explicit user approval before running. The
 *   approval gate is future work; until it exists, approval tools are
 *   gated like `privileged` (refused in non-privileged runs).
 * - `privileged` — only runs in a privileged agentrun (one descending
 *   from trusted user input: the cli-chat REPL, an allowlisted Telegram
 *   sender). In a non-privileged run the tool stays visible but its
 *   execution is refused with a clear error.
 *
 * Enforced container-side in `ToolsFactory`'s tool wrapper, the single
 * choke point every tool (built-in, plugin, and `tool_call`-proxied)
 * passes through. An omitted level defaults to {@link DEFAULT_TOOL_LEVEL}.
 * MCP tools are not classified and are treated as `default`.
 */
export type ToolLevel = "default" | "approval" | "privileged";

/** Level applied when a tool declares none. */
export const DEFAULT_TOOL_LEVEL: ToolLevel = "default";
