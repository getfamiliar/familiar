import type { ScheduledHandlerBus } from "@getfamiliar/shared";
import { jsonSchema, type Tool, tool } from "ai";

interface UnscheduleHandlerInput {
    readonly key: string;
}

type UnscheduleHandlerOutput =
    | { readonly ok: true; readonly removed: boolean }
    | { readonly ok: false; readonly error: string };

/**
 * Build the `unschedule_handler` tool — remove a previously scheduled
 * one-off wake-up by its `key`. Returns `{ ok: true, removed: false }`
 * when the key was not (or no longer) scheduled, so the agent can
 * idempotently clean up.
 */
export function buildUnscheduleHandlerTool(
    bus: ScheduledHandlerBus,
): Tool<UnscheduleHandlerInput, UnscheduleHandlerOutput> {
    return tool<UnscheduleHandlerInput, UnscheduleHandlerOutput>({
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
        execute: async ({ key }) => {
            try {
                const removed = await bus.deleteByKey(key);
                return { ok: true, removed };
            } catch (err) {
                return {
                    ok: false,
                    error: `failed to unschedule handler: ${err instanceof Error ? err.message : String(err)}`,
                };
            }
        },
    });
}
