import { existsSync } from "node:fs";
import { createLogger, prettyStdoutStream, renderMarkdown } from "@getfamiliar/shared";
import { defineCommand } from "citty";
import { bootstrap } from "../../Bootstrap.js";
import { lintMcpConfigFile } from "../../mcp/McpConfigLoader.js";
import { McpRegistry } from "../../mcp/McpRegistry.js";

/**
 * `cli.sh tools lint-mcps` — validate `config/mcp.yml` (readable or
 * absent, parses, every entry has the fields its source requires) and,
 * when it's valid, list the configured MCPs. Output is markdown,
 * rendered with `marked-terminal`.
 *
 * Each entry prints as `* <id>: <source> <package>`, where `source` is
 * the verbatim `mcp.yml` source classifier (`docker-mcp-registry`,
 * `npm`, `pypi`, `external`) and `package` is the image / package / url
 * — whichever the source uses, via {@link McpRegistry.info}.
 */
export const lintMcpsCommand = defineCommand({
    meta: {
        name: "lint-mcps",
        description: "Validate config/mcp.yml and list the configured MCPs (id, source, package).",
    },
    run() {
        const boot = bootstrap();
        if (!existsSync(boot.mcpConfigFile)) {
            process.stdout.write(
                renderMarkdown("`config/mcp.yml` not present (no MCPs configured).\n"),
            );
            return;
        }

        const result = lintMcpConfigFile(boot.mcpConfigFile);
        for (const w of result.warnings) {
            process.stderr.write(`warning: ${w}\n`);
        }
        if (!result.ok) {
            for (const e of result.errors) {
                process.stderr.write(`error: ${e}\n`);
            }
            process.exit(1);
        }

        const log = createLogger({
            component: "tools-lint-mcps",
            level: "warn",
            streams: [prettyStdoutStream()],
        });
        const registry = new McpRegistry(boot.mcpConfigFile, log);
        const entries = registry.list();

        const lines: string[] = [];
        lines.push("Checking `config/mcp.yml`: file structure okay.\n");
        lines.push(`${entries.length} MCP${entries.length === 1 ? "" : "s"} configured:`);
        for (const entry of entries) {
            const info = registry.info(entry);
            lines.push(`* ${info.key}: ${info.source} ${info.package}`);
        }
        process.stdout.write(renderMarkdown(`${lines.join("\n")}\n`));
    },
});
