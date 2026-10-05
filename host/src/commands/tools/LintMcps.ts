import { existsSync } from "node:fs";
import { createLogger, type Logger, prettyStdoutStream, writeMarkdown } from "@getfamiliar/shared";
import { defineCommand } from "citty";
import { bootstrap } from "../../Bootstrap.js";
import { readBastionTokenFile } from "../../bastion/BastionToken.js";
import { lintMcpConfigFile } from "../../mcp/McpConfigLoader.js";
import type { McpEntry } from "../../mcp/McpEntry.js";
import { McpRegistry } from "../../mcp/McpRegistry.js";
import { findUnmatchedToolPatterns, TOOL_GATING_FIELDS } from "../../mcp/McpToolPatternLint.js";
import { PluginMcpService } from "../../mcp/PluginMcpService.js";
import { DAEMON_BASTION_LOOPBACK_URL, isDaemonRunning, listToolsFor } from "./render.js";

/**
 * `familiar tools lint-mcps` — validate `config/mcp.yml` (readable or
 * absent, parses, every entry has the fields its source requires) and,
 * when it's valid, list the configured MCPs. Output is markdown, emitted
 * via `writeMarkdown`.
 *
 * Each entry prints as `* <id>: <source> <package>`, where `source` is
 * the verbatim `mcp.yml` source classifier (`docker-mcp-registry`,
 * `npm`, `pypi`, `external`) and `package` is the image / package / url
 * — whichever the source uses, via {@link McpRegistry.info}.
 *
 * When the daemon is running, the `allowlist` / `denylist` / `approval`
 * / `privileged` globs of every entry are additionally checked against
 * the tool names the MCP actually reports through the bastion. A glob
 * that matches no tool is a silent no-op at runtime, so it is listed as
 * a warning (with the tool names it was probably meant to hit). Without
 * the daemon this check is skipped with a note — the static lint never
 * starts MCPs on its own.
 */
export const lintMcpsCommand = defineCommand({
    meta: {
        name: "lint-mcps",
        description:
            "Validate config/mcp.yml, list the configured MCPs, and (with the daemon running) check that every tool gating pattern matches a real tool.",
    },
    args: {
        raw: {
            type: "boolean",
            description:
                "Skip terminal styling and emit the raw markdown verbatim. Useful for piping into a file or a markdown viewer.",
            default: false,
        },
    },
    async run({ args }) {
        const raw = args.raw === true;
        const boot = bootstrap();
        if (!existsSync(boot.mcpConfigFile)) {
            writeMarkdown("`config/mcp.yml` not present (no MCPs configured).\n", { raw });
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

        const gatedEntries = entries.filter(hasToolGatingPatterns);
        if (gatedEntries.length > 0) {
            lines.push("");
            if (isDaemonRunning(boot.pidFile)) {
                lines.push(
                    ...(await lintToolGatingPatterns(
                        registry,
                        gatedEntries,
                        readBastionTokenFile(boot),
                        log,
                    )),
                );
            } else {
                lines.push(
                    "Tool gating patterns not checked: the daemon is not running (`familiar start`), so the MCPs' tool names can't be listed.",
                );
            }
        }

        writeMarkdown(`${lines.join("\n")}\n`, { raw });
    },
});

/**
 * `true` when the entry declares at least one allowlist / denylist /
 * approval / privileged glob — only those entries need their MCP queried.
 *
 * @param entry The parsed `mcp.yml` entry.
 * @returns Whether any gating field is non-empty.
 */
function hasToolGatingPatterns(entry: McpEntry): boolean {
    return TOOL_GATING_FIELDS.some((field) => entry[field].length > 0);
}

/**
 * Query each gated MCP's tool list through the running daemon's bastion
 * and report every gating glob that matches none of its tools.
 *
 * @param registry The registry the entries came from (for the bastion key).
 * @param entries The entries with at least one gating glob.
 * @param bastionToken The running daemon's bastion token (`null` if unknown).
 * @param log Logger for the MCP service.
 * @returns Markdown lines: a heading plus one bullet per finding, or a
 *   single "all patterns match" line.
 */
async function lintToolGatingPatterns(
    registry: McpRegistry,
    entries: readonly McpEntry[],
    bastionToken: string | null,
    log: Logger,
): Promise<string[]> {
    const mcpService = new PluginMcpService({
        registry,
        bastionBaseUrl: DAEMON_BASTION_LOOPBACK_URL,
        bastionToken,
        log: log.child({ component: "mcp-service" }),
    });
    const findings: string[] = [];
    try {
        for (const entry of entries) {
            const key = registry.info(entry).key;
            const listed = await listToolsFor(mcpService, key);
            if (listed.kind === "error") {
                findings.push(`* \`${key}\`: could not list tools (${listed.message})`);
                continue;
            }
            const toolNames = listed.tools.map((t) => t.name);
            for (const miss of findUnmatchedToolPatterns(entry, toolNames)) {
                const hint =
                    miss.suggestions.length > 0
                        ? ` — did you mean ${miss.suggestions.map((s) => `\`${s}\``).join(", ")}?`
                        : "";
                findings.push(
                    `* \`${key}\`: ${miss.field} pattern \`${miss.pattern}\` matches no tool${hint}`,
                );
            }
        }
    } finally {
        try {
            await mcpService.close();
        } catch (err) {
            log.warn(
                { err },
                `closing the MCP service after linting tool gating patterns failed: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }
    if (findings.length === 0) {
        return [
            `Tool gating patterns: all match at least one tool (${entries.length} MCP${entries.length === 1 ? "" : "s"} checked).`,
        ];
    }
    return [
        "**Warning — tool gating patterns that match no tool** (patterns compare against the bare tool name as the MCP reports it, anchored; see `familiar tools list --mcp`):\n",
        ...findings,
    ];
}
