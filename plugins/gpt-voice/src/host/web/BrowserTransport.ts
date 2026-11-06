import type { Logger, WebSocketPeer } from "@getfamiliar/shared";
import { CallSetupError, type CallTransport, type LiveCall } from "../live/LiveCall.js";
import { parseFrame } from "../live/LiveUpstream.js";
import { CALL_CLOSE_CODES } from "../VoiceProtocol.js";

/** Close the browser socket when this much output is queued (a stalled client). */
export const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

/**
 * The web page as a {@link CallTransport}: the page runs the AI SDK's
 * Live session in relay mode over the plugin socket, so both directions
 * carry the OpenAI Live wire format.
 *
 * Protocol: the page's first frame is its `session.start`. Its settings
 * are ignored — the host starts the session with its own (instructions,
 * voice, client delegation, the transport's audio format) and only then
 * relays. Afterwards only audio and mute frames are relayed
 * ({@link LiveCall.relayClientFrame}); `session.close` hangs up. Every
 * server frame goes to the page unchanged, plus the host's
 * `familiar.*` frames.
 */
export class BrowserTransport implements CallTransport {
    readonly kind = "web";
    readonly audioFormat = { type: "audio/pcm", rate: 24000 } as const;
    private readonly peer: WebSocketPeer;
    private readonly log: Logger;
    private call: LiveCall | null = null;
    private isStarting = false;

    /**
     * @param peer The page's socket.
     * @param createCall Builds the call for this transport.
     * @param log Logger.
     */
    constructor(
        peer: WebSocketPeer,
        private readonly createCall: (transport: CallTransport) => LiveCall,
        log: Logger,
    ) {
        this.peer = peer;
        this.log = log;
        peer.onMessage((data) => this.onFrame(data));
        peer.onClose(() => {
            void this.call?.hangup();
        });
    }

    /** @inheritdoc */
    forward(frame: string): void {
        if (this.peer.bufferedAmount > MAX_BUFFERED_BYTES) {
            this.log.warn(
                `gpt-voice: call ${this.call?.id ?? "?"} — the browser does not keep up (${this.peer.bufferedAmount} bytes queued), hanging up`,
            );
            this.peer.close(CALL_CLOSE_CODES.protocolError, "client too slow");
            return;
        }
        this.peer.send(frame);
    }

    /** @inheritdoc */
    end(code: number, reason: string): void {
        this.peer.close(code, reason);
    }

    /**
     * Handle one frame from the page.
     *
     * @param data Frame payload.
     */
    private onFrame(data: string | Uint8Array): void {
        const frame = typeof data === "string" ? parseFrame(data) : null;
        if (frame === null) {
            this.peer.close(CALL_CLOSE_CODES.protocolError, "expected JSON text frames");
            return;
        }
        if (this.call === null) {
            if (this.isStarting) {
                return; // audio sent before the session started; nothing to relay to yet
            }
            if (frame.type !== "session.start") {
                this.peer.close(
                    CALL_CLOSE_CODES.protocolError,
                    "first frame must be session.start",
                );
                return;
            }
            this.isStarting = true;
            void this.startCall();
            return;
        }
        if (frame.type === "session.close") {
            void this.call.hangup();
            return;
        }
        this.call.relayClientFrame(frame);
    }

    /** Create and start the call; report setup failures to the page. */
    private async startCall(): Promise<void> {
        const call = this.createCall(this);
        try {
            await call.start();
            this.call = call;
        } catch (err) {
            const isSetupError = err instanceof CallSetupError;
            const message = err instanceof Error ? err.message : String(err);
            this.log.warn(`gpt-voice: call ${call.id} could not start: ${message}`);
            this.peer.close(
                isSetupError ? err.closeCode : CALL_CLOSE_CODES.upstreamFailed,
                truncateCloseReason(message),
            );
            await call.hangup();
        } finally {
            this.isStarting = false;
        }
        if (!this.peer.isOpen) {
            // The page left while the session was starting.
            await call.hangup();
        }
    }
}

/**
 * Fit a close reason into the 123 bytes a WebSocket close frame allows.
 *
 * @param reason Full reason.
 * @returns The reason, cut at a character boundary.
 */
export function truncateCloseReason(reason: string): string {
    let cut = reason;
    while (Buffer.byteLength(cut) > 123) {
        cut = cut.slice(0, -1);
    }
    return cut;
}
