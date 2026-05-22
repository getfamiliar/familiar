import { randomUUID } from "node:crypto";
import {
    type AgentRunBus,
    type AgentRunRow,
    parseInZone,
    renderInZone,
    runJsonTool,
    type ScheduledHandlerBus,
    ToolError,
    type ToolRunContext,
} from "@getfamiliar/shared";
import { jsonSchema, type Tool, tool } from "ai";
import { HandlerFile } from "../HandlerFile.js";
import { normalizeHandlerSpec } from "./HandlerSpec.js";

interface ScheduleHandlerInput {
    readonly handler: string;
    readonly topic?: string;
    readonly prompt?: string;
    readonly payload?: Record<string, unknown>;
    readonly when?: string;
    readonly key?: string;
}

/** Whitelisted shape for scheduled-handler keys. Predictable enough for the
 * agent to reuse (e.g. `briefing_<eventId>`) without colliding with
 * other agents' keys, but strict enough to avoid surprises in logs. */
const KEY_PATTERN = /^[A-Za-z0-9_:.-]{1,128}$/;

/**
 * Build the `schedule_handler` tool — the one verb for spawning a
 * detached handler invocation.
 *
 * Two dispatch modes, chosen by the presence of `when`:
 *
 * - **Immediate** (`when` omitted, or `when` parses to a past instant):
 *   inserts a child `agentruns` row under the calling agentrun via
 *   {@link AgentRunBus.add} with `calltype='queued'`. Fire-and-forget;
 *   no result returned to the caller, child stays under the current
 *   `event_id`. Returns `{ agentrunId }`.
 *
 * - **Scheduled** (`when` parses to a future instant): upserts a row
 *   into `scheduled_handlers` via {@link ScheduledHandlerBus.upsert}.
 *   When the host fires it at `when`, the new agentrun runs under a
 *   fresh event (no `parent_agentrun_id`, new `event_id`). Re-using
 *   `key` overwrites the previous schedule. Returns `{ key, when }`.
 *
 * `priority` and `privileged` are inherited from the calling agentrun
 * in both modes — same trust-propagation rule as `call_handler`.
 *
 * Failure modes (bad key, malformed `when`, unknown handler,
 * non-serializable payload) throw a {@link ToolError} so the agent
 * sees a `tool-error` block and can recover. A successfully-parsed
 * past `when` does *not* throw — it silently demotes to immediate.
 */
export function buildScheduleHandlerTool(
    agentruns: AgentRunBus,
    scheduled: ScheduledHandlerBus,
    parent: AgentRunRow,
    timezone: string,
    ctx: ToolRunContext,
): Tool<ScheduleHandlerInput, object> {
    return tool<ScheduleHandlerInput, object>({
        description:
            "Spawn a handler invocation. Omit `when` to run immediately as a child of this " +
            "agentrun under the same event (fire-and-forget — you do NOT see its result). Provide " +
            "a future `when` (ISO-8601 wall-clock in the user's local timezone, e.g. " +
            "`2026-05-22T13:55:00`) to defer it as a fresh event at that time; pass a stable `key` " +
            "to make rescheduling idempotent (reusing a key overwrites the previous schedule). A " +
            "`when` in the past is silently treated as immediate. Topic defaults to the current " +
            "agentrun's topic, but can also be embedded in `handler` with `/` as the separator " +
            '(e.g. `handler: "mail/whatsapp/send"` is the same as `topic: "mail:whatsapp", ' +
            'handler: "send"`); a trailing `.md` is silently stripped. Inherits priority and ' +
            "trust level from this run. Use `unschedule_handler` to cancel a scheduled wake-up.",
        inputSchema: jsonSchema<ScheduleHandlerInput>({
            type: "object",
            additionalProperties: false,
            required: ["handler"],
            properties: {
                handler: {
                    type: "string",
                    description:
                        "Handler basename without `.md`, resolved against `topic` (or the " +
                        "current topic when omitted).",
                },
                topic: {
                    type: "string",
                    description:
                        "Optional topic for the spawned run. Defaults to the current " +
                        "agentrun's topic.",
                },
                prompt: {
                    type: "string",
                    description:
                        "Optional short instruction for the spawned run, surfaced as the " +
                        "trailing user message in its prompt.",
                },
                payload: {
                    type: "object",
                    additionalProperties: true,
                    description:
                        "Optional JSON object passed to the spawned run as structured input.",
                },
                when: {
                    type: "string",
                    description:
                        "Optional ISO-8601 wall-clock time in the user's local timezone (e.g. " +
                        "`2026-05-22T13:55:00`). Omit to spawn immediately. A `when` in the past " +
                        "is silently treated as immediate. Strings with explicit offset " +
                        "(`…+02:00`, `…Z`) are honored verbatim.",
                },
                key: {
                    type: "string",
                    description:
                        "Optional unique id for the scheduled row (only meaningful with `when`). " +
                        "Re-using a key overwrites the previous schedule. Auto-generated when " +
                        "omitted. Allowed characters: letters, digits, and `_:.-`, max 128.",
                },
            },
        }),
        execute: ({ handler, topic, prompt, payload, when, key }) =>
            runJsonTool(async () => {
                const { topic: resolvedTopic, handler: resolvedHandler } = normalizeHandlerSpec(
                    topic,
                    handler,
                    parent.topic,
                );

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
                    HandlerFile.load(resolvedTopic, resolvedHandler);
                } catch (err) {
                    throw new ToolError(
                        "HandlerNotFound",
                        err instanceof Error ? err.message : String(err),
                    );
                }

                if (key !== undefined && when === undefined) {
                    throw new ToolError(
                        "BadKey",
                        "`key` is only meaningful when scheduling with `when`. Either pass " +
                            "`when` too, or drop `key`.",
                    );
                }
                if (key !== undefined && !KEY_PATTERN.test(key)) {
                    throw new ToolError(
                        "BadKey",
                        `key must match ${KEY_PATTERN.source} (letters, digits, _:.-, max 128 chars)`,
                    );
                }

                let fireAtUtc: string | undefined;
                if (when !== undefined) {
                    const parsed = parseInZone(when, timezone);
                    if (!parsed.ok) {
                        throw new ToolError("BadWhen", parsed.error);
                    }
                    if (Date.parse(parsed.utcIso) > Date.now()) {
                        fireAtUtc = parsed.utcIso;
                    }
                    // else: past `when` — fall through to immediate path.
                }

                if (fireAtUtc === undefined) {
                    const row = await agentruns.add({
                        eventId: parent.eventId,
                        parentAgentrunId: parent.id,
                        topic: resolvedTopic,
                        handler: resolvedHandler,
                        priority: parent.priority,
                        prompt: prompt ?? null,
                        payload: payload ?? {},
                        privileged: parent.privileged,
                        calltype: "queued",
                    });
                    return { agentrunId: row.id };
                }

                const row = await scheduled.upsert({
                    key: key ?? randomUUID(),
                    fireAt: fireAtUtc,
                    topic: resolvedTopic,
                    handler: resolvedHandler,
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
