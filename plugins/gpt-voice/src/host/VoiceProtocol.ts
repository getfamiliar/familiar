/**
 * Wire contract between the voice page and the host. Imported by the
 * browser page too, so this module must stay free of node imports.
 *
 * The call socket (`/plugins/gpt-voice/socket`) carries the OpenAI Live
 * wire format in both directions — the page runs the AI SDK's Live codec
 * in relay mode — plus a few host-originated `familiar.*` frames, which
 * the codec surfaces to the page as `custom` events.
 */

/** Plugin id, also the route segment of the controller and socket. */
export const GPT_VOICE_PLUGIN_ID = "gpt-voice";

/** Path of the call socket below the plugin mount. */
export const CALL_SOCKET_PATH = "/socket";

/** Topic of a background task delegated by the voice model. */
export const VOICE_BACKGROUND_TOPIC = "voice:background";

/** Topic of the briefing the voice model gets as silent context shortly after a call starts. */
export const VOICE_BRIEFING_TOPIC = "voice:briefing";

/** Topic of record-only events (call transcripts, results after hang-up); no handler runs. */
export const VOICE_CALL_TOPIC = "voice:call";

/** Chat channel of voice calls (transcripts, `send_chat` of background runs). */
export const VOICE_CHAT_CHANNEL = "voice";

/** Answer of `GET /api/status`. */
export interface VoiceStatus {
    /** Whether `inference.apiKeys.openai` is set. */
    readonly hasOpenAiKey: boolean;
    /** Whether the browser reached the server over HTTPS (directly or via a trusted proxy). */
    readonly isHttps: boolean;
}

/** Close codes of the call socket (application range 4000–4999). */
export const CALL_CLOSE_CODES = {
    /** `inference.apiKeys.openai` is not configured. */
    noApiKey: 4001,
    /** `workspace/voice/live.md` is missing or unreadable. */
    noLiveConfig: 4002,
    /** The connection to OpenAI failed or broke. */
    upstreamFailed: 4003,
    /** The page broke the protocol (bad frame, no `session.start`). */
    protocolError: 4004,
} as const;

/** Host → page frame: a background task started for a delegation. */
export interface DelegationStartedFrame {
    readonly type: "familiar.delegation.started";
    readonly delegation_id: string;
    /** Id of the `voice:background` event. */
    readonly event_id: string;
}

/** Host → page frame: a background task finished (its result is being spoken). */
export interface DelegationFinishedFrame {
    readonly type: "familiar.delegation.finished";
    readonly delegation_id: string;
    readonly is_failed: boolean;
}

/** Host → page frame: the briefing for this call is being built (or fetched from the cache). */
export interface BriefingStartedFrame {
    readonly type: "familiar.briefing.started";
}

/** Host → page frame: the briefing was handed to the voice model, or could not be built. */
export interface BriefingFinishedFrame {
    readonly type: "familiar.briefing.finished";
    readonly is_failed: boolean;
}

/** Every host-originated frame on the call socket. */
export type HostFrame =
    | DelegationStartedFrame
    | DelegationFinishedFrame
    | BriefingStartedFrame
    | BriefingFinishedFrame;
