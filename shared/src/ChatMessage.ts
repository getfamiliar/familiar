/**
 * Persistent chat history. Each row in the `chatmessages` table is one
 * turn in a conversation between the user and the assistant on some
 * channel (cli, telegram, …).
 *
 * The table intentionally has no `channel_id` column — channel is
 * reachable by JOINing to `events.preferred_chat_channel_id`. This
 * keeps the container side channel-blind: the agent's `send_chat` tool
 * only needs to know the originating event id, never the channel.
 */

/** Sender role for a chat message. */
export type ChatRole = "user" | "assistant";

/**
 * Shape of a row in the `chatmessages` table after JSON-decoding from
 * postgres. `id` and `eventId` are kept as strings because postgres
 * `bigint` exceeds JavaScript's safe integer range.
 */
export interface ChatMessage {
    /** Database primary key. */
    readonly id: string;
    /** FK to {@link import("./Event").EventRow.id} — the event whose lifecycle this message belongs to. */
    readonly eventId: string;
    /** `'user'` or `'assistant'`. */
    readonly role: ChatRole;
    /** The message text. */
    readonly textContent: string;
    /** Insert timestamp. */
    readonly createdAt: Date;
    /**
     * When ANY listener returned `true` from its async handler. `null`
     * while the message has not yet been delivered to any subscriber.
     * New subscribers replay all undelivered matching rows on
     * registration so a message produced when nobody was listening is
     * still delivered later.
     */
    readonly deliveredAt: Date | null;
}

/** Input shape for {@link import("./ChatMessageBus").ChatMessageBus.insertAssistantMessage}. */
export interface NewChatMessage {
    readonly eventId: string;
    readonly role: ChatRole;
    readonly textContent: string;
}

/** Filter for {@link import("./ChatMessageBus").ChatMessageBus.subscribe}. */
export interface ChatFilter {
    /**
     * Channel id (matched against the parent event's
     * `preferred_chat_channel_id`). Omit to match any channel.
     */
    readonly channelId?: string;
    /** Only deliver messages of this role. Omit to match any role. */
    readonly role?: ChatRole;
}
