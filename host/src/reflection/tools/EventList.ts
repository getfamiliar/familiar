import { EventBus, type EventState, type PluginTool, runTextTool } from "@getfamiliar/shared";
import type { ReflectionToolsDeps } from "../ReflectionTools.js";

interface EventListArgs {
    readonly maxCount?: number;
    readonly search?: string;
    readonly state?: EventState;
    readonly dateFrom?: string;
    readonly dateTo?: string;
}

const VALID_STATES: ReadonlySet<EventState> = new Set(["pending", "running", "done", "failed"]);

const PROMPT_PREVIEW_CHARS = 128;

/**
 * Build the `event_list` reflection tool — markdown table of recent
 * events, agent-facing equivalent of `./cli.sh events list`.
 */
export function buildEventListTool(deps: ReflectionToolsDeps): PluginTool<EventListArgs, string> {
    return {
        name: "event_list",
        description:
            "List recent events on the bus as a markdown table (ID, Topic, Handler, State, " +
            "Prompt). Newest first. Optional filters: `search` (case-insensitive substring " +
            "across topic, handler, prompt, payload), `state` " +
            "(pending|running|done|failed), `dateFrom` / `dateTo` (ISO timestamps, " +
            "inclusive/exclusive). Default `maxCount` is 10.",
        groups: ["reflection"],
        inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
                maxCount: {
                    type: "integer",
                    minimum: 1,
                    description: "Maximum rows to return. Defaults to 10.",
                },
                search: {
                    type: "string",
                    description:
                        "Case-insensitive substring matched against topic, handler, prompt, " +
                        "and payload (serialized as text).",
                },
                state: {
                    type: "string",
                    enum: ["pending", "running", "done", "failed"],
                },
                dateFrom: {
                    type: "string",
                    description:
                        "ISO timestamp. Only events with `created_at >= dateFrom` are returned.",
                },
                dateTo: {
                    type: "string",
                    description:
                        "ISO timestamp. Only events with `created_at < dateTo` are returned.",
                },
            },
        },
        execute: (args, callCtx) =>
            runTextTool(async () => {
                const limit = parseLimit(args.maxCount);
                const state = parseState(args.state);
                const dateFrom = parseDate(args.dateFrom, "dateFrom");
                const dateTo = parseDate(args.dateTo, "dateTo");

                const connection = await deps.ensureConnection();
                const bus = new EventBus(connection);
                const rows = await bus.listFiltered({
                    limit,
                    search: args.search,
                    state,
                    dateFrom,
                    dateTo,
                });

                if (rows.length === 0) {
                    return "No events match the given filters.\n";
                }

                const lines: string[] = [];
                lines.push("| ID | Topic | Handler | State | Prompt |");
                lines.push("| --- | --- | --- | --- | --- |");
                for (const row of rows) {
                    lines.push(
                        `| ${row.id} | \`${row.topic}\` | ${row.startHandler ?? "index"} | ` +
                            `${row.state} | ${escapeCell(renderPromptPreview(row.prompt))} |`,
                    );
                }
                return `${lines.join("\n")}\n`;
            }, callCtx.toolRunContext),
    };
}

function parseLimit(raw: unknown): number {
    if (raw === undefined || raw === null) {
        return 10;
    }
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
        throw new Error(`maxCount must be a positive integer, got ${JSON.stringify(raw)}`);
    }
    return raw;
}

function parseState(raw: unknown): EventState | undefined {
    if (raw === undefined || raw === null) {
        return undefined;
    }
    if (typeof raw !== "string" || !VALID_STATES.has(raw as EventState)) {
        throw new Error(
            `state must be one of ${[...VALID_STATES].join("|")}, got ${JSON.stringify(raw)}`,
        );
    }
    return raw as EventState;
}

function parseDate(raw: unknown, field: string): Date | undefined {
    if (raw === undefined || raw === null || raw === "") {
        return undefined;
    }
    if (typeof raw !== "string") {
        throw new Error(`${field} must be an ISO-8601 string, got ${JSON.stringify(raw)}`);
    }
    const millis = Date.parse(raw);
    if (!Number.isFinite(millis)) {
        throw new Error(`${field} could not be parsed as an ISO-8601 timestamp: ${raw}`);
    }
    return new Date(millis);
}

/** Collapse whitespace and truncate to a fixed cell width for the table. */
function renderPromptPreview(prompt: string): string {
    const flat = prompt.replace(/\s+/g, " ").trim();
    if (flat.length <= PROMPT_PREVIEW_CHARS) {
        return flat;
    }
    return `${flat.slice(0, PROMPT_PREVIEW_CHARS)}…`;
}

/** Escape pipes and backticks so the prompt cell can't break the table. */
function escapeCell(text: string): string {
    return text.replace(/\|/g, "\\|");
}
