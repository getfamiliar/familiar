import { runJsonTool, type ScheduledHandlerBus, type ToolRunContext } from "@getfamiliar/shared";
import { jsonSchema, type Tool, tool } from "ai";

interface UnscheduleHandlerInput {
    readonly key: string;
}

/**
 * Build the `unschedule_handler` tool — remove a previously scheduled
 * one-off wake-up by its `key`. Returns `{ removed: false }` when the
 * key was not (or no longer) scheduled, so the agent can idempotently
 * clean up. Unexpected errors throw and surface as a `tool-error` block.
 */
export function buildUnscheduleHandlerTool(
    bus: ScheduledHandlerBus,
    ctx: ToolRunContext,
): Tool<UnscheduleHandlerInput, object> {
    return tool<UnscheduleHandlerInput, object>({
        description:
            "Cancel a previously scheduled handler by its `key`. Returns `removed: false` when " +
            "no schedule exists for that key (already fired or never scheduled).",
        inputSchema: jsonSchema<UnscheduleHandlerInput>({
            type: "object",
            additionalProperties: false,
            required: ["key"],
            properties: {
                key: {
                    type: "string",
                    description: "The `key` used when scheduling the handler.",
                },
            },
        }),
        execute: ({ key }) =>
            runJsonTool(async () => {
                const removed = await bus.deleteByKey(key);
                return { removed };
            }, ctx),
    });
}
