import { existsSync } from "node:fs";
import {
    type ContainerToolInfo,
    createLogger,
    DEFAULT_TOOL_LEVEL,
    matchesAnyToolPattern,
    prettyStdoutStream,
    renderMarkdown,
    type ToolLevel,
} from "@getfamiliar/shared";
import { defineCommand } from "citty";
import { bootstrap } from "../../Bootstrap.js";
import { lintMcpConfigFile } from "../../mcp/McpConfigLoader.js";
import { McpRegistry } from "../../mcp/McpRegistry.js";
import { PluginMcpService } from "../../mcp/PluginMcpService.js";
import {
    type CatalogTool,
    coerceSchema,
    columnBudgets,
    filterTools,
    isDaemonRunning,
    listToolsFor,
    renderAlignedTable,
    renderRawMarkdownTable,
} from "./render.js";
import { verbosityFrom } from "./verbosity.js";

/**
 * Loopback URL of the running daemon's bastion. Matches
 * `Bastion.DEFAULT_PORT` (8788); the daemon never overrides it.
 */
const DAEMON_BASTION_LOOPBACK_URL = "http://127.0.0.1:8788";

/** Curated/built-in groups shown first, in this fixed order. */
const CURATED_GROUP_ORDER = ["core", "fs", "bash", "reflection"];

/** Catalog of one plugin/host-core tool as `GET /plugin-tools/` returns it. */
interface PluginCatalogEntry {
    readonly key: string;
    readonly pluginId: string;
    readonly description: string;
    readonly inputSchema?: unknown;
    readonly groups?: readonly string[];
    readonly level?: ToolLevel;
}

/**
 * `cli.sh tools list [search]` — list every tool the agent can use,
 * grouped by tool group: container built-ins (`send_chat`, `fs_*`, …),
 * host plugin tools (`mail_*`, `whatsapp_*`, the reflection tools), and
 * MCP functions. Optional `search` filters by case-insensitive substring
 * on tool name or description.
 *
 * Requires the daemon: built-ins are read from the catalog the container
 * reported to the bastion (`/container-tools/`), plugin tools from
 * `/plugin-tools/`, and MCP tools from the live bastion via
 * {@link PluginMcpService}. Output is markdown, rendered with
 * `marked-terminal` unless `--raw` is given.
 */
export const listCommand = defineCommand({
    meta: {
        name: "list",
        description:
            "List every tool the agent can use (container built-ins, plugin tools, MCP functions), grouped by tool group. Requires the daemon to be running.",
    },
    args: {
        search: {
            type: "positional",
            required: false,
            description:
                "Optional substring filter; matches tool name or description, case-insensitive.",
        },
        verbose: {
            type: "boolean",
            alias: "v",
            description:
                "Show full descriptions (-v); repeat (-vv) to also show each tool's parameters.",
            default: false,
        },
        mcp: {
            type: "boolean",
            description: "Only MCP functions.",
            default: false,
        },
        native: {
            type: "boolean",
            description: "Only non-MCP tools (container built-ins + plugin/host-core tools).",
            default: false,
        },
        raw: {
            type: "boolean",
            description:
                "Skip terminal styling and emit the raw markdown verbatim. Useful for piping into a file or a markdown viewer.",
            default: false,
        },
    },
    async run({ args, rawArgs }) {
        const level = verbosityFrom(rawArgs);
        const search = (typeof args.search === "string" ? args.search : "").trim().toLowerCase();
        const onlyMcp = args.mcp === true;
        const onlyNative = args.native === true;
        const raw = args.raw === true;

        if (onlyMcp && onlyNative) {
            process.stderr.write("--mcp and --native are mutually exclusive.\n");
            process.exit(1);
        }

        const boot = bootstrap();
        if (!isDaemonRunning(boot.pidFile)) {
            process.stderr.write(
                "daemon is not running; start it first (./cli.sh start) — `tools list` " +
                    "queries the running bastion to enumerate tools.\n",
            );
            process.exit(1);
        }

        const log = createLogger({
            component: "tools-list",
            level: "warn",
            streams: [prettyStdoutStream()],
        });

        const tools: CatalogTool[] = [];
        if (!onlyMcp) {
            tools.push(...(await fetchContainerBuiltins()));
            tools.push(...(await fetchPluginTools()));
        }
        if (!onlyNative) {
            tools.push(...(await fetchMcpTools(boot.mcpConfigFile, log)));
        }

        const filtered = filterTools(tools, search);

        const sections = groupIntoSections(filtered);
        const terminalWidth = process.stdout.columns ?? 100;
        const widths = columnBudgets(terminalWidth, level);

        const parts: string[] = [];
        const heading = search.length > 0 ? `# Tools matching \`${search}\`` : "# Tools";
        parts.push(raw ? `${heading}\n\n` : renderMarkdown(`${heading}\n`));

        for (const section of sections) {
            const sectionTitle =
                section.kind === "mcp" ? `## ${section.group} — _mcp_` : `## ${section.group}`;
            if (raw) {
                parts.push(`${sectionTitle}\n\n`);
                parts.push(renderRawMarkdownTable(section.tools, level));
                parts.push("\n");
            } else {
                parts.push(renderMarkdown(`${sectionTitle}\n`));
                parts.push(renderAlignedTable(section.tools, level, widths));
                parts.push("\n");
            }
        }

        // Footer: the count, then a hint at the flags. The verbosity
        // hint climbs with the active level (-v → suggest -vv; at -vv
        // there's nothing more verbose to suggest, so it's dropped).
        const verbosityHint =
            level === 0
                ? "Use `-v` for full descriptions, "
                : level === 1
                  ? "Use `-vv` for full signatures, "
                  : "Use ";
        const summary =
            `Listed ${filtered.length} tool${filtered.length === 1 ? "" : "s"} ` +
            `across ${sections.length} group${sections.length === 1 ? "" : "s"}. ` +
            `${verbosityHint}\`--mcp\` for only MCP tools, \`--native\` for all others.`;
        parts.push(raw ? `${summary}\n` : renderMarkdown(`\n${summary}\n`));

        process.stdout.write(parts.join(""));
    },
});

/**
 * Read the container's reported built-in catalog from
 * `GET /container-tools/`. Returns `[]` (with a stderr note) if the
 * container hasn't reported yet or the fetch fails — the daemon is up
 * (the caller checked), so an empty/failed read is non-fatal.
 */
async function fetchContainerBuiltins(): Promise<CatalogTool[]> {
    const url = `${DAEMON_BASTION_LOOPBACK_URL}/container-tools/`;
    let body: unknown;
    try {
        const res = await fetch(url);
        if (!res.ok) {
            process.stderr.write(`warning: ${url} → ${res.status} ${res.statusText}\n`);
            return [];
        }
        body = await res.json();
    } catch (err) {
        process.stderr.write(
            `warning: could not read container built-ins (${err instanceof Error ? err.message : String(err)})\n`,
        );
        return [];
    }
    if (!Array.isArray(body)) {
        return [];
    }
    return (body as ContainerToolInfo[]).map((t) => ({
        name: t.name,
        description: t.description,
        groups: [...t.groups],
        origin: "builtin" as const,
        inputSchema: coerceSchema(t.inputSchema),
        level: t.level ?? DEFAULT_TOOL_LEVEL,
    }));
}

/**
 * Read plugin + host-core tools from `GET /plugin-tools/`. A non-`core`
 * plugin's tools auto-group under the plugin id; `core` tools group by
 * their declared `groups` only (the `core` sentinel is not an
 * auto-group). Returns `[]` on a failed fetch (non-fatal).
 */
async function fetchPluginTools(): Promise<CatalogTool[]> {
    const url = `${DAEMON_BASTION_LOOPBACK_URL}/plugin-tools/`;
    let body: unknown;
    try {
        const res = await fetch(url);
        if (!res.ok) {
            process.stderr.write(`warning: ${url} → ${res.status} ${res.statusText}\n`);
            return [];
        }
        body = await res.json();
    } catch (err) {
        process.stderr.write(
            `warning: could not read plugin tools (${err instanceof Error ? err.message : String(err)})\n`,
        );
        return [];
    }
    if (!Array.isArray(body)) {
        return [];
    }
    return (body as PluginCatalogEntry[]).map((t) => {
        const declared = t.groups ?? [];
        const isCore = t.pluginId === "core";
        const groups = isCore ? [...declared] : [...new Set([t.pluginId, ...declared])];
        return {
            name: t.key,
            description: t.description,
            groups,
            origin: isCore ? ("core" as const) : ("plugin" as const),
            inputSchema: coerceSchema(t.inputSchema),
            level: t.level ?? DEFAULT_TOOL_LEVEL,
        };
    });
}

/**
 * Enumerate MCP tools through the live bastion, exactly as the old `mcp
 * functions` command did. Each MCP's tools group under the MCP id.
 * Lints `mcp.yml` first; a malformed file fails the command (it
 * wouldn't load at daemon start either).
 */
async function fetchMcpTools(
    mcpConfigFile: string,
    log: ReturnType<typeof createLogger>,
): Promise<CatalogTool[]> {
    if (!existsSync(mcpConfigFile)) {
        return [];
    }
    const lint = lintMcpConfigFile(mcpConfigFile);
    for (const w of lint.warnings) {
        process.stderr.write(`warning: ${w}\n`);
    }
    if (!lint.ok) {
        for (const e of lint.errors) {
            process.stderr.write(`error: ${e}\n`);
        }
        process.exit(1);
    }

    const registry = new McpRegistry(mcpConfigFile, log);
    const entries = registry.list();
    if (entries.length === 0) {
        return [];
    }
    const mcpService = new PluginMcpService({
        registry,
        bastionBaseUrl: DAEMON_BASTION_LOOPBACK_URL,
        log: log.child({ component: "mcp-service" }),
    });
    const out: CatalogTool[] = [];
    try {
        for (const entry of entries) {
            const info = registry.info(entry);
            const result = await listToolsFor(mcpService, info.key);
            if (result.kind === "error") {
                process.stderr.write(`warning: mcp "${info.key}": ${result.message}\n`);
                continue;
            }
            for (const t of result.tools) {
                // Mirror the container's gating so the operator sees the
                // same surface the agent does: allowlist → denylist →
                // approval → privileged (matched on the bare tool name).
                if (entry.allowlist.length > 0 && !matchesAnyToolPattern(entry.allowlist, t.name)) {
                    continue;
                }
                if (matchesAnyToolPattern(entry.denylist, t.name)) {
                    continue;
                }
                let level: ToolLevel = DEFAULT_TOOL_LEVEL;
                if (matchesAnyToolPattern(entry.approval, t.name)) {
                    level = "approval";
                }
                if (matchesAnyToolPattern(entry.privileged, t.name)) {
                    level = "privileged";
                }
                out.push({
                    name: t.name,
                    description: t.description,
                    groups: [info.key],
                    origin: "mcp",
                    inputSchema: t.inputSchema,
                    outputSchema: t.outputSchema,
                    level,
                });
            }
        }
    } finally {
        try {
            await mcpService.close();
        } catch {
            // best-effort
        }
    }
    return out;
}

interface ToolSection {
    readonly group: string;
    readonly kind: "curated" | "plugin" | "mcp" | "ungrouped";
    readonly tools: CatalogTool[];
}

/**
 * Bucket the flat catalog into one section per tool group. A tool in
 * several groups (e.g. `fs_read` ∈ `core` + `fs`) appears under each —
 * mirroring how a handler's `tools:` list actually resolves.
 * Tools with no group at all collect under a trailing `ungrouped`
 * section. Sections are ordered: curated groups first (fixed order),
 * then plugin groups (alphabetical), then MCP ids (alphabetical),
 * then `ungrouped`.
 */
function groupIntoSections(tools: readonly CatalogTool[]): ToolSection[] {
    const byGroup = new Map<string, CatalogTool[]>();
    const ungrouped: CatalogTool[] = [];
    const mcpGroups = new Set<string>();

    for (const tool of tools) {
        if (tool.groups.length === 0) {
            ungrouped.push(tool);
            continue;
        }
        for (const group of tool.groups) {
            let bucket = byGroup.get(group);
            if (bucket === undefined) {
                bucket = [];
                byGroup.set(group, bucket);
            }
            bucket.push(tool);
            if (tool.origin === "mcp") {
                mcpGroups.add(group);
            }
        }
    }

    const classify = (group: string): ToolSection["kind"] => {
        if (CURATED_GROUP_ORDER.includes(group)) {
            return "curated";
        }
        return mcpGroups.has(group) ? "mcp" : "plugin";
    };

    const rankOf = (kind: ToolSection["kind"]): number =>
        kind === "curated" ? 0 : kind === "plugin" ? 1 : 2;

    const sections: ToolSection[] = [...byGroup.entries()].map(([group, groupTools]) => {
        groupTools.sort((a, b) => a.name.localeCompare(b.name));
        return { group, kind: classify(group), tools: groupTools };
    });

    sections.sort((a, b) => {
        const ra = rankOf(a.kind);
        const rb = rankOf(b.kind);
        if (ra !== rb) {
            return ra - rb;
        }
        if (a.kind === "curated") {
            return CURATED_GROUP_ORDER.indexOf(a.group) - CURATED_GROUP_ORDER.indexOf(b.group);
        }
        return a.group.localeCompare(b.group);
    });

    if (ungrouped.length > 0) {
        ungrouped.sort((a, b) => a.name.localeCompare(b.name));
        sections.push({ group: "ungrouped", kind: "ungrouped", tools: ungrouped });
    }
    return sections;
}
