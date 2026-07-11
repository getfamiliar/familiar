import {
    dayBoundsInZone,
    parseInZone,
    renderInZone,
    runJsonLinesTool,
    type ScheduledSubagentBus,
    ToolError,
    type ToolRunContext,
} from "@getfamiliar/shared";
import { jsonSchema, type Tool, tool } from "ai";

interface GetScheduledSubagentsInput {
    readonly from?: string;
    readonly to?: string;
    readonly day?: string;
}

/**
 * Build the `get_scheduled_subagents` tool — list scheduled wake-ups in
 * a time range, rendered in the user's `core.timezone`. Returns one
 * row per line as JSONL.
 *
 * Accepts either a `from` / `to` pair (each parsed like
 * `schedule_subagent`'s `when`) or a `day` (date-only, `YYYY-MM-DD`,
 * resolved to the local-day bounds in `timezone`). When neither is
 * supplied, defaults to "from now, for the next 7 days".
 */
export function buildGetScheduledSubagentsTool(
    bus: ScheduledSubagentBus,
    timezone: string,
    ctx: ToolRunContext,
): Tool<GetScheduledSubagentsInput, string> {
    return tool<GetScheduledSubagentsInput, string>({
        description:
            "List scheduled one-off subagents. Pass either {day: 'YYYY-MM-DD'} for one local " +
            "calendar day, or {from?, to?} for a range (each a wall-clock ISO in the user's " +
            "local timezone). With no arguments, returns the next 7 days from now. Output " +
            "times are rendered in the user's local timezone, one schedule per JSONL line.",
        inputSchema: jsonSchema<GetScheduledSubagentsInput>({
            type: "object",
            additionalProperties: false,
            properties: {
                from: {
                    type: "string",
                    description:
                        "Range start (inclusive). ISO-8601 wall-clock in local timezone, e.g. " +
                        "`2026-05-22T00:00:00`. Ignored when `day` is set.",
                },
                to: {
                    type: "string",
                    description:
                        "Range end (exclusive). ISO-8601 wall-clock in local timezone. " +
                        "Ignored when `day` is set.",
                },
                day: {
                    type: "string",
                    description:
                        "Date-only `YYYY-MM-DD`. Returns every schedule whose `when` falls " +
                        "in that local calendar day. Mutually exclusive with `from`/`to`.",
                },
            },
        }),
        execute: ({ from, to, day }) =>
            runJsonLinesTool(async () => {
                const range = resolveRange({ from, to, day, timezone });
                const rows = await bus.listInRange(range.fromUtc, range.toUtc);
                return rows.map((row) => ({
                    key: row.key,
                    when: renderInZone(row.fireAt, timezone),
                    topic: row.topic,
                    handler: row.handler,
                    prompt: row.prompt,
                    payload: row.payload,
                }));
            }, ctx),
    });
}

/**
 * Resolve the UTC `[from, to)` range from the agent's input. `day`
 * wins over `from`/`to`. When all three are absent the default is
 * `[now, now+7d)`.
 *
 * @throws {ToolError} On any malformed input. Caller invokes inside the
 *   runner so the throw becomes the tool's failure.
 */
function resolveRange(args: { from?: string; to?: string; day?: string; timezone: string }): {
    readonly fromUtc: string;
    readonly toUtc: string;
} {
    if (args.day !== undefined && args.day.length > 0) {
        const bounds = dayBoundsInZone(args.day, args.timezone);
        if (!bounds.ok) {
            throw new ToolError("BadDay", bounds.error);
        }
        return { fromUtc: bounds.fromUtc, toUtc: bounds.toUtc };
    }

    const now = new Date();
    const fromUtcDefault = now.toISOString();
    const toUtcDefault = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

    let fromUtc = fromUtcDefault;
    let toUtc = toUtcDefault;

    if (args.from !== undefined && args.from.length > 0) {
        const parsed = parseInZone(args.from, args.timezone);
        if (!parsed.ok) {
            throw new ToolError("BadFrom", `from: ${parsed.error}`);
        }
        fromUtc = parsed.utcIso;
    }
    if (args.to !== undefined && args.to.length > 0) {
        const parsed = parseInZone(args.to, args.timezone);
        if (!parsed.ok) {
            throw new ToolError("BadTo", `to: ${parsed.error}`);
        }
        toUtc = parsed.utcIso;
    }

    if (Date.parse(toUtc) <= Date.parse(fromUtc)) {
        throw new ToolError("BadRange", "`to` must be strictly after `from`");
    }
    return { fromUtc, toUtc };
}
