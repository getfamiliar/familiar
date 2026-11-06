import { createOpenAI } from "@ai-sdk/openai";
import {
    Experimental_AbstractRealtimeSession,
    type Experimental_RealtimeServerEvent,
    type Experimental_RealtimeState,
} from "ai";
import { CALL_SOCKET_PATH } from "@/host/VoiceProtocol";

/** Options of a {@link VoiceSession}. */
export interface VoiceSessionOptions {
    /** Absolute `ws(s)://` URL of the plugin's call socket. */
    readonly socketUrl: string;
    /** Every state change (status, capture, playback, session). */
    readonly onState: (state: Experimental_RealtimeState) => void;
    /** Every server event, including the host's `familiar.*` frames (as `custom`). */
    readonly onEvent: (event: Experimental_RealtimeServerEvent) => void;
    /** Errors (connection lost, socket closed by the host with a reason, microphone denied). */
    readonly onError: (error: Error) => void;
}

/**
 * The AI SDK's realtime session (microphone capture, playback, OpenAI
 * Live codec) in relay mode: it talks the OpenAI Live wire format to the
 * Familiar host's call socket, never to OpenAI directly. The codec
 * needs no API key here — the host starts the session with its own key
 * and settings and ignores the page's `session.start` settings.
 */
export class VoiceSession extends Experimental_AbstractRealtimeSession {
    private readonly onState: (state: Experimental_RealtimeState) => void;

    /**
     * @param options Socket URL and callbacks.
     */
    constructor(options: VoiceSessionOptions) {
        super({
            // Codec only: the host decides model, voice and instructions.
            model: createOpenAI({ apiKey: "relayed-by-familiar" }).experimental_realtime(
                "gpt-live-1",
                { api: "live" },
            ),
            api: { websocket: options.socketUrl },
            onEvent: options.onEvent,
            onError: options.onError,
        });
        this.onState = options.onState;
    }

    /**
     * Publish the state (the base class has already stored it).
     */
    protected setState(): void {
        this.onState(this.state);
    }
}

/**
 * Build the call socket URL for the page's route prefix.
 *
 * @param basePath Plugin route prefix (`/plugins/gpt-voice`).
 * @returns `wss://host/plugins/gpt-voice/socket` (`ws:` on plain HTTP).
 */
export function callSocketUrl(basePath: string): string {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}${basePath}${CALL_SOCKET_PATH}`;
}
