import {
    type AgentRunRow,
    parseInZone,
    renderInZone,
    runJsonTool,
    type ScheduledHandlerBus,
    TOPIC_PATTERN,
    ToolError,
    type ToolRunContext,
} from "@getfamiliar/shared";
import { jsonSchema, type Tool, tool } from "ai";
import { HandlerFile } from "../HandlerFile.js";

interface ScheduleHandlerInput {
    readonly key: string;
    readonly when: string;
    readonly topic?: string;
    readonly handler: string;
    readonly prompt?: string;
    readonly payload?: Record<string, unknown>;
}

/** Whitelisted shape for scheduled-handler keys. Predictable enough for the
 * agent to reuse (e.g. `briefing_<eventId>`) without colliding with
 * other agents' keys, but strict enough to avoid surprises in logs. */
const KEY_PATTERN = /^[A-Za-z0-9_:.-]{1,128}$/;
const TOPIC_REGEXP = new RegExp(TOPIC_PATTERN);

/**
 * Build the `schedule_handler` tool — upsert a one-off future wake-up.
 *
 * The agent passes `when` as a wall-clock ISO-8601 string interpreted
 * in the user's `core.timezone`; naive inputs (no offset) are read as
 * local, explicit offsets are honored verbatim. The tool projects to
 * UTC and inserts via {@link ScheduledHandlerBus.upsert}, which
 * replaces any existing row with the same `key`.
 *
 * The new agentrun fires under a fresh event (no `parent_agentrun_id`,
 * new `event_id`) with the row's topic / handler / prompt / payload.
 * `priority` and `privileged` are inherited from the calling agentrun
 * — same trust-propagation rule as `queue_handler` / `call_handler`.
 *
 * Failure modes (bad key, malformed `when`, past `when`, unknown
 * handler, non-serializable payload) throw a {@link ToolError} so the
 * agent sees a `tool-error` block and can recover.
 */
export function buildScheduleHandlerTool(
    bus: ScheduledHandlerBus,
    parent: AgentRunRow,
    timezone: string,
    ctx: ToolRunContext,
): Tool<ScheduleHandlerInput, object> {
    return tool<ScheduleHandlerInput, object>({
        description:
            "Schedule a one-off future wake-up: at `when`, the named handler runs as a fresh " +
            "agentrun (new event, no parent). Re-using a `key` overwrites the previous schedule. " +
            "`when` is a wall-clock ISO-8601 string in the user's local timezone " +
            "(e.g. `2026-05-22T13:55:00`). Topic defaults to the current agentrun's topic. " +
            "Inherits priority and trust level from this run. Use `unschedule_handler` to cancel.",
        inputSchema: jsonSchema<ScheduleHandlerInput>({
            type: "object",
            additionalProperties: false,
            required: ["key", "when", "handler"],
            properties: {
                key: {
                    type: "string",
                    description:
                        "Unique id for this schedule. Re-using a key overwrites the previous " +
                        "schedule. Allowed characters: letters, digits, and `_:.-`, max 128.",
                },
                when: {
                    type: "string",
                    description:
                        "ISO-8601 wall-clock time in the user's local timezone, e.g. " +
                        "`2026-05-22T13:55:00`. Must be in the future. Strings with explicit " +
                        "offset (`…+02:00`, `…Z`) are honored verbatim.",
                },
                topic: {
                    type: "string",
                    description:
                        "Optional topic for the scheduled run. Defaults to the current " +
                        "agentrun's topic.",
                },
                handler: {
                    type: "string",
                    description:
                        "Handler basename without `.md`, resolved against `topic` (or the " +
                        "current topic when omitted).",
                },
                prompt: {
                    type: "string",
                    description:
                        "Optional short instruction for the scheduled run, surfaced as the " +
                        "trailing user message in its prompt.",
                },
                payload: {
                    type: "object",
                    additionalProperties: true,
                    description:
                        "Optional JSON object passed to the scheduled run as structured input.",
                },
            },
        }),
        execute: ({ key, when, topic, handler, prompt, payload }) =>
            runJsonTool(async () => {
                if (!KEY_PATTERN.test(key)) {
                    throw new ToolError(
                        "BadKey",
                        `key must match ${KEY_PATTERN.source} (letters, digits, _:.-, max 128 chars)`,
                    );
                }

                const resolvedTopic = topic ?? parent.topic;
                if (!TOPIC_REGEXP.test(resolvedTopic)) {
                    throw new ToolError(
                        "BadTopic",
                        `topic "${resolvedTopic}" must match ${TOPIC_PATTERN}`,
                    );
                }

                if (payload !== undefined) {
                    let serialized: string | undefined;
                    try {
                        serialized = JSON.stringify(payload);
                    } catch (err) {
                        throw new ToolError(
                            "InvalidPayload",
                            `payload must be JSON-serializable: ${err instanceof Error ? err.message : String(err)}`,
                        );
                    }
                    if (serialized === undefined) {
                        throw new ToolError(
                            "InvalidPayload",
                            "payload must be JSON-serializable (must not contain functions, symbols, or undefined at the root)",
                        );
                    }
                }

                try {
                    HandlerFile.load(resolvedTopic, handler);
                } catch (err) {
                    throw new ToolError(
                        "HandlerNotFound",
                        err instanceof Error ? err.message : String(err),
                    );
                }

                const parsed = parseInZone(when, timezone);
                if (!parsed.ok) {
                    throw new ToolError("BadWhen", parsed.error);
                }
                if (Date.parse(parsed.utcIso) <= Date.now()) {
                    throw new ToolError("PastWhen", `\`when\` (${when}) must be in the future`);
                }

                const row = await bus.upsert({
                    key,
                    fireAt: parsed.utcIso,
                    topic: resolvedTopic,
                    handler,
                    prompt: prompt ?? null,
                    payload: payload ?? {},
                    priority: parent.priority,
                    privileged: parent.privileged,
                });
                return {
                    key: row.key,
                    when: renderInZone(row.fireAt, timezone),
                };
            }, ctx),
    });
}
