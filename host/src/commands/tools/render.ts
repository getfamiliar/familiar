import { existsSync, readFileSync } from "node:fs";
import type { PluginMcpService } from "../../mcp/PluginMcpService.js";
import { isProcessAlive } from "../pidfile.js";

/**
 * Verbosity level for `tools list`, derived from the count of `-v` /
 * `--verbose` flags:
 *
 * - `0` — one-line, truncated descriptions.
 * - `1` — full (multiline-wrapped) descriptions.
 * - `2` — full descriptions plus argument / return schemas.
 */
export type Verbosity = 0 | 1 | 2;

/** Where a tool comes from — drives its section grouping and labels. */
export type ToolOrigin = "builtin" | "core" | "plugin" | "mcp";

/**
 * One tool in the unified `tools list` catalog, projected from any of
 * the three sources (container built-ins, plugin/host-core tools, MCP
 * tools) into a single shape the renderer consumes.
 */
export interface CatalogTool {
    /** Agent-facing tool name / key. */
    readonly name: string;
    /** Human-readable description (may be empty). */
    readonly description: string;
    /** Tool groups this tool belongs to (built-in/curated groups, plugin id, or MCP id). */
    readonly groups: readonly string[];
    /** Source classifier. */
    readonly origin: ToolOrigin;
    /** Argument JSON Schema, when known (built-ins, plugin tools, MCP tools all carry one). */
    readonly inputSchema?: JsonSchemaObject;
    /** Return JSON Schema — only MCP tools advertise one. */
    readonly outputSchema?: JsonSchemaObject;
}

export interface JsonSchemaProperty {
    readonly type?: string | readonly string[];
    readonly description?: string;
    readonly enum?: readonly unknown[];
    readonly items?: unknown;
}

export interface JsonSchemaObject extends JsonSchemaProperty {
    readonly properties?: Record<string, JsonSchemaProperty>;
    readonly required?: readonly string[];
}

/** Tool record projected from an MCP SDK `listTools` response. */
export interface McpToolRecord {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: JsonSchemaObject | undefined;
    readonly outputSchema: JsonSchemaObject | undefined;
}

export type McpListResult =
    | { kind: "ok"; tools: McpToolRecord[] }
    | { kind: "error"; message: string };

/**
 * Per-column character budgets used to pre-wrap cell content so each
 * row fits inside the terminal. Computed once per command run.
 */
export interface ColumnWidths {
    readonly name: number;
    readonly arguments: number;
    readonly returns: number;
    readonly description: number;
}

/**
 * Budget per column derived from the actual terminal width. At level 2
 * the Arguments / Returns columns are carved out; below that the
 * description gets the remaining width. Allows a couple of chars of
 * inter-column padding plus slack so a borderline row isn't clipped.
 */
export function columnBudgets(terminalWidth: number, level: Verbosity): ColumnWidths {
    const verbose = level === 2;
    const padding = verbose ? 6 : 2;
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
 * Build a plain-text aligned table that fits the terminal. Each cell is
 * word-wrapped to its column budget; rows whose cells wrap to different
 * heights are stacked so columns stay aligned. Columns are separated by
 * two spaces — no box-drawing.
 *
 * - level 0: Name | Description, description truncated to a single line.
 * - level 1: Name | Description, full multiline descriptions.
 * - level 2: Name | Arguments | Returns | Description.
 */
export function renderAlignedTable(
    tools: readonly CatalogTool[],
    level: Verbosity,
    widths: ColumnWidths,
): string {
    if (tools.length === 0) {
        return "(no tools)\n";
    }
    const verbose = level === 2;
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
        const descriptionLines =
            level === 0
                ? [truncateLine(oneLine(tool.description), widths.description)]
                : wrapWords(oneLine(tool.description), widths.description);
        const cells = verbose
            ? [
                  wrapWords(tool.name, widths.name),
                  schemaLines(tool.inputSchema, widths.arguments, "(none)"),
                  returnsLines(tool.outputSchema, widths.returns),
                  descriptionLines,
              ]
            : [wrapWords(tool.name, widths.name), descriptionLines];
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
 * Render a row-based GitHub-flavoured markdown table for `--raw`
 * output: every cell on a single line, pipes / backslashes escaped, so
 * the result is a pipeable doc a markdown viewer can lay out itself. At
 * level 2 the Arguments / Returns columns are added.
 */
export function renderRawMarkdownTable(tools: readonly CatalogTool[], level: Verbosity): string {
    const verbose = level === 2;
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
 * Render the schema as a list of wrapped lines for the aligned table.
 * Empty/missing schemas collapse to a single sentinel line.
 */
export function schemaLines(
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

/** Render the outputSchema as cell lines (top-level type leads). */
export function returnsLines(schema: JsonSchemaObject | undefined, width: number): string[] {
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

/** Flatten an object schema to a single-line comma-separated list for raw cells. */
export function formatSchemaInline(
    schema: JsonSchemaObject | undefined,
    emptySentinel: string,
): string {
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
export function formatReturnsInline(schema: JsonSchemaObject | undefined): string {
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

/** Pad `text` on the right with spaces so its visual length is `width`. */
export function padEnd(text: string, width: number): string {
    if (text.length >= width) {
        return text;
    }
    return text + " ".repeat(width - text.length);
}

/** Truncate `text` to a single line of at most `width` chars, eliding with `…`. */
export function truncateLine(text: string, width: number): string {
    if (text.length <= width) {
        return text;
    }
    return `${text.slice(0, Math.max(1, width - 1))}…`;
}

/**
 * Greedy word wrap. Whitespace is normalised to single spaces; tokens
 * longer than `width` are hard-broken so the column doesn't overflow.
 */
export function wrapWords(text: string, width: number): string[] {
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
 * Escape characters that would break a markdown table cell in `--raw`
 * mode: `|` splits columns, raw newlines break the row, backslashes
 * need to stay literal. Backticks are left alone so inline-code spans
 * survive.
 */
export function escapeCell(text: string): string {
    return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/**
 * Escape the markdown punctuation that shows up mid-description and
 * would otherwise be reinterpreted by the terminal renderer (backticks,
 * underscores in field names like `_meta`, angle brackets).
 */
export function escapeMd(text: string): string {
    return text.replace(/([\\`*_<>])/g, "\\$1");
}

/**
 * Best-effort projection of a JSON Schema fragment's type to a short
 * display string. Handles `type: "string"`, arrays of types, array item
 * types, enums, and falls back to `any`.
 */
export function typeFor(prop: JsonSchemaProperty | undefined): string {
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

/**
 * Narrow `unknown` to {@link JsonSchemaObject} when it looks like a
 * JSON-Schema object (a plain object, not an array). Returns `undefined`
 * otherwise — the renderer treats that as "schema not provided".
 */
export function coerceSchema(value: unknown): JsonSchemaObject | undefined {
    if (value === null || value === undefined) {
        return undefined;
    }
    if (typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }
    return value as JsonSchemaObject;
}

/** Collapse a multi-line description to a single space-separated line. */
export function oneLine(description: string): string {
    const trimmed = description.trim();
    if (trimmed.length === 0) {
        return "(no description)";
    }
    return trimmed.replace(/\s+/g, " ");
}

/** Filter tools by case-insensitive substring on name or description. */
export function filterTools(tools: readonly CatalogTool[], search: string): CatalogTool[] {
    if (search.length === 0) {
        return [...tools];
    }
    return tools.filter(
        (tool) =>
            tool.name.toLowerCase().includes(search) ||
            tool.description.toLowerCase().includes(search),
    );
}

/**
 * Call `listTools` against one MCP key and project the response down to
 * {@link McpToolRecord}s. Errors are returned as a value so the caller
 * can continue with the next MCP instead of aborting the whole listing.
 */
export async function listToolsFor(service: PluginMcpService, key: string): Promise<McpListResult> {
    try {
        const client = service.getByKey(key);
        const response = (await client.listTools()) as { tools?: ReadonlyArray<unknown> };
        const tools: McpToolRecord[] = [];
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
 * `true` if a daemon is running and its pid is alive. Tolerates a stale
 * pidfile: a dead pid means the daemon is stopped.
 */
export function isDaemonRunning(pidFile: string): boolean {
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
