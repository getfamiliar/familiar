import { type PluginTool, runTextTool, ToolError } from "@getfamiliar/shared";
import {
    DEFAULT_SEARCH_LIMIT,
    searchMcpRegistries,
} from "../mcp/registry-search/McpRegistrySearch.js";
import { renderSearchReport } from "../mcp/registry-search/SearchReport.js";
import { CONFIG_TOOL_GROUP } from "./ConfigToolSupport.js";

interface McpRegistrySearchArgs {
    readonly query?: string;
    readonly verbose?: boolean;
    readonly limit?: number;
    readonly platform?: string;
}

/**
 * `mcp_registry_search` — the agent side of `familiar tools search-mcp`:
 * same search, same markdown. Read-only (it only queries public
 * registries), so it runs at level `default`; adding a found server
 * still takes the privileged `mcp_add`.
 *
 * @returns The tool.
 */
export function buildMcpRegistrySearchTool(): PluginTool<McpRegistrySearchArgs, string> {
    return {
        name: "mcp_registry_search",
        groups: [CONFIG_TOOL_GROUP],
        description:
            "Search the Docker MCP catalog and the official MCP registry for MCP servers matching `query` (all words must match). " +
            "Returns a markdown table of servers that fit this runtime, best rated first, with a 0–5 star security rating and " +
            "the findings behind each rating (provenance tier: docker-built = fixed 5/5, docker-community-image / docker-remote " +
            "base 3, registry-only base 1 and needs investigation; first-party publisher, popularity) plus the install facts " +
            "(source, image/package/url, required env vars) to build an mcp_add entry. Unsuitable servers (unsupported package " +
            "type, auth-gated remote, deprecated/deleted, no image for this platform, duplicate of a Docker catalog entry) are " +
            "counted; `verbose: true` lists them with reasons.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["query"],
            properties: {
                query: {
                    type: "string",
                    description: 'Search term, e.g. "notion" or "google calendar".',
                },
                verbose: {
                    type: "boolean",
                    description: "List the filtered-out servers with reasons.",
                    default: false,
                },
                limit: {
                    type: "integer",
                    minimum: 1,
                    description: `Maximum candidates (default ${DEFAULT_SEARCH_LIMIT}).`,
                },
                platform: {
                    type: "string",
                    description:
                        "Image platform as os/arch (default: the docker engine's, e.g. linux/amd64).",
                },
            },
        },
        execute: (args, callCtx) =>
            runTextTool(async () => {
                const query = args.query?.trim() ?? "";
                if (query.length === 0) {
                    throw new ToolError("InvalidArgument", "query must be a non-empty string.");
                }
                if (args.platform !== undefined && !/^[a-z0-9]+\/[a-z0-9]+$/.test(args.platform)) {
                    throw new ToolError(
                        "InvalidArgument",
                        `platform must look like linux/arm64, got "${args.platform}".`,
                    );
                }
                const result = await searchMcpRegistries({
                    query,
                    limit: args.limit,
                    platform: args.platform,
                });
                return renderSearchReport(result, args.verbose === true);
            }, callCtx.toolRunContext),
    };
}
