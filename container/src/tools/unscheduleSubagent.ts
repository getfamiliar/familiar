import { runJsonTool, type ScheduledSubagentBus, type ToolRunContext } from "@getfamiliar/shared";
import { jsonSchema, type Tool, tool } from "ai";

interface UnscheduleSubagentInput {
    readonly key: string;
}

/**
 * Build the `unschedule_subagent` tool — remove a previously scheduled
 * one-off wake-up by its `key`. Returns `{ removed: false }` when the
 * key was not (or no longer) scheduled, so the agent can idempotently
 * clean up. Unexpected errors throw and surface as a `tool-error` block.
 */
export function buildUnscheduleSubagentTool(
    bus: ScheduledSubagentBus,
    ctx: ToolRunContext,
): Tool<UnscheduleSubagentInput, object> {
    return tool<UnscheduleSubagentInput, object>({
        description:
            "Cancel a previously scheduled subagent by its `key`. Returns `removed: false` when " +
            "no schedule exists for that key (already fired or never scheduled).",
        inputSchema: jsonSchema<UnscheduleSubagentInput>({
            type: "object",
            additionalProperties: false,
            required: ["key"],
            properties: {
                key: {
                    type: "string",
                    description: "The `key` used when scheduling the subagent.",
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
