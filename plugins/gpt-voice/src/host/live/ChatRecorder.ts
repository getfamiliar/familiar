import type { HostContext, Logger } from "@getfamiliar/shared";
import { VOICE_CALL_TOPIC } from "../VoiceProtocol.js";

/** Dependencies of a {@link ChatRecorder}. */
export interface ChatRecorderDeps {
    readonly events: Pick<HostContext["events"], "emit">;
    readonly chat: Pick<HostContext["chat"], "appendMessage">;
    readonly log: Logger;
}

/** What the record event says about itself. */
export interface ChatRecordSpec {
    /** Chat channel the messages belong to. */
    readonly channelId: string;
    /** Prompt of the record event (shown in `familiar events list`). */
    readonly prompt: string;
    /** Payload of the record event. */
    readonly payload: Record<string, unknown>;
}

/**
 * Writes chat messages that did not come from an agent run — a call's
 * transcript, a result that arrived after hang-up — into the chat
 * history.
 *
 * Chat messages hang off an event, so the recorder emits one
 * record-only `voice:call` event (state `done`: no handler ever runs for
 * it) on first use and appends every message to it, in order. Writing
 * is best-effort: a failure is logged and does not affect the call.
 */
export class ChatRecorder {
    private readonly deps: ChatRecorderDeps;
    private readonly spec: ChatRecordSpec;
    /** Serializes event creation and appends. */
    private queue: Promise<void> = Promise.resolve();
    private eventId: string | null = null;

    /**
     * @param deps Event bus, chat, logger.
     * @param spec Channel, prompt and payload of the record event.
     */
    constructor(deps: ChatRecorderDeps, spec: ChatRecordSpec) {
        this.deps = deps;
        this.spec = spec;
    }

    /**
     * Queue one message.
     *
     * @param role Who said it.
     * @param text The text.
     */
    record(role: "user" | "assistant", text: string): void {
        this.queue = this.queue.then(async () => {
            try {
                const eventId = await this.ensureEvent();
                await this.deps.chat.appendMessage(eventId, role, text);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                this.deps.log.error(
                    `gpt-voice: could not record a ${role} message on chat channel ${this.spec.channelId}: ${message}`,
                );
            }
        });
    }

    /**
     * Wait until every queued message is written (or failed).
     *
     * @returns Resolves when the queue is empty.
     */
    drain(): Promise<void> {
        return this.queue;
    }

    /**
     * Create the record event on first use.
     *
     * @returns Its id.
     */
    private async ensureEvent(): Promise<string> {
        if (this.eventId !== null) {
            return this.eventId;
        }
        const handle = await this.deps.events.emit({
            topic: VOICE_CALL_TOPIC,
            isExactTopic: true,
            state: "done",
            prompt: this.spec.prompt,
            payload: this.spec.payload,
            preferredChatChannelId: this.spec.channelId,
        });
        this.eventId = handle.id;
        return handle.id;
    }
}
