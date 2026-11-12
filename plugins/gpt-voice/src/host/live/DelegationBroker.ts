import {
    EVENT_PRIORITY,
    type HostContext,
    type Logger,
    type StepResultRow,
} from "@getfamiliar/shared";
import { type HostFrame, VOICE_BACKGROUND_TOPIC, VOICE_CHAT_CHANNEL } from "../VoiceProtocol.js";
import { formatTranscript, type TranscriptTurn } from "./CallTranscript.js";
import { formatStepProgress } from "./StepProgress.js";

/**
 * Wait after `session.delegation.created` before reading the transcript:
 * the voice model delegates while the user's last words are still being
 * transcribed.
 */
export const DEFAULT_TRANSCRIPT_SETTLE_MS = 800;

/** Turns of conversation handed to a background task. */
export const BACKGROUND_TRANSCRIPT_TURNS = 16;

/**
 * Longest text per context append (spoken commentary or silent
 * thinking). OpenAI allows ~500 tokens per append; 1500 characters stays
 * well below that for German or English.
 */
export const MAX_APPEND_CHARS = 1500;

/**
 * Progress notes per delegation at most: each costs context window of
 * the voice session, and the tool budget of a run bounds its steps anyway.
 */
export const MAX_PROGRESS_APPENDS = 12;

/** Who placed the call. */
export type CallTransportKind = "web" | "phone";

/** Dependencies of a {@link DelegationBroker}. */
export interface DelegationBrokerDeps {
    readonly events: Pick<HostContext["events"], "emit">;
    readonly log: Logger;
    readonly callId: string;
    readonly transportKind: CallTransportKind;
    /** The latest turns of the call, including what is being said right now. */
    readonly recentTurns: (maxTurns: number) => readonly TranscriptTurn[];
    /** Deliver text for a delegation (spoken while the call lasts, else to the default chat). */
    readonly deliver: (delegationId: string, text: string) => void;
    /** Silent progress of a delegation (a finished step of its run) for the voice model. */
    readonly reportProgress: (delegationId: string, text: string) => void;
    /** Tell the client about background-task progress. */
    readonly notifyClient: (frame: HostFrame) => void;
    /** Route chat messages of the emitted event (`send_chat`) back to this call. */
    readonly onEventEmitted: (eventId: string, delegationId: string) => void;
    /** The event settled; drop its routing. */
    readonly onEventSettled: (eventId: string) => void;
    /** Override of {@link DEFAULT_TRANSCRIPT_SETTLE_MS} (tests). */
    readonly transcriptSettleMs?: number;
}

/**
 * Turns the voice model's delegations into background tasks of the
 * normal assistant.
 *
 * GPT-Live's `session.delegation.created` carries only an id, no task
 * text — the voice model expects the backend to work it out from the
 * conversation. So each delegation becomes a `voice:background` event
 * whose prompt is the recent transcript (data only; what to do with it
 * is policy in `workspace/voice/background.md`). Every finished step of
 * the run goes to the voice model as a silent progress note for the
 * delegation; the run's result is delivered back for the same
 * delegation id, which makes the voice model say it.
 */
export class DelegationBroker {
    private readonly deps: DelegationBrokerDeps;

    /**
     * @param deps Event bus, transcript access and delivery callbacks.
     */
    constructor(deps: DelegationBrokerDeps) {
        this.deps = deps;
    }

    /**
     * Start a background task for a delegation. Never throws: failures
     * are delivered as a short spoken notice.
     *
     * @param delegationId Id from `session.delegation.created`.
     * @returns Resolves once the event is emitted (not when it settles).
     */
    async onDelegationCreated(delegationId: string): Promise<void> {
        const deps = this.deps;
        await sleep(deps.transcriptSettleMs ?? DEFAULT_TRANSCRIPT_SETTLE_MS);
        const turns = deps.recentTurns(BACKGROUND_TRANSCRIPT_TURNS);
        let eventId: string;
        let settled: Promise<string>;
        const progress = { isSettled: false, sentCount: 0 };
        const onStep = (step: StepResultRow): void => {
            if (progress.isSettled) {
                return;
            }
            const note = formatStepProgress(step, MAX_APPEND_CHARS);
            if (note === null) {
                return;
            }
            if (progress.sentCount >= MAX_PROGRESS_APPENDS) {
                if (progress.sentCount === MAX_PROGRESS_APPENDS) {
                    deps.log.info(
                        `gpt-voice: call ${deps.callId} delegation ${delegationId} reached ${MAX_PROGRESS_APPENDS} progress notes — sending no more`,
                    );
                    progress.sentCount++;
                }
                return;
            }
            progress.sentCount++;
            deps.reportProgress(delegationId, note);
        };
        try {
            const handle = await deps.events.emit(
                {
                    topic: VOICE_BACKGROUND_TOPIC,
                    isExactTopic: true,
                    prompt: buildBackgroundPrompt(turns),
                    payload: {
                        callId: deps.callId,
                        delegationId,
                        transport: deps.transportKind,
                    },
                    priority: EVENT_PRIORITY.CHAT,
                    preferredChatChannelId: VOICE_CHAT_CHANNEL,
                    privileged: true,
                    idempotencyKey: `gpt-voice:${deps.callId}:${delegationId}`,
                },
                { onStep },
            );
            eventId = handle.id;
            settled = handle.settled;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            deps.log.error(
                `gpt-voice: call ${deps.callId} could not start a background task for delegation ${delegationId}: ${message}`,
            );
            deps.notifyClient({
                type: "familiar.delegation.finished",
                delegation_id: delegationId,
                is_failed: true,
            });
            deps.deliver(delegationId, "The background task could not be started.");
            return;
        }
        deps.log.info(
            `gpt-voice: call ${deps.callId} delegation ${delegationId} → event ${eventId} (${VOICE_BACKGROUND_TOPIC})`,
        );
        deps.onEventEmitted(eventId, delegationId);
        deps.notifyClient({
            type: "familiar.delegation.started",
            delegation_id: delegationId,
            event_id: eventId,
        });
        void settled.then(
            (resultText) => {
                progress.isSettled = true;
                deps.onEventSettled(eventId);
                deps.notifyClient({
                    type: "familiar.delegation.finished",
                    delegation_id: delegationId,
                    is_failed: false,
                });
                if (resultText.trim() !== "") {
                    deps.deliver(delegationId, resultText);
                }
            },
            (err: unknown) => {
                progress.isSettled = true;
                deps.onEventSettled(eventId);
                const message = err instanceof Error ? err.message : String(err);
                deps.log.warn(
                    `gpt-voice: call ${deps.callId} background event ${eventId} failed: ${message}`,
                );
                deps.notifyClient({
                    type: "familiar.delegation.finished",
                    delegation_id: delegationId,
                    is_failed: true,
                });
                deps.deliver(delegationId, `The background task failed: ${message}`);
            },
        );
    }
}

/**
 * Build the prompt of a `voice:background` event: the recent
 * conversation. Data only — the instructions are the handler's; call id
 * and transport are in the event payload.
 *
 * @param turns Recent turns, oldest first.
 * @returns The prompt.
 */
export function buildBackgroundPrompt(turns: readonly TranscriptTurn[]): string {
    const conversation = turns.length === 0 ? "(no transcript yet)" : formatTranscript(turns);
    return `The voice assistant delegated a task to you. Conversation so far, latest last:\n\n${conversation}`;
}

/**
 * Split text into chunks of at most `maxChars`, at paragraph, then
 * sentence, then word boundaries.
 *
 * @param text The text.
 * @param maxChars Chunk limit.
 * @returns Non-empty chunks in order.
 */
export function splitIntoAppends(text: string, maxChars = MAX_APPEND_CHARS): string[] {
    const chunks: string[] = [];
    let current = "";
    const pieces = text
        .trim()
        .split(/\n\s*\n|(?<=[.!?])\s+/)
        .flatMap((piece) => splitLongPiece(piece.trim(), maxChars))
        .filter((piece) => piece !== "");
    for (const piece of pieces) {
        const candidate = current === "" ? piece : `${current} ${piece}`;
        if (candidate.length <= maxChars) {
            current = candidate;
            continue;
        }
        chunks.push(current);
        current = piece;
    }
    if (current !== "") {
        chunks.push(current);
    }
    return chunks;
}

/**
 * Split a piece longer than `maxChars` at word boundaries (hard-cutting
 * single overlong words).
 *
 * @param piece Paragraph or sentence.
 * @param maxChars Limit.
 * @returns Pieces of at most `maxChars`.
 */
function splitLongPiece(piece: string, maxChars: number): string[] {
    if (piece.length <= maxChars) {
        return [piece];
    }
    const parts: string[] = [];
    let current = "";
    for (const word of piece.split(/\s+/)) {
        for (let offset = 0; offset < word.length; offset += maxChars) {
            const slice = word.slice(offset, offset + maxChars);
            const candidate = current === "" ? slice : `${current} ${slice}`;
            if (candidate.length <= maxChars) {
                current = candidate;
            } else {
                parts.push(current);
                current = slice;
            }
        }
    }
    if (current !== "") {
        parts.push(current);
    }
    return parts;
}

/**
 * Wait.
 *
 * @param ms Milliseconds.
 * @returns Resolves after `ms`.
 */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
