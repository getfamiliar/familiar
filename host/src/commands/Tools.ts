import { defineCommand } from "citty";
import { addMcpCommand } from "./tools/AddMcp.js";
import { callMcpCommand } from "./tools/CallMcp.js";
import { lintMcpsCommand } from "./tools/LintMcps.js";
import { listCommand } from "./tools/List.js";
import { listMcpsCommand } from "./tools/ListMcps.js";
import { purgeMcpsCommand } from "./tools/PurgeMcps.js";

/**
 * `cli.sh tools` — inspect the agent's tools and manage MCP entries.
 *
 * `list` shows every tool the agent can use (container built-ins,
 * plugin tools, MCP functions) grouped by toolgroup. The `*-mcp(s)`
 * subcommands are the MCP-management slice: lint + list config entries,
 * add, purge caches, and run one-shot calls against `config/mcp.yml`.
 */
export const toolsCommand = defineCommand({
    meta: {
        name: "tools",
        description:
            "Inspect the agent's tools (`list`), and lint, list, add, purge, or call MCP entries in config/mcp.yml.",
    },
    subCommands: {
        list: listCommand,
        "lint-mcps": lintMcpsCommand,
        "list-mcps": listMcpsCommand,
        "purge-mcps": purgeMcpsCommand,
        "add-mcp": addMcpCommand,
        "call-mcp": callMcpCommand,
    },
});
