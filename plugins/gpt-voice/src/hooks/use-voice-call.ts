import type { Experimental_RealtimeServerEvent, Experimental_RealtimeState } from "ai";
import { useCallback, useEffect, useRef, useState } from "react";
import { CALL_CLOSE_CODES, type VoiceStatus } from "@/host/VoiceProtocol";
import { SpeechActivityDetector } from "@/lib/speech-activity";
import { callSocketUrl, VoiceSession } from "@/lib/voice-session";

/** Why the page cannot place a call at all. */
export type VoiceBlocker = "insecureContext" | "noApiKey" | "statusFailed";

/** Where the call is. */
export type CallPhase = "checking" | "blocked" | "idle" | "connecting" | "connected" | "ending";

/** Everything the call screen renders. */
export interface VoiceCallState {
    readonly phase: CallPhase;
    /** Reasons the page cannot call (phase `blocked`). */
    readonly blockers: readonly VoiceBlocker[];
    /** Last call error, phrased for the user; cleared by the next call. */
    readonly error: string | null;
    /** Whether the microphone is muted. */
    readonly isMuted: boolean;
    /** Whether the assistant is audibly speaking (not just streaming silence). */
    readonly isAssistantSpeaking: boolean;
    /** Background tasks of this call still running. */
    readonly runningTaskCount: number;
    /** Whether the host is still building the briefing for the voice model. */
    readonly isBriefingLoading: boolean;
    /** When the call connected (ms since epoch), else null. */
    readonly connectedAt: number | null;
}

/** What the hook returns. */
export interface VoiceCall extends VoiceCallState {
    startCall(): void;
    hangUp(): void;
    toggleMute(): void;
}

/** Initial state while the status is being checked. */
const INITIAL_STATE: VoiceCallState = {
    phase: "checking",
    blockers: [],
    error: null,
    isMuted: false,
    isAssistantSpeaking: false,
    runningTaskCount: 0,
    isBriefingLoading: false,
    connectedAt: null,
};

/**
 * Drive a voice call: check that calling is possible (secure context for
 * the microphone, OpenAI key on the host), then place, mute and end
 * calls through a {@link VoiceSession}.
 *
 * @param basePath Plugin route prefix (`/plugins/gpt-voice`).
 * @returns The call state and actions.
 */
export function useVoiceCall(basePath: string): VoiceCall {
    const [state, setState] = useState<VoiceCallState>(INITIAL_STATE);
    const sessionRef = useRef<VoiceSession | null>(null);
    const runningTasksRef = useRef(new Set<string>());
    const speechRef = useRef<SpeechActivityDetector | null>(null);
    if (speechRef.current === null) {
        speechRef.current = new SpeechActivityDetector((isSpeaking) =>
            setState((previous) => ({ ...previous, isAssistantSpeaking: isSpeaking })),
        );
    }
    useEffect(() => () => speechRef.current?.dispose(), []);

    const update = useCallback((patch: Partial<VoiceCallState>) => {
        setState((previous) => ({ ...previous, ...patch }));
    }, []);

    useEffect(() => {
        let isCancelled = false;
        void checkBlockers(basePath).then((blockers) => {
            if (!isCancelled) {
                update({ phase: blockers.length === 0 ? "idle" : "blocked", blockers });
            }
        });
        return () => {
            isCancelled = true;
            sessionRef.current?.dispose();
            sessionRef.current = null;
        };
    }, [basePath, update]);

    const onSessionState = useCallback((realtime: Experimental_RealtimeState) => {
        const phase = phaseOf(realtime);
        if (!realtime.isPlaying) {
            // Playback stopped (interrupted, ended): drop the scheduled audio.
            speechRef.current?.reset();
        }
        if (phase === "idle") {
            runningTasksRef.current.clear();
            // The call ended on its own (host hung up, connection lost):
            // release the session so the next call starts fresh.
            const ended = sessionRef.current;
            sessionRef.current = null;
            if (ended !== null) {
                queueMicrotask(() => ended.dispose());
            }
        }
        setState((previous) => ({
            ...previous,
            phase,
            isMuted: realtime.session?.isInputMuted ?? false,
            connectedAt:
                phase === "connected"
                    ? (previous.connectedAt ?? Date.now())
                    : phase === "idle"
                      ? null
                      : previous.connectedAt,
            runningTaskCount: runningTasksRef.current.size,
            isBriefingLoading: phase === "idle" ? false : previous.isBriefingLoading,
        }));
    }, []);

    const onSessionEvent = useCallback(
        (event: Experimental_RealtimeServerEvent) => {
            if (event.type === "audio-chunk" || event.type === "audio-delta") {
                speechRef.current?.addChunk(event.delta);
                return;
            }
            if (event.type !== "custom") {
                return;
            }
            if (event.rawType === "familiar.briefing.started") {
                update({ isBriefingLoading: true });
                return;
            }
            if (event.rawType === "familiar.briefing.finished") {
                update({ isBriefingLoading: false });
                return;
            }
            const raw = event.raw as { delegation_id?: unknown };
            if (typeof raw.delegation_id !== "string") {
                return;
            }
            if (event.rawType === "familiar.delegation.started") {
                runningTasksRef.current.add(raw.delegation_id);
            } else if (event.rawType === "familiar.delegation.finished") {
                runningTasksRef.current.delete(raw.delegation_id);
            } else {
                return;
            }
            update({ runningTaskCount: runningTasksRef.current.size });
        },
        [update],
    );

    const startCall = useCallback(() => {
        if (sessionRef.current !== null) {
            return;
        }
        update({ phase: "connecting", error: null });
        const session = new VoiceSession({
            socketUrl: callSocketUrl(basePath),
            onState: onSessionState,
            onEvent: onSessionEvent,
            onError: (error) => update({ error: describeCallError(error) }),
        });
        sessionRef.current = session;
        session.connect().catch((error: unknown) => {
            update({ error: describeCallError(error), phase: "idle" });
            session.dispose();
            if (sessionRef.current === session) {
                sessionRef.current = null;
            }
        });
    }, [basePath, onSessionEvent, onSessionState, update]);

    const hangUp = useCallback(() => {
        const session = sessionRef.current;
        if (session === null) {
            return;
        }
        sessionRef.current = null;
        update({ phase: "ending" });
        void session.close().finally(() => {
            session.dispose();
            runningTasksRef.current.clear();
            speechRef.current?.reset();
            update({
                phase: "idle",
                connectedAt: null,
                runningTaskCount: 0,
                isBriefingLoading: false,
                isAssistantSpeaking: false,
            });
        });
    }, [update]);

    const toggleMute = useCallback(() => {
        const session = sessionRef.current;
        if (session === null) {
            return;
        }
        void session
            .sendEvent({ type: state.isMuted ? "input-audio-unmute" : "input-audio-mute" })
            .catch((error: unknown) => update({ error: describeCallError(error) }));
    }, [state.isMuted, update]);

    return { ...state, startCall, hangUp, toggleMute };
}

/**
 * Map the SDK's session status onto the call phases.
 *
 * @param realtime SDK state.
 * @returns The phase.
 */
function phaseOf(realtime: Experimental_RealtimeState): CallPhase {
    switch (realtime.status) {
        case "connecting":
            return "connecting";
        case "connected":
            return "connected";
        case "closing":
            return "ending";
        default:
            return "idle";
    }
}

/**
 * Find what prevents calling: the microphone needs a secure context
 * (HTTPS, or localhost), and the host needs an OpenAI key.
 *
 * @param basePath Plugin route prefix.
 * @returns The blockers (empty when calling is possible).
 */
async function checkBlockers(basePath: string): Promise<VoiceBlocker[]> {
    const blockers: VoiceBlocker[] = [];
    if (!window.isSecureContext || navigator.mediaDevices === undefined) {
        blockers.push("insecureContext");
    }
    try {
        const response = await fetch(`${basePath}/api/status`, { credentials: "same-origin" });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const status = (await response.json()) as VoiceStatus;
        if (!status.hasOpenAiKey) {
            blockers.push("noApiKey");
        }
    } catch {
        blockers.push("statusFailed");
    }
    return blockers;
}

/**
 * Turn a session error into a sentence for the user. The host closes
 * the socket with an application code and a reason (see
 * {@link CALL_CLOSE_CODES}); the SDK reports it as
 * `Realtime WebSocket closed unexpectedly (code 4001: …)`.
 *
 * @param error The error.
 * @returns A user-facing message.
 */
function describeCallError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    const match = /code (\d+)(?:: (.*))?\)/.exec(message);
    if (match === null) {
        if (/Permission|NotAllowed/i.test(message)) {
            return "The browser did not allow access to the microphone.";
        }
        return message;
    }
    const code = Number(match[1]);
    const reason = match[2] ?? "";
    switch (code) {
        case CALL_CLOSE_CODES.noApiKey:
            return "No OpenAI API key is configured. Set it with `familiar config set inference.apiKeys.openai`.";
        case CALL_CLOSE_CODES.noLiveConfig:
            return `The voice settings are missing: ${reason}`;
        case CALL_CLOSE_CODES.upstreamFailed:
            return `The connection to OpenAI failed: ${reason}`;
        case CALL_CLOSE_CODES.protocolError:
            return `The call was interrupted: ${reason}`;
        case 1012:
            return "The voice plugin restarted. Please call again.";
        default:
            return reason === "" ? `The call ended unexpectedly (code ${code}).` : reason;
    }
}
