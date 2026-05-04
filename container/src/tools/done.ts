import type { Tool } from "ai";
import { jsonSchema, tool } from "ai";

/** Schema validated by the AI SDK before the loop terminator fires. */
export interface DoneInput {
    readonly text: string;
}

/**
 * Build the `done` tool. It has **no `execute` function** on purpose:
 * the Vercel AI SDK's {@link import("ai").ToolLoopAgent} terminates
 * its tool loop the moment a tool without `execute` is invoked. So
 * `done` is a sentinel — when the model calls it, the agent's turn
 * ends.
 *
 * Combined with `toolChoice: "required"` on the agent, this makes
 * plain-text outputs structurally impossible: every step must call
 * a tool, and the only way to stop is `done`. The model cannot
 * "forget" to call `send_chat` and emit text directly.
 *
 * The `text` argument is the model's audit summary of what it did,
 * surfaced as `agentruns.result_text`.
 */
export function buildDoneTool(): Tool<DoneInput, never> {
    return tool<DoneInput, never>({
        description:
            "Signal that your turn is complete. The agent loop ends after " +
            "this call. The `text` argument is recorded as the agentrun's " +
            "audit summary — use it for a one-line description of what you " +
            "did. Call this exactly once at the end of every turn.",
        inputSchema: jsonSchema<DoneInput>({
            type: "object",
            additionalProperties: false,
            required: ["text"],
            properties: {
                text: {
                    type: "string",
                    description: "One-line summary of what was done.",
                },
            },
        }),
        // No `execute` — its absence is what terminates the loop.
    });
}
