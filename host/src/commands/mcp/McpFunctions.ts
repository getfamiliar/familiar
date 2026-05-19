import { existsSync, readFileSync } from "node:fs";
import { createLogger, prettyStdoutStream, renderMarkdown } from "@getfamiliar/shared";
import { defineCommand } from "citty";
import { bootstrap } from "../../Bootstrap.js";
import { lintMcpConfigFile } from "../../mcp/McpConfigLoader.js";
import { McpRegistry } from "../../mcp/McpRegistry.js";
import { PluginMcpService } from "../../mcp/PluginMcpService.js";
import { isProcessAlive } from "../pidfile.js";

/**
 * Loopback URL of the running daemon's bastion. Matches
 * `Bastion.DEFAULT_PORT` (8788); the daemon never overrides this
 * today, so a static value is safe.
 */
const DAEMON_BASTION_LOOPBACK_URL = "http://127.0.0.1:8788";

/**
 * `cli.sh mcp functions [search]` — list every tool advertised by every
 * declared MCP, with an optional case-insensitive substring filter
 * on tool name or description. Output is markdown, rendered with
 * `marked-terminal` when stdout is a TTY (same pipeline as
 * `cli.sh report`).
 *
 * Uses the same {@link PluginMcpService} plugins use at runtime, so
 * the listing matches what handlers see. Requires the daemon to be
 * running — bringing up a second bastion would collide on the
 * `familiar-mcp-<id>` container names the daemon's gateway already owns.
 */
export const mcpFunctionsCommand = defineCommand({
    meta: {
        name: "functions",
        description:
            "List all functions (tools) of every declared MCP. Optional search filter matches tool name or description (case-insensitive). Requires the daemon to be running.",
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
            description: "Include each tool's arguments and return-type schema.",
            default: false,
        },
        raw: {
            type: "boolean",
            description:
                "Skip terminal styling and emit the raw markdown verbatim. Useful for piping into a file or a markdown viewer.",
            default: false,
        },
    },
    async run({ args }) {
        const searchRaw = typeof args.search === "string" ? args.search : "";
        const search = searchRaw.trim().toLowerCase();
        const verbose = args.verbose === true;
        const raw = args.raw === true;

        const boot = bootstrap();
        if (!existsSync(boot.mcpConfigFile)) {
            process.stdout.write("no MCPs declared (config/mcp.yml not present)\n");
            return;
        }

        const lint = lintMcpConfigFile(boot.mcpConfigFile);
        for (const w of lint.warnings) {
            process.stderr.write(`warning: ${w}\n`);
        }
        if (!lint.ok) {
            for (const e of lint.errors) {
                process.stderr.write(`error: ${e}\n`);
            }
            process.exit(1);
        }

        if (!isDaemonRunning(boot.pidFile)) {
            process.stderr.write(
                "daemon is not running; start it first (./cli.sh start) — `mcp functions` " +
                    "queries the running bastion to enumerate MCP tools.\n",
            );
            process.exit(1);
        }

        const log = createLogger({
            component: "mcp-functions",
            level: "warn",
            streams: [prettyStdoutStream()],
        });

        const registry = new McpRegistry(boot.mcpConfigFile, log);
        const entries = registry.list();
        if (entries.length === 0) {
            process.stdout.write("no MCPs declared\n");
            return;
        }

        const mcpService = new PluginMcpService({
            registry,
            bastionBaseUrl: DAEMON_BASTION_LOOPBACK_URL,
            log: log.child({ component: "mcp-service" }),
        });

        // Terminal mode pre-wraps cells to fit `process.stdout.columns`;
        // raw mode keeps every cell on a single line so the markdown
        // table is pipeable into a viewer that does its own layout.
        const terminalWidth = process.stdout.columns ?? 100;
        const widths = raw ? null : columnBudgets(terminalWidth, verbose);

        // Two output paths: raw produces one unified markdown doc with
        // standard pipe tables; terminal mode interleaves rendered
        // markdown (headings, summary) with pre-aligned plain-text
        // tables, because marked-terminal's `cli-table3` backing can't
        // fit wrapped cells inside the terminal width.
        const parts: string[] = [];
        const heading =
            search.length > 0 ? `# MCP functions matching \`${search}\`` : "# MCP functions";
        if (raw) {
            parts.push(`${heading}\n\n`);
        } else {
            parts.push(renderMarkdown(`${heading}\n`));
        }

        let matchedTools = 0;
        let matchedMcps = 0;
        let listErrors = 0;
        try {
            for (const entry of entries) {
                const info = registry.info(entry);
                const result = await listToolsFor(mcpService, info.key);
                const sectionTitle = `## ${info.key} — _${info.source}_: \`${info.package}\``;
                if (result.kind === "error") {
                    listErrors += 1;
                    const body = `> **Error:** ${escapeMd(result.message)}`;
                    parts.push(
                        raw
                            ? `${sectionTitle}\n\n${body}\n\n`
                            : `${renderMarkdown(`${sectionTitle}\n\n${body}\n`)}\n`,
                    );
                    continue;
                }
                const filtered = filterTools(result.tools, search);
                if (search.length > 0 && filtered.length === 0) {
                    continue;
                }
                matchedMcps += 1;
                matchedTools += filtered.length;
                if (raw) {
                    parts.push(`${sectionTitle}\n\n`);
                    parts.push(renderRawMarkdownTable(filtered, verbose));
                    parts.push("\n");
                } else if (widths !== null) {
                    parts.push(renderMarkdown(`${sectionTitle}\n`));
                    parts.push(renderAlignedTable(filtered, verbose, widths));
                    parts.push("\n");
                }
            }
        } finally {
            try {
                await mcpService.close();
            } catch {
                // swallow — best-effort
            }
        }

        const summary =
            `_matched ${matchedTools} tool${matchedTools === 1 ? "" : "s"} ` +
            `across ${matchedMcps} MCP${matchedMcps === 1 ? "" : "s"}_`;
        if (raw) {
            parts.push(`${summary}\n`);
        } else {
            parts.push(renderMarkdown(`\n${summary}\n`));
        }

        process.stdout.write(parts.join(""));

        if (listErrors === entries.length) {
            process.exit(1);
        }
    },
});

/**
 * Per-column character budgets used to pre-wrap cell content so each
 * row fits inside the terminal. Computed from `process.stdout.columns`
 * once per command run.
 */
interface ColumnWidths {
    readonly name: number;
    readonly arguments: number;
    readonly returns: number;
    readonly description: number;
}

/**
 * Budget per column derived from the actual terminal width. Allows
 * 2 chars of inter-column padding plus 2 chars of slack so a
 * borderline row doesn't get clipped by a slow-resized terminal.
 */
function columnBudgets(terminalWidth: number, verbose: boolean): ColumnWidths {
    const padding = verbose ? 6 : 2; // inter-column spaces
    const usable = Math.max(40, terminalWidth - padding - 2);
    if (!verbose) {
        const name = Math.min(24, Math.max(10, Math.floor(usable * 0.22)));
        const description = Math.max(20, usable - name);
        return { name, arguments: 0, returns: 0, description };
    }
    const name = Math.min(20, Math.max(10, Math.floor(usable * 0.14)));
    const argumentsWidth = Math.min(32, Math.max(16, Math.floor(usable * 0.26)));
    const returnsWidth = Math.min(28, Math.max(14, Math.floor(usable * 0.2)));
    const description = Math.max(20, usable - name - argumentsWidth - returnsWidth);
    return { name, arguments: argumentsWidth, returns: returnsWidth, description };
}

/**
 * Build a plain-text aligned table that fits the terminal. Each
 * cell is word-wrapped to its column budget; rows whose cells wrap
 * to different heights are stacked so columns stay aligned.
 *
 * Layout: a header row, an underline of dashes, then the data
 * rows. Columns are separated by two spaces — no box-drawing,
 * which is what made the previous `cli-table3` output blow past
 * the terminal width.
 */
function renderAlignedTable(
    tools: readonly ToolRecord[],
    verbose: boolean,
    widths: ColumnWidths,
): string {
    if (tools.length === 0) {
        return "(no tools)\n";
    }
    const columns = verbose
        ? [
              { header: "Name", width: widths.name },
              { header: "Arguments", width: widths.arguments },
              { header: "Returns", width: widths.returns },
              { header: "Description", width: widths.description },
          ]
        : [
              { header: "Name", width: widths.name },
              { header: "Description", width: widths.description },
          ];

    const lines: string[] = [];
    lines.push(columns.map((c) => padEnd(c.header, c.width)).join("  "));
    lines.push(columns.map((c) => "─".repeat(c.width)).join("  "));

    for (const tool of tools) {
        const cells = verbose
            ? [
                  wrapWords(tool.name, widths.name),
                  schemaLines(tool.inputSchema, widths.arguments, "(none)"),
                  returnsLines(tool.outputSchema, widths.returns),
                  wrapWords(oneLine(tool.description), widths.description),
              ]
            : [
                  wrapWords(tool.name, widths.name),
                  wrapWords(oneLine(tool.description), widths.description),
              ];
        const rowHeight = Math.max(1, ...cells.map((c) => c.length));
        for (let i = 0; i < rowHeight; i += 1) {
            const parts = cells.map((cellLines, idx) =>
                padEnd(cellLines[i] ?? "", columns[idx].width),
            );
            lines.push(parts.join("  ").trimEnd());
        }
    }
    return `${lines.join("\n")}\n`;
}

/**
 * Render the schema as a list of wrapped lines for the aligned
 * table. Empty/missing schemas collapse to a single sentinel line
 * supplied by the caller (e.g. `(none)`, `unspecified`).
 */
function schemaLines(
    schema: JsonSchemaObject | undefined,
    width: number,
    emptySentinel: string,
): string[] {
    if (schema === undefined) {
        return [emptySentinel];
    }
    const properties = schema.properties ?? {};
    const names = Object.keys(properties);
    if (names.length === 0) {
        return [emptySentinel];
    }
    const requiredSet = new Set(schema.required ?? []);
    const out: string[] = [];
    for (const name of names) {
        const prop = properties[name];
        const type = typeFor(prop);
        const reqMarker = requiredSet.has(name) ? " (required)" : "";
        const description =
            typeof prop?.description === "string" && prop.description.trim().length > 0
                ? ` — ${oneLine(prop.description)}`
                : "";
        const line = `${name} (${type})${reqMarker}${description}`;
        for (const wrapped of wrapWords(line, width)) {
            out.push(wrapped);
        }
    }
    return out;
}

/**
 * Render the outputSchema as cell lines. Top-level type leads;
 * properties follow when the schema is an object. Empty/missing
 * schemas show `unspecified`.
 */
function returnsLines(schema: JsonSchemaObject | undefined, width: number): string[] {
    if (schema === undefined) {
        return ["unspecified"];
    }
    const topType = typeFor(schema);
    const properties = schema.properties ?? {};
    const names = Object.keys(properties);
    if (names.length === 0) {
        return wrapWords(topType, width);
    }
    const out = wrapWords(topType, width);
    out.push(...schemaLines(schema, width, "(empty)"));
    return out;
}

/** Pad `text` on the right with spaces so its visual length is `width`. */
function padEnd(text: string, width: number): string {
    if (text.length >= width) {
        return text;
    }
    return text + " ".repeat(width - text.length);
}

/**
 * Render a row-based GitHub-flavoured markdown table. Used for
 * --raw output: every cell is on a single line, pipes and
 * backslashes are escaped, and the result is a pipeable doc that
 * a markdown viewer can lay out itself.
 */
function renderRawMarkdownTable(tools: readonly ToolRecord[], verbose: boolean): string {
    const columns = verbose
        ? ["Name", "Arguments", "Returns", "Description"]
        : ["Name", "Description"];
    const rows = tools.map((tool) =>
        verbose
            ? [
                  `\`${tool.name}\``,
                  escapeCell(formatSchemaInline(tool.inputSchema, "_(none)_")),
                  escapeCell(formatReturnsInline(tool.outputSchema)),
                  escapeCell(oneLine(tool.description)),
              ]
            : [`\`${tool.name}\``, escapeCell(oneLine(tool.description))],
    );
    const header = `| ${columns.join(" | ")} |`;
    const separator = `| ${columns.map(() => "---").join(" | ")} |`;
    const body = rows.map((row) => `| ${row.join(" | ")} |`).join("\n");
    return `${header}\n${separator}\n${body}\n`;
}

/**
 * Flatten an inputSchema (or any object schema) to a single-line
 * comma-separated list for raw-mode markdown table cells.
 */
function formatSchemaInline(schema: JsonSchemaObject | undefined, emptySentinel: string): string {
    if (schema === undefined) {
        return emptySentinel;
    }
    const properties = schema.properties ?? {};
    const names = Object.keys(properties);
    if (names.length === 0) {
        return emptySentinel;
    }
    const requiredSet = new Set(schema.required ?? []);
    return names
        .map((name) => {
            const prop = properties[name];
            const type = typeFor(prop);
            const reqMarker = requiredSet.has(name) ? " (required)" : "";
            return `${name} (${type})${reqMarker}`;
        })
        .join(", ");
}

/** Same as {@link formatSchemaInline} but prefixes the top-level type. */
function formatReturnsInline(schema: JsonSchemaObject | undefined): string {
    if (schema === undefined) {
        return "_unspecified_";
    }
    const topType = typeFor(schema);
    const properties = schema.properties ?? {};
    const names = Object.keys(properties);
    if (names.length === 0) {
        return topType;
    }
    return `${topType} { ${formatSchemaInline(schema, "")} }`;
}

/**
 * Greedy word wrap. Whitespace is normalised to single spaces;
 * tokens longer than `width` are emitted on a line of their own
 * (hard-broken if necessary so the column doesn't overflow).
 */
function wrapWords(text: string, width: number): string[] {
    const tokens = text.split(/\s+/).filter((t) => t.length > 0);
    const lines: string[] = [];
    let current = "";
    for (const token of tokens) {
        if (token.length > width) {
            if (current.length > 0) {
                lines.push(current);
                current = "";
            }
            for (let i = 0; i < token.length; i += width) {
                const chunk = token.slice(i, i + width);
                if (i + width >= token.length) {
                    current = chunk;
                } else {
                    lines.push(chunk);
                }
            }
            continue;
        }
        if (current.length === 0) {
            current = token;
            continue;
        }
        if (current.length + 1 + token.length <= width) {
            current = `${current} ${token}`;
            continue;
        }
        lines.push(current);
        current = token;
    }
    if (current.length > 0) {
        lines.push(current);
    }
    return lines;
}

/**
 * Escape characters that would break a markdown table cell in
 * --raw mode: `|` splits columns, raw newlines break the row,
 * backslashes need to stay literal. Backticks are left alone so
 * inline-code spans survive.
 */
function escapeCell(text: string): string {
    return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/**
 * Best-effort projection of a JSON Schema fragment's type to a
 * short display string. Handles `type: "string"`, arrays of types,
 * enums, and the absence of any of those by falling back to `any`.
 */
function typeFor(prop: JsonSchemaProperty | undefined): string {
    if (prop === undefined || prop === null) {
        return "any";
    }
    if (Array.isArray(prop.type)) {
        return prop.type.join(" | ");
    }
    if (typeof prop.type === "string") {
        if (prop.type === "array") {
            const items = prop.items;
            if (items !== undefined && items !== null && typeof items === "object") {
                const inner = typeFor(items as JsonSchemaProperty);
                return `array<${inner}>`;
            }
            return "array";
        }
        return prop.type;
    }
    if (Array.isArray(prop.enum) && prop.enum.length > 0) {
        return prop.enum.map((v) => JSON.stringify(v)).join(" | ");
    }
    return "any";
}

/** Tool record projected from the MCP SDK's `listTools` response. */
interface ToolRecord {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: JsonSchemaObject | undefined;
    readonly outputSchema: JsonSchemaObject | undefined;
}

interface JsonSchemaProperty {
    readonly type?: string | readonly string[];
    readonly description?: string;
    readonly enum?: readonly unknown[];
    readonly items?: unknown;
}

interface JsonSchemaObject extends JsonSchemaProperty {
    readonly properties?: Record<string, JsonSchemaProperty>;
    readonly required?: readonly string[];
}

type ListResult = { kind: "ok"; tools: ToolRecord[] } | { kind: "error"; message: string };

/**
 * Call `listTools` against one MCP key and project the response down
 * to {@link ToolRecord}s. Errors are returned as a value so the
 * caller can continue with the next MCP instead of aborting the
 * whole listing.
 */
async function listToolsFor(service: PluginMcpService, key: string): Promise<ListResult> {
    try {
        const client = service.getByKey(key);
        const response = (await client.listTools()) as { tools?: ReadonlyArray<unknown> };
        const tools: ToolRecord[] = [];
        for (const raw of response.tools ?? []) {
            if (raw === null || typeof raw !== "object") {
                continue;
            }
            const obj = raw as Record<string, unknown>;
            const name = typeof obj.name === "string" ? obj.name : "";
            const description = typeof obj.description === "string" ? obj.description : "";
            if (name.length === 0) {
                continue;
            }
            tools.push({
                name,
                description,
                inputSchema: coerceSchema(obj.inputSchema),
                outputSchema: coerceSchema(obj.outputSchema),
            });
        }
        return { kind: "ok", tools };
    } catch (err) {
        return { kind: "error", message: err instanceof Error ? err.message : String(err) };
    }
}

/**
 * Narrow `unknown` to {@link JsonSchemaObject} when the value looks
 * like a JSON-Schema object (a plain object, not an array). Returns
 * `undefined` otherwise — the renderer treats that as "schema not
 * provided" rather than failing.
 */
function coerceSchema(value: unknown): JsonSchemaObject | undefined {
    if (value === null || value === undefined) {
        return undefined;
    }
    if (typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }
    return value as JsonSchemaObject;
}

/** Filter tools by case-insensitive substring on name or description. */
function filterTools(tools: readonly ToolRecord[], search: string): ToolRecord[] {
    if (search.length === 0) {
        return [...tools];
    }
    return tools.filter(
        (tool) =>
            tool.name.toLowerCase().includes(search) ||
            tool.description.toLowerCase().includes(search),
    );
}

/** Collapse a multi-line description to a single space-separated line. */
function oneLine(description: string): string {
    const trimmed = description.trim();
    if (trimmed.length === 0) {
        return "(no description)";
    }
    return trimmed.replace(/\s+/g, " ");
}

/**
 * Escape the few markdown punctuation characters that show up
 * mid-description and would otherwise be reinterpreted by the
 * renderer (mainly backticks and underscores in MCP descriptions
 * referring to field names like `_meta` or `<<<token>>>`).
 */
function escapeMd(text: string): string {
    return text.replace(/([\\`*_<>])/g, "\\$1");
}

/**
 * `true` if a daemon is running and its pid is alive. Tolerates a
 * stale pidfile: a dead pid means the daemon is stopped.
 */
function isDaemonRunning(pidFile: string): boolean {
    if (!existsSync(pidFile)) {
        return false;
    }
    try {
        const raw = readFileSync(pidFile, "utf-8").trim();
        const pid = Number.parseInt(raw, 10);
        if (!Number.isFinite(pid) || pid <= 0) {
            return false;
        }
        return isProcessAlive(pid);
    } catch {
        return false;
    }
}
