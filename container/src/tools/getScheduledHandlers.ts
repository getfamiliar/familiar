import {
    dayBoundsInZone,
    parseInZone,
    renderInZone,
    type ScheduledHandlerBus,
    type ScheduledHandlerRow,
} from "@getfamiliar/shared";
import { jsonSchema, type Tool, tool } from "ai";

interface GetScheduledHandlersInput {
    readonly from?: string;
    readonly to?: string;
    readonly day?: string;
}

interface ScheduledHandlerView {
    readonly key: string;
    readonly when: string;
    readonly topic: string;
    readonly handler: string;
    readonly prompt: string | null;
    readonly payload: unknown;
}

type GetScheduledHandlersOutput =
    | { readonly ok: true; readonly scheduled: readonly ScheduledHandlerView[] }
    | { readonly ok: false; readonly error: string };

/**
 * Build the `get_scheduled_handlers` tool — list scheduled wake-ups in
 * a time range, rendered in the user's `core.timezone`.
 *
 * Accepts either a `from` / `to` pair (each parsed like
 * `schedule_handler`'s `when`) or a `day` (date-only, `YYYY-MM-DD`,
 * resolved to the local-day bounds in `timezone`). When neither is
 * supplied, defaults to "from now, for the next 7 days".
 */
export function buildGetScheduledHandlersTool(
    bus: ScheduledHandlerBus,
    timezone: string,
): Tool<GetScheduledHandlersInput, GetScheduledHandlersOutput> {
    return tool<GetScheduledHandlersInput, GetScheduledHandlersOutput>({
        description:
            "List scheduled one-off handlers. Pass either {day: 'YYYY-MM-DD'} for one local " +
            "calendar day, or {from?, to?} for a range (each a wall-clock ISO in the user's " +
            "local timezone). With no arguments, returns the next 7 days from now. Output " +
            "times are rendered in the user's local timezone.",
        inputSchema: jsonSchema<GetScheduledHandlersInput>({
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
        execute: async ({ from, to, day }) => {
            const range = resolveRange({ from, to, day, timezone });
            if (!range.ok) {
                return { ok: false, error: range.error };
            }

            let rows: ScheduledHandlerRow[];
            try {
                rows = await bus.listInRange(range.fromUtc, range.toUtc);
            } catch (err) {
                return {
                    ok: false,
                    error: `failed to list scheduled handlers: ${err instanceof Error ? err.message : String(err)}`,
                };
            }

            const scheduled = rows.map<ScheduledHandlerView>((row) => ({
                key: row.key,
                when: renderInZone(row.fireAt, timezone),
                topic: row.topic,
                handler: row.handler,
                prompt: row.prompt,
                payload: row.payload,
            }));
            return { ok: true, scheduled };
        },
    });
}

/**
 * Resolve the UTC `[from, to)` range from the agent's input. `day`
 * wins over `from`/`to`. When all three are absent the default is
 * `[now, now+7d)`.
 */
function resolveRange(args: {
    from?: string;
    to?: string;
    day?: string;
    timezone: string;
}):
    | { readonly ok: true; readonly fromUtc: string; readonly toUtc: string }
    | { readonly ok: false; readonly error: string } {
    if (args.day !== undefined && args.day.length > 0) {
        const bounds = dayBoundsInZone(args.day, args.timezone);
        if (!bounds.ok) {
            return { ok: false, error: bounds.error };
        }
        return { ok: true, fromUtc: bounds.fromUtc, toUtc: bounds.toUtc };
    }

    const now = new Date();
    const fromUtcDefault = now.toISOString();
    const toUtcDefault = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

    let fromUtc = fromUtcDefault;
    let toUtc = toUtcDefault;

    if (args.from !== undefined && args.from.length > 0) {
        const parsed = parseInZone(args.from, args.timezone);
        if (!parsed.ok) {
            return { ok: false, error: `from: ${parsed.error}` };
        }
        fromUtc = parsed.utcIso;
    }
    if (args.to !== undefined && args.to.length > 0) {
        const parsed = parseInZone(args.to, args.timezone);
        if (!parsed.ok) {
            return { ok: false, error: `to: ${parsed.error}` };
        }
        toUtc = parsed.utcIso;
    }

    if (Date.parse(toUtc) <= Date.parse(fromUtc)) {
        return { ok: false, error: "`to` must be strictly after `from`" };
    }
    return { ok: true, fromUtc, toUtc };
}
