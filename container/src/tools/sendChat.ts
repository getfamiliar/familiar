import type { Tool } from "ai";
import { jsonSchema, tool } from "ai";
import type { ChatManager } from "../chat/ChatManager";

/** Schema validated by the AI SDK before `execute` is called. */
interface SendChatInput {
    readonly text: string;
}

/**
 * Build the `send_chat` tool for one agentrun. The tool has a single
 * `text` argument; the agentrun's parent event id is closed over so
 * the LLM never sees it. Channel routing happens host-side via the
 * event's `preferred_chat_channel_id`, so the agent's mental model is
 * just "send a message to the user".
 *
 * Returns `{ ok: true }` on success — the SDK serializes it as the
 * tool result the model sees in the next step.
 */
export function buildSendChatTool(
    chat: ChatManager,
    eventId: string,
): Tool<SendChatInput, { ok: true }> {
    return tool<SendChatInput, { ok: true }>({
        description:
            "Send a chat message to the user. Use it to reply, ask follow-up questions, or proactively notify." +
            'Use like that: `send_chat({text: "Hi there!"})`.',

        inputSchema: jsonSchema<SendChatInput>({
            type: "object",
            additionalProperties: false,
            required: ["text"],
            properties: {
                text: {
                    type: "string",
                    description: "The message text to send to the user.",
                },
            },
        }),
        execute: async ({ text }) => {
            await chat.appendAssistantMessage(eventId, text ?? "...");
            return { ok: true };
        },
    });
}
