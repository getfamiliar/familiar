import { writeMarkdown } from "@getfamiliar/shared";
import { defineCommand } from "citty";
import { bootstrap } from "../../Bootstrap.js";
import {
    DEFAULT_SEARCH_LIMIT,
    searchMcpRegistries,
} from "../../mcp/registry-search/McpRegistrySearch.js";
import { renderSearchReport } from "../../mcp/registry-search/SearchReport.js";

/**
 * `familiar tools search-mcp <term…>` — search the Docker MCP catalog and
 * the official MCP registry, filter out what our runtime can't run, and
 * print a security-rated table. Same search and same markdown as the
 * agent tool `mcp_registry_search`. Works without the daemon.
 */
export const searchMcpCommand = defineCommand({
    meta: {
        name: "search-mcp",
        description:
            "Search the Docker MCP catalog and the official MCP registry for MCP servers, filter out unsuitable ones, and rate each candidate's security (0–5 stars) with findings.",
    },
    args: {
        term: {
            type: "positional",
            required: true,
            description:
                "Search term (e.g. notion, google calendar). Several words must all match.",
        },
        verbose: {
            type: "boolean",
            alias: "v",
            description: "Also list the filtered-out MCP servers with the reason for each.",
            default: false,
        },
        limit: {
            type: "string",
            description: `Maximum number of candidates to show (default ${DEFAULT_SEARCH_LIMIT}).`,
        },
        platform: {
            type: "string",
            description:
                "Image platform to check against as os/arch (default: the docker engine's, e.g. linux/amd64).",
        },
        raw: {
            type: "boolean",
            description:
                "Skip terminal styling and emit the raw markdown verbatim. Useful for piping into a file or a markdown viewer.",
            default: false,
        },
    },
    async run({ args }) {
        bootstrap();
        const query = args._.join(" ").trim();
        const limit = args.limit !== undefined ? Number.parseInt(args.limit, 10) : undefined;
        if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
            process.stderr.write(`--limit must be a positive integer, got "${args.limit}".\n`);
            process.exit(1);
        }
        if (args.platform !== undefined && !/^[a-z0-9]+\/[a-z0-9]+$/.test(args.platform)) {
            process.stderr.write(
                `--platform must look like linux/arm64, got "${args.platform}".\n`,
            );
            process.exit(1);
        }
        const result = await searchMcpRegistries({ query, limit, platform: args.platform });
        writeMarkdown(renderSearchReport(result, args.verbose === true), {
            raw: args.raw === true,
        });
    },
});
