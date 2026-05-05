import type { Tool } from "ai";
import { jsonSchema, tool } from "ai";
import type { AgentRunBus, AgentRunRow } from "effective-assistant-shared";
import { HandlerFile } from "../HandlerFile";

interface QueueRunInput {
    readonly handler: string;
    readonly prompt?: string;
    readonly payload?: Record<string, unknown>;
}

type QueueRunOutput =
    | { readonly ok: true; readonly agentrunId: string }
    | { readonly ok: false; readonly error: string };

/**
 * Build the `queue_run` tool for one agentrun. Lets the agent fan out
 * follow-up work by spawning a child agentrun under the same root event.
 *
 * The new agentrun inherits the parent's `event_id`, `topic`, and
 * `priority`; only the handler basename, optional prompt, and optional
 * payload come from the model. Topic stays implicit on purpose — handlers
 * branch by name within their topic, not across topics.
 *
 * Failure modes are reported as `{ ok: false, error }` rather than thrown:
 * the SDK's tool loop treats `execute` exceptions as agent-loop failures,
 * but a handler that asks for a missing sibling should be able to recover
 * (pick a different handler, send a message, etc.) instead of aborting.
 */
export function buildQueueRunTool(
    bus: AgentRunBus,
    parent: AgentRunRow,
): Tool<QueueRunInput, QueueRunOutput> {
    return tool<QueueRunInput, QueueRunOutput>({
        description:
            "Queue a follow-up agentrun on the same topic as the current one. " +
            "Use this to fan out work — e.g. after triaging in `index`, queue " +
            "`analyze` and `respond`. Returns immediately; the queued run executes " +
            "after the current one. The new run inherits this run's event and topic; " +
            "you only choose the handler basename plus optional `prompt` (a short " +
            "instruction) and `payload` (a JSON object of inputs).",
        inputSchema: jsonSchema<QueueRunInput>({
            type: "object",
            additionalProperties: false,
            required: ["handler"],
            properties: {
                handler: {
                    type: "string",
                    description:
                        "Handler basename without `.md`, e.g. `analyze` or `respond`. " +
                        "Resolved against the current topic.",
                },
                prompt: {
                    type: "string",
                    description:
                        "Optional short instruction for the queued run, surfaced as the " +
                        "trailing user message in its prompt.",
                },
                payload: {
                    type: "object",
                    additionalProperties: true,
                    description:
                        "Optional JSON object passed to the queued run as structured input.",
                },
            },
        }),
        execute: async ({ handler, prompt, payload }) => {
            if (payload !== undefined) {
                let serialized: string | undefined;
                try {
                    serialized = JSON.stringify(payload);
                } catch (err) {
                    return {
                        ok: false,
                        error: `payload must be JSON-serializable: ${err instanceof Error ? err.message : String(err)}`,
                    };
                }
                if (serialized === undefined) {
                    return {
                        ok: false,
                        error: "payload must be JSON-serializable (must not contain functions, symbols, or undefined at the root)",
                    };
                }
            }

            try {
                HandlerFile.load(parent.topic, handler);
            } catch (err) {
                return {
                    ok: false,
                    error: err instanceof Error ? err.message : String(err),
                };
            }

            const row = await bus.add({
                eventId: parent.eventId,
                parentAgentrunId: parent.id,
                topic: parent.topic,
                handler,
                priority: parent.priority,
                prompt: prompt ?? null,
                payload: payload ?? {},
            });
            return { ok: true, agentrunId: row.id };
        },
    });
}
