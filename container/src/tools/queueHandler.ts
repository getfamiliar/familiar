import {
    type AgentRunBus,
    type AgentRunRow,
    runJsonTool,
    ToolError,
    type ToolRunContext,
} from "@getfamiliar/shared";
import type { Tool } from "ai";
import { jsonSchema, tool } from "ai";
import { HandlerFile } from "../HandlerFile.js";

interface QueueHandlerInput {
    readonly topic?: string;
    readonly handler: string;
    readonly prompt?: string;
    readonly payload?: Record<string, unknown>;
}

/**
 * Build the `queue_handler` tool for one agentrun. Spawns a child
 * agentrun under the same root event in fire-and-forget mode — the
 * caller does **not** wait for the child's result; queue_handler
 * returns immediately with the child's id.
 *
 * If you need to react to the child's output, use `call_handler`
 * instead: it suspends the current run and resumes when the child
 * settles, returning the child's `resultText`.
 *
 * The new agentrun inherits the parent's `event_id` and `priority`
 * (and `privileged` flag) and is tagged `calltype='queued'`. The
 * handler basename, optional prompt, and optional payload come from
 * the model. Topic defaults to the parent's topic when omitted, so
 * common same-topic fan-outs stay one argument shorter.
 *
 * Bad inputs (unserialisable payload, missing handler file) throw a
 * {@link ToolError} — the AI SDK then emits a `tool-error` block so
 * the model can recover (pick a different handler, send a message,
 * etc.) instead of crashing.
 */
export function buildQueueHandlerTool(
    bus: AgentRunBus,
    parent: AgentRunRow,
    ctx: ToolRunContext,
): Tool<QueueHandlerInput, object> {
    return tool<QueueHandlerInput, object>({
        description:
            "Spawn a subagent and return immediately (fire-and-forget). The new agentrun runs " +
            "after the current one; you do NOT see its result. Use `call_handler` instead when " +
            "you need to react to the subagent's output. Topic defaults to the current agentrun's " +
            "topic; override with the `topic` argument to call cross-topic. Inherits the event " +
            "and trust level from this run.",
        inputSchema: jsonSchema<QueueHandlerInput>({
            type: "object",
            additionalProperties: false,
            required: ["handler"],
            properties: {
                topic: {
                    type: "string",
                    description:
                        "Optional topic for the queued subagent. Defaults to the current " +
                        "agentrun's topic. Use to spawn handlers under a different topic.",
                },
                handler: {
                    type: "string",
                    description:
                        "Handler basename without `.md`, e.g. `analyze` or `respond`. Resolved " +
                        "against `topic` (or the current topic when omitted).",
                },
                prompt: {
                    type: "string",
                    description:
                        "Optional short instruction for the queued run, surfaced as the trailing " +
                        "user message in its prompt.",
                },
                payload: {
                    type: "object",
                    additionalProperties: true,
                    description:
                        "Optional JSON object passed to the queued run as structured input.",
                },
            },
        }),
        execute: ({ topic, handler, prompt, payload }) =>
            runJsonTool(async () => {
                const resolvedTopic = topic ?? parent.topic;

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

                const row = await bus.add({
                    eventId: parent.eventId,
                    parentAgentrunId: parent.id,
                    topic: resolvedTopic,
                    handler,
                    priority: parent.priority,
                    prompt: prompt ?? null,
                    payload: payload ?? {},
                    privileged: parent.privileged,
                    calltype: "queued",
                });
                return { agentrunId: row.id };
            }, ctx),
    });
}
