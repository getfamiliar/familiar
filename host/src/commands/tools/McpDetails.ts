import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { writeMarkdown } from "@getfamiliar/shared";
import { defineCommand } from "citty";
import { bootstrap } from "../../Bootstrap.js";
import { renderDetailsReport } from "../../mcp/registry-search/DetailsReport.js";
import { lookupMcpDetails, McpNotFoundError } from "../../mcp/registry-search/McpDetails.js";

/**
 * `familiar tools mcp-details <name>` — everything needed to plan an MCP
 * setup: rating, settings, architecture hints, tools, cleaned README,
 * `.env.example`, Dockerfile. Same markdown as the agent tool
 * `mcp_registry_details`; long sections land in
 * `tmp/scratch/mcp-details/<name-slug>/`. Works without the daemon.
 */
export const mcpDetailsCommand = defineCommand({
    meta: {
        name: "mcp-details",
        description:
            "Show setup details of one MCP server from the registries (rating, env vars, tools, README, .env.example, Dockerfile).",
    },
    args: {
        name: {
            type: "positional",
            required: true,
            description:
                "Server name as `tools search-mcp` lists it (e.g. notion, com.notion/mcp).",
        },
        query: {
            type: "string",
            description:
                "The service you are after (e.g. notion) — used for the first-party check.",
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
        const boot = bootstrap();
        if (args.platform !== undefined && !/^[a-z0-9]+\/[a-z0-9]+$/.test(args.platform)) {
            process.stderr.write(
                `--platform must look like linux/arm64, got "${args.platform}".\n`,
            );
            process.exit(1);
        }
        let details: Awaited<ReturnType<typeof lookupMcpDetails>>;
        try {
            details = await lookupMcpDetails({
                name: args.name,
                query: args.query,
                platform: args.platform,
            });
        } catch (err) {
            if (err instanceof McpNotFoundError) {
                process.stderr.write(`${err.message}\n`);
                process.exit(1);
            }
            throw err;
        }
        // The full registry name keeps two servers with the same short id
        // (`notion`, `io.github.x/notion-mcp`) apart.
        const folder = details.subject.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        const spillDir = path.join(boot.scratchDir, "mcp-details", folder);
        const markdown = await renderDetailsReport(details, async (fileName, content) => {
            mkdirSync(spillDir, { recursive: true });
            const target = path.join(spillDir, fileName);
            writeFileSync(target, content, "utf8");
            return target;
        });
        writeMarkdown(markdown, { raw: args.raw === true });
    },
});
