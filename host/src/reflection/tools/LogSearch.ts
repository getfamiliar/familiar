import { promises as fs } from "node:fs";
import path from "node:path";
import { type PluginTool, runTextTool, ToolError } from "@getfamiliar/shared";
import type { ReflectionToolsDeps } from "../ReflectionTools.js";

interface LogSearchArgs {
    readonly mcp?: string;
    readonly maxCount?: number;
    readonly search?: string;
    readonly from?: string;
    readonly to?: string;
}

const DEFAULT_MAX_COUNT = 50;
const MAX_MAX_COUNT = 500;

/**
 * Build the `log_search` reflection tool — grep the daemon log
 * (`/data/logs/familiar.YYYYMMDD.N.log`, pino JSONL) or one MCP's
 * log (`/data/logs/mcp/<id>.YYYYMMDD.N.log`, raw lines). Returns
 * matching lines verbatim, newest first. No markdown wrapping.
 *
 * `from` / `to` are ISO timestamps that bound `time` (daemon logs)
 * or the per-file calendar day (MCP logs — only `HH:MM:SS.mmm` is
 * in the line, the date comes from the filename). Substring match
 * is case-insensitive.
 */
export function buildLogSearchTool(deps: ReflectionToolsDeps): PluginTool<LogSearchArgs, string> {
    return {
        name: "log_search",
        description:
            "Search the daemon log or one MCP's log for lines matching a substring. " +
            "Returns matching lines verbatim — JSONL for the daemon log " +
            "(`{level, time, component, msg, …}`), raw `HH:MM:SS.mmm [out|err] <line>` " +
            "for MCP logs. Newest first. Pass `mcp` to target one MCP " +
            "(e.g. `ms365`, `fetch`); omit it to search the main daemon log. " +
            "`from` / `to` are ISO timestamps; `maxCount` defaults to 50, max 500.",
        groups: ["reflection"],
        inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
                mcp: {
                    type: "string",
                    description:
                        "Optional MCP id (matches the filename prefix under " +
                        "`/data/logs/mcp/`). When omitted, the daemon log is searched.",
                },
                maxCount: {
                    type: "integer",
                    minimum: 1,
                    maximum: MAX_MAX_COUNT,
                    description: `Max matching lines (default ${DEFAULT_MAX_COUNT}, max ${MAX_MAX_COUNT}).`,
                },
                search: {
                    type: "string",
                    description:
                        "Case-insensitive substring matched against the whole line. Omit to " +
                        "return the most recent N lines.",
                },
                from: { type: "string", description: "ISO timestamp; inclusive lower bound." },
                to: { type: "string", description: "ISO timestamp; exclusive upper bound." },
            },
        },
        execute: (args, callCtx) =>
            runTextTool(async () => {
                const maxCount = parseMax(args.maxCount);
                const needle = args.search?.toLowerCase();
                const from = parseDate(args.from, "from");
                const to = parseDate(args.to, "to");

                const isMcp = typeof args.mcp === "string" && args.mcp.length > 0;
                if (isMcp) {
                    validateMcpId(args.mcp as string);
                }

                const dir = isMcp ? path.join(deps.logsDir, "mcp") : deps.logsDir;
                const namePrefix = isMcp ? `${args.mcp}.` : "familiar.";
                const files = await listLogFiles(dir, namePrefix, from, to);

                const matches: string[] = [];
                for (const file of files) {
                    const lines = await readLines(path.join(dir, file));
                    // Walk newest line first within the file (still file-by-file
                    // newest first because `files` is sorted by descending date).
                    for (let i = lines.length - 1; i >= 0; i--) {
                        const line = lines[i];
                        if (line.length === 0) {
                            continue;
                        }
                        if (!matchesNeedle(line, needle)) {
                            continue;
                        }
                        if (!matchesWindow(line, file, namePrefix, from, to, isMcp)) {
                            continue;
                        }
                        matches.push(line);
                        if (matches.length >= maxCount) {
                            return joinMatches(matches);
                        }
                    }
                }
                if (matches.length === 0) {
                    return "(no matching log lines)\n";
                }
                return joinMatches(matches);
            }, callCtx.toolRunContext),
    };
}

function joinMatches(matches: readonly string[]): string {
    return `${matches.join("\n")}\n`;
}

function parseMax(raw: unknown): number {
    if (raw === undefined || raw === null) {
        return DEFAULT_MAX_COUNT;
    }
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0 || raw > MAX_MAX_COUNT) {
        throw new ToolError(
            "InvalidArgument",
            `maxCount must be an integer in [1, ${MAX_MAX_COUNT}], got ${JSON.stringify(raw)}.`,
        );
    }
    return raw;
}

function parseDate(raw: unknown, field: string): Date | undefined {
    if (raw === undefined || raw === null || raw === "") {
        return undefined;
    }
    if (typeof raw !== "string") {
        throw new ToolError(
            "InvalidArgument",
            `${field} must be an ISO-8601 string, got ${JSON.stringify(raw)}.`,
        );
    }
    const millis = Date.parse(raw);
    if (!Number.isFinite(millis)) {
        throw new ToolError("InvalidArgument", `${field} could not be parsed as ISO-8601: ${raw}.`);
    }
    return new Date(millis);
}

/** Reject `..`, slashes — `mcp` becomes part of a filename. */
function validateMcpId(value: string): void {
    if (value.includes("/") || value.includes("\\") || value.includes("..")) {
        throw new ToolError(
            "InvalidArgument",
            `mcp must not contain path separators or '..', got ${JSON.stringify(value)}.`,
        );
    }
}

/**
 * List log files in `dir` matching `<prefix><YYYYMMDD>.<N>.log`, sorted
 * newest-first by the date in the filename. When `from` / `to` are
 * supplied, files whose entire date is outside the window are skipped.
 */
async function listLogFiles(
    dir: string,
    prefix: string,
    from: Date | undefined,
    to: Date | undefined,
): Promise<readonly string[]> {
    let entries: import("node:fs").Dirent[];
    try {
        entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            return [];
        }
        throw err;
    }
    const pattern = new RegExp(`^${escapeRegex(prefix)}(\\d{8})\\.\\d+\\.log$`);
    const matched: Array<{ name: string; day: string }> = [];
    for (const entry of entries) {
        if (!entry.isFile()) {
            continue;
        }
        const m = pattern.exec(entry.name);
        if (m === null) {
            continue;
        }
        const day = m[1];
        if (!isDayInWindow(day, from, to)) {
            continue;
        }
        matched.push({ name: entry.name, day });
    }
    matched.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
    return matched.map((m) => m.name);
}

function isDayInWindow(day: string, from: Date | undefined, to: Date | undefined): boolean {
    const start = Date.UTC(
        Number.parseInt(day.slice(0, 4), 10),
        Number.parseInt(day.slice(4, 6), 10) - 1,
        Number.parseInt(day.slice(6, 8), 10),
    );
    const end = start + 24 * 60 * 60 * 1000;
    if (from !== undefined && end <= from.getTime()) {
        return false;
    }
    if (to !== undefined && start >= to.getTime()) {
        return false;
    }
    return true;
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function readLines(filePath: string): Promise<readonly string[]> {
    const content = await fs.readFile(filePath, "utf8");
    return content.split("\n");
}

function matchesNeedle(line: string, needle: string | undefined): boolean {
    if (needle === undefined || needle.length === 0) {
        return true;
    }
    return line.toLowerCase().includes(needle);
}

/**
 * Per-line date filter. For daemon JSONL we parse `time` from the
 * payload; for MCP plain-text the line only carries `HH:MM:SS.mmm`,
 * so we approximate by combining it with the file's calendar day
 * (already pre-filtered to the window).
 */
function matchesWindow(
    line: string,
    file: string,
    prefix: string,
    from: Date | undefined,
    to: Date | undefined,
    isMcp: boolean,
): boolean {
    if (from === undefined && to === undefined) {
        return true;
    }
    const instant = isMcp ? mcpLineInstant(line, file, prefix) : daemonLineInstant(line);
    if (instant === undefined) {
        // Unparseable timestamp — keep the line; the file-level day
        // gate already established a coarse window.
        return true;
    }
    if (from !== undefined && instant < from.getTime()) {
        return false;
    }
    if (to !== undefined && instant >= to.getTime()) {
        return false;
    }
    return true;
}

function daemonLineInstant(line: string): number | undefined {
    const tsMatch = /"time":"([^"]+)"/.exec(line);
    if (tsMatch === null) {
        return undefined;
    }
    const ms = Date.parse(tsMatch[1]);
    return Number.isFinite(ms) ? ms : undefined;
}

function mcpLineInstant(line: string, file: string, prefix: string): number | undefined {
    const hhmm = /^(\d{2}):(\d{2}):(\d{2})\.(\d{3})/.exec(line);
    if (hhmm === null) {
        return undefined;
    }
    const dayMatch = new RegExp(`^${escapeRegex(prefix)}(\\d{8})\\.`).exec(file);
    if (dayMatch === null) {
        return undefined;
    }
    const day = dayMatch[1];
    return Date.UTC(
        Number.parseInt(day.slice(0, 4), 10),
        Number.parseInt(day.slice(4, 6), 10) - 1,
        Number.parseInt(day.slice(6, 8), 10),
        Number.parseInt(hhmm[1], 10),
        Number.parseInt(hhmm[2], 10),
        Number.parseInt(hhmm[3], 10),
        Number.parseInt(hhmm[4], 10),
    );
}
