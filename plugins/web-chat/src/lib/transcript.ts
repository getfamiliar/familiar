import type { ChatMessageDto, ChatTurnDto } from "@/host/ChatProtocol";

/** One row of the transcript. */
export type TranscriptItem =
    | { readonly kind: "message"; readonly message: ChatMessageDto }
    | { readonly kind: "turn"; readonly turn: ChatTurnDto };

/**
 * Order messages and turn traces: a turn's trace follows the user message
 * of its event (between question and answer); turns whose user message
 * is not loaded (yet) come last.
 *
 * @param messages Visible messages, oldest first.
 * @param turns Turns by event id.
 * @returns The transcript rows.
 */
export function buildTranscript(
    messages: readonly ChatMessageDto[],
    turns: ReadonlyMap<string, ChatTurnDto>,
): TranscriptItem[] {
    const items: TranscriptItem[] = [];
    const placed = new Set<string>();
    for (const message of messages) {
        items.push({ kind: "message", message });
        const turn = turns.get(message.eventId);
        if (message.role === "user" && turn !== undefined && !placed.has(turn.eventId)) {
            items.push({ kind: "turn", turn });
            placed.add(turn.eventId);
        }
    }
    for (const turn of turns.values()) {
        if (!placed.has(turn.eventId) && turn.state === "running") {
            items.push({ kind: "turn", turn });
        }
    }
    return items;
}
