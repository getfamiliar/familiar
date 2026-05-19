import type { ChatMessageBus } from "@getfamiliar/shared";
import type { ModelMessage } from "ai";

/**
 * Per-agentrun facade over {@link ChatMessageBus} that the
 * {@link import("../agent-runner/AgentRunner").AgentRunner} uses to
 * thread chat history into the LLM and the `send_chat` tool uses to
 * append assistant replies.
 *
 * Channel-blind by design: every method takes the originating event's
 * id, not a channel name. The bus resolves channel by JOINing to
 * `events.preferred_chat_channel_id`. The container — and therefore
 * the agent — never names a channel; routing is purely a host concern.
 *
 * The class is a thin mapping layer; all SQL lives in the bus. It
 * exists so the message-shape conversion (DB row → `ModelMessage`) has
 * a single home and so tests can stub a small surface instead of the
 * full bus.
 */
export class ChatManager {
    private readonly bus: ChatMessageBus;

    constructor(bus: ChatMessageBus) {
        this.bus = bus;
    }

    /**
     * Return the conversation history on the channel the given event
     * belongs to, oldest first, in the shape the Vercel AI SDK accepts
     * as `messages`. Empty array when no chat history exists yet.
     */
    async fetchHistory(eventId: string): Promise<ModelMessage[]> {
        const rows = await this.bus.fetchHistoryForEvent(eventId);
        return rows.map((row) => ({
            role: row.role,
            content: row.textContent,
        }));
    }

    /**
     * Append one assistant reply, attributing it to the agentrun's
     * parent event. The host's chat subscribers (cli-chat, telegram, …)
     * will see it via NOTIFY and forward it to the user.
     */
    async appendAssistantMessage(eventId: string, text: string): Promise<void> {
        await this.bus.insertAssistantMessage(eventId, text);
    }
}
