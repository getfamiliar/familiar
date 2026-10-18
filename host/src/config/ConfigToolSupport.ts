import { ToolError } from "@getfamiliar/shared";
import type { McpRegistry } from "../mcp/McpRegistry.js";
import type { DaemonReloader } from "../reload/DaemonReloader.js";
import type { HostConfigService } from "../utils/ConfigService.js";

/** Dependencies of the agent-facing config tools. */
export interface ConfigToolsDeps {
    /** Absolute path of `config/config.yml`. */
    readonly configFile: string;
    /** Absolute path of `config/mcp.yml`. */
    readonly mcpConfigFile: string;
    /** The daemon's config service (live state). */
    readonly config: HostConfigService;
    /** The daemon's parsed `mcp.yml` (live state). */
    readonly mcpRegistry: McpRegistry;
    /** Applies both files to the running daemon. */
    readonly reloader: DaemonReloader;
    /** Whether a plugin with this id contributes tools (MCP ids must not clash). */
    readonly isPluginToolGroup: (id: string) => boolean;
}

/** Tool group every config tool joins (`tools: core + config`). */
export const CONFIG_TOOL_GROUP = "config";

/**
 * Error for an attempt to write a secret through the agent.
 *
 * @param what Human description of the target (e.g. `config key telegram.botToken`).
 * @returns The tool error to throw.
 */
export function secretRefusedError(what: string): ToolError {
    return new ToolError(
        "SecretValue",
        `${what} is a secret; secrets never pass through the agent. Ask the user to enter it with config_ask_secret (when available) or \`familiar config set\` / by editing the file, then call config_reload.`,
    );
}
