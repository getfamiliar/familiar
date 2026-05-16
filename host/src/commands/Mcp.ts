import { existsSync } from "node:fs";
import { defineCommand } from "citty";
import { bootstrap } from "../Bootstrap.js";
import { lintMcpConfigFile } from "../mcp/McpConfigLoader.js";
import { mcpAddCommand } from "./mcp/McpAdd.js";
import { mcpCallCommand } from "./mcp/McpCall.js";
import { mcpFunctionsCommand } from "./mcp/McpFunctions.js";
import { mcpListCommand } from "./mcp/McpList.js";
import { mcpPurgeCommand } from "./mcp/McpPurge.js";

/**
 * `cli.sh mcp` — root for MCP-related subcommands. `lint` stays inline
 * (one screen); `list`, `purge`, and `add` each live in their own
 * file under `commands/mcp/` because they grew bigger.
 */
export const mcpCommand = defineCommand({
    meta: {
        name: "mcp",
        description:
            "Inspect, list, purge, add, and run one-shot calls against MCP entries in config/mcp.yml.",
    },
    subCommands: {
        lint: defineCommand({
            meta: {
                name: "lint",
                description:
                    "Validate config/mcp.yml: file is readable (or absent), parses, and every entry has the fields its source requires.",
            },
            run() {
                const boot = bootstrap();
                if (!existsSync(boot.mcpConfigFile)) {
                    process.stdout.write(`config/mcp.yml: not present (no MCPs configured)\n`);
                    return;
                }
                const result = lintMcpConfigFile(boot.mcpConfigFile);
                for (const w of result.warnings) {
                    process.stdout.write(`warning: ${w}\n`);
                }
                if (!result.ok) {
                    for (const e of result.errors) {
                        process.stderr.write(`error: ${e}\n`);
                    }
                    process.exit(1);
                }
                process.stdout.write(`config/mcp.yml: ok\n`);
            },
        }),
        list: mcpListCommand,
        functions: mcpFunctionsCommand,
        purge: mcpPurgeCommand,
        add: mcpAddCommand,
        call: mcpCallCommand,
    },
});
