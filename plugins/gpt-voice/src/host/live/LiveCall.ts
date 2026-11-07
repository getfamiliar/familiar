import { randomUUID } from "node:crypto";
import { createOpenAI, type Experimental_OpenAIRealtimeModelLive } from "@ai-sdk/openai";
import {
    type ChatMessage,
    formatBannerList,
    formatRuntimeTime,
    type HostContext,
    type Logger,
} from "@getfamiliar/shared";
import type { Experimental_RealtimeServerEvent } from "ai";
import { CALL_CLOSE_CODES, type HostFrame, VOICE_CHAT_CHANNEL } from "../VoiceProtocol.js";
import type { BriefingProvider } from "./BriefingProvider.js";
import { CallTranscript } from "./CallTranscript.js";
import { ChatRecorder } from "./ChatRecorder.js";
import { type CallTransportKind, DelegationBroker, splitIntoAppends } from "./DelegationBroker.js";
import {
    LIVE_PLACEHOLDERS,
    LiveConfigError,
    type LiveSettings,
    readLiveSettings,
} from "./LiveConfig.js";
import { LiveUpstream, type UpstreamConnector } from "./LiveUpstream.js";

/** Config key of the OpenAI API key (shared with the other OpenAI uses). */
export const OPENAI_API_KEY_CONFIG = "inference.apiKeys.openai";

/** Messages of earlier calls (channel `voice`) read for the session's `input` history. */
export const HISTORY_INPUT_MESSAGES = 40;

/**
 * Character budget of that history. OpenAI allows 8,192 tokens of
 * `input`; 12,000 characters stays below that with room to spare.
 */
export const HISTORY_INPUT_MAX_CHARS = 12_000;

/**
 * Re-send the briefing when the session's context window is this full:
 * above 90 % OpenAI hands over to a replacement voice engine, which is
 * only guaranteed to get the original instructions and a summary.
 */
export const BRIEFING_REPUSH_RATIO = 0.85;

/** Below this usage ratio the re-send is armed again (the replacement engine took over). */
export const BRIEFING_REARM_RATIO = 0.5;

/** One message of the session's `input` history (OpenAI Live wire shape). */
export type LiveInputMessage =
    | {
          readonly type: "message";
          readonly role: "developer" | "user";
          readonly content: [{ readonly type: "input_text"; readonly text: string }];
      }
    | {
          readonly type: "message";
          readonly role: "assistant";
          readonly content: [{ readonly type: "output_text"; readonly text: string }];
      };

/** Audio format of a call, fixed for the whole session. */
export type CallAudioFormat =
    | { readonly type: "audio/pcm"; readonly rate: 16000 | 24000 }
    | { readonly type: "audio/pcmu" | "audio/pcma"; readonly rate: 8000 };

/**
 * How a call reaches the user. The web transport relays the session's
 * audio and events to the browser; a phone transport (SIP, later) will
 * carry no media through the host at all and ignore {@link forward}.
 */
export interface CallTransport {
    readonly kind: CallTransportKind;
    readonly audioFormat: CallAudioFormat;
    /**
     * Relay a server frame to the client.
     *
     * @param frame Serialized JSON frame (OpenAI Live wire format or a host frame).
     */
    forward(frame: string): void;
    /**
     * The call ended (hang-up, upstream closed or failed). Called once.
     *
     * @param code Close code (1000 or one of {@link CALL_CLOSE_CODES}).
     * @param reason Short reason.
     */
    end(code: number, reason: string): void;
}

/** The host capabilities a call uses. */
export interface VoiceHost {
    readonly events: Pick<HostContext["events"], "emit">;
    readonly chat: Pick<HostContext["chat"], "appendMessage" | "listMessages">;
    readonly banners: HostContext["banners"];
    readonly config: HostContext["config"];
    readonly logger: Logger;
    /** The assistant's name for `{ASSISTANT_NAME}`, read per call. */
    readonly assistantName: string;
    /** IANA timezone for `{CURRENT_TIME}` and `{BANNER_LIST}`, read per call. */
    readonly timezone: string;
}

/** Creates the AI SDK Live codec for an API key and model. */
export type LiveModelFactory = (
    apiKey: string,
    modelId: string,
) => Experimental_OpenAIRealtimeModelLive;

/** The production codec factory (direct OpenAI, no gateway). */
export const openAiLiveModelFactory: LiveModelFactory = (apiKey, modelId) =>
    createOpenAI({ apiKey }).experimental_realtime(modelId, { api: "live" });

/** Dependencies of a {@link LiveCall}. */
export interface LiveCallDeps {
    readonly host: VoiceHost;
    readonly workspaceDir: string;
    readonly connector: UpstreamConnector;
    readonly modelFactory: LiveModelFactory;
    /** Builds or reuses the briefing sent to the voice model after the start. */
    readonly briefing: Pick<BriefingProvider, "get">;
    /** Clock (tests). */
    readonly now?: () => Date;
    /** Register routing of `send_chat` messages of a background event to this call. */
    readonly routeEvent: (eventId: string, call: LiveCall, delegationId: string) => void;
    /** Drop that routing. */
    readonly unrouteEvent: (eventId: string) => void;
    /** The call ended; forget it. */
    readonly onEnded: (call: LiveCall) => void;
    /** Override of the transcript settle delay (tests). */
    readonly transcriptSettleMs?: number;
}

/** Thrown by {@link LiveCall.start} with the close code to report to the client. */
export class CallSetupError extends Error {
    /**
     * @param closeCode One of {@link CALL_CLOSE_CODES}.
     * @param message What failed and how to fix it.
     */
    constructor(
        readonly closeCode: number,
        message: string,
    ) {
        super(message);
        this.name = "CallSetupError";
    }
}

/** Client frame types relayed to OpenAI; everything else from a client is dropped. */
const RELAYED_CLIENT_FRAMES = new Set([
    "session.input_audio.append",
    "session.input_audio.mute",
    "session.input_audio.unmute",
]);

/**
 * One voice call: the OpenAI Live session, its transcript (recorded on
 * the `voice` chat channel) and the background tasks it delegates.
 * Transport-independent — the web page and, later, a phone line are
 * {@link CallTransport}s.
 */
export class LiveCall {
    /** Call id (logs, record event, background payloads). */
    readonly id = randomUUID();
    private readonly deps: LiveCallDeps;
    private readonly transport: CallTransport;
    private readonly log: Logger;
    private readonly transcript: CallTranscript;
    private readonly recorder: ChatRecorder;
    private readonly broker: DelegationBroker;
    private upstream: LiveUpstream | null = null;
    private isEnded = false;
    private hangupPromise: Promise<void> | null = null;
    /** The briefing once it was sent, for a re-send near the context limit. */
    private briefingText: string | null = null;
    private isBriefingRepushArmed = true;

    /**
     * @param deps Host access, workspace, upstream connector, routing hooks.
     * @param transport How the call reaches the user.
     */
    constructor(deps: LiveCallDeps, transport: CallTransport) {
        this.deps = deps;
        this.transport = transport;
        this.log = deps.host.logger;
        this.recorder = new ChatRecorder(
            { events: deps.host.events, chat: deps.host.chat, log: this.log },
            {
                channelId: VOICE_CHAT_CHANNEL,
                prompt: `Transcript of voice call ${this.id} (${transport.kind}). Record only, no handler runs.`,
                payload: { callId: this.id, transport: transport.kind },
            },
        );
        this.transcript = new CallTranscript((turn) =>
            this.recorder.record(turn.speaker, turn.text),
        );
        this.broker = new DelegationBroker({
            events: deps.host.events,
            log: this.log,
            callId: this.id,
            transportKind: transport.kind,
            recentTurns: (maxTurns) => this.transcript.recent(maxTurns),
            deliver: (delegationId, text) => this.deliver(delegationId, text),
            reportProgress: (delegationId, text) => this.reportProgress(delegationId, text),
            notifyClient: (frame) => this.notifyClient(frame),
            onEventEmitted: (eventId, delegationId) => deps.routeEvent(eventId, this, delegationId),
            onEventSettled: (eventId) => deps.unrouteEvent(eventId),
            ...(deps.transcriptSettleMs === undefined
                ? {}
                : { transcriptSettleMs: deps.transcriptSettleMs }),
        });
    }

    /** Whether the call is still connected. */
    get isActive(): boolean {
        return !this.isEnded && this.upstream !== null;
    }

    /**
     * Open the OpenAI Live session. Settings come from
     * `workspace/voice/live.md` and the key from `inference.apiKeys.openai`,
     * both read now, so edits apply to the next call. The instructions get
     * the current time and the banners; the transcript of earlier calls
     * goes in as `input` history. Once the session runs, the briefing is
     * fetched in the background and sent as silent context.
     *
     * @throws {CallSetupError} When the key or `voice/live.md` is missing,
     *   or OpenAI refuses or does not answer.
     */
    async start(): Promise<void> {
        const apiKey = this.deps.host.config.getString(OPENAI_API_KEY_CONFIG, null);
        if (apiKey === null || apiKey.trim() === "") {
            throw new CallSetupError(
                CALL_CLOSE_CODES.noApiKey,
                `no OpenAI API key — set it with \`familiar config set ${OPENAI_API_KEY_CONFIG}\``,
            );
        }
        let settings: LiveSettings;
        try {
            settings = readLiveSettings(this.deps.workspaceDir, await this.placeholderValues());
        } catch (err) {
            if (err instanceof LiveConfigError) {
                throw new CallSetupError(CALL_CLOSE_CODES.noLiveConfig, err.message);
            }
            throw err;
        }
        for (const warning of settings.warnings) {
            this.log.warn(`gpt-voice: call ${this.id}: ${warning}`);
        }
        const input = await this.historyInput();
        const model = this.deps.modelFactory(apiKey, settings.model);
        const upstream = new LiveUpstream({
            model,
            connector: this.deps.connector,
            log: this.log,
            handlers: {
                onEvent: (raw, events) => this.onUpstreamEvent(raw, events),
                onClose: (error) => this.onUpstreamClosed(error),
            },
        });
        const sessionStart = model.serializeClientEvent({
            type: "session-start",
            config: {
                instructions: settings.instructions,
                voice: settings.voice,
                inputAudioFormat: this.transport.audioFormat,
                outputAudioFormat: this.transport.audioFormat,
                providerOptions: {
                    openai: {
                        delegation: { type: "client" },
                        ...(input.length === 0 ? {} : { input }),
                    },
                },
            },
        }) as Record<string, unknown>;
        this.upstream = upstream;
        try {
            await upstream.start(sessionStart);
        } catch (err) {
            this.upstream = null;
            const message = err instanceof Error ? err.message : String(err);
            throw new CallSetupError(CALL_CLOSE_CODES.upstreamFailed, message);
        }
        this.log.info(
            `gpt-voice: call ${this.id} (${this.transport.kind}) connected — model ${settings.model}, voice ${settings.voice}, ${input.length} history messages`,
        );
        void this.loadBriefing();
    }

    /**
     * Relay a client frame (OpenAI Live wire format) to the session. Only
     * audio and mute frames pass; session setup stays with the host.
     *
     * @param frame The parsed frame.
     * @returns Whether the frame was relayed.
     */
    relayClientFrame(frame: Record<string, unknown>): boolean {
        if (typeof frame.type !== "string" || !RELAYED_CLIENT_FRAMES.has(frame.type)) {
            return false;
        }
        this.upstream?.sendWire(frame);
        return true;
    }

    /**
     * Hang up: close the session (waiting for OpenAI's final usage),
     * finish the transcript and end the transport. Idempotent.
     *
     * @returns Resolves when the call is fully ended.
     */
    hangup(): Promise<void> {
        if (this.hangupPromise === null) {
            this.hangupPromise = (async () => {
                await this.upstream?.close();
                this.end(1000, "call ended");
                await this.recorder.drain();
            })();
        }
        return this.hangupPromise;
    }

    /**
     * Deliver text of a background task: spoken (as commentary for the
     * delegation, in chunks) while the call lasts; after hang-up written
     * to the default chat channel so it is not lost.
     *
     * @param delegationId The delegation it answers.
     * @param text Result or progress text.
     */
    deliver(delegationId: string, text: string): void {
        const upstream = this.upstream;
        if (upstream !== null && this.isActive) {
            for (const chunk of splitIntoAppends(text)) {
                upstream.appendContext(delegationId, chunk, "commentary");
            }
            return;
        }
        this.deliverAfterHangup(text);
    }

    /**
     * Tell the voice model silently what a background task is doing (a
     * finished step of its run), bound to the delegation. Not spoken by
     * itself; after hang-up it is dropped — only the result outlives the call.
     *
     * @param delegationId The delegation the task works on.
     * @param text Progress note (at most one append long).
     */
    reportProgress(delegationId: string, text: string): void {
        const upstream = this.upstream;
        if (upstream === null || !this.isActive) {
            return;
        }
        upstream.appendContext(delegationId, text, "thinking");
        this.log.debug(
            `gpt-voice: call ${this.id} delegation ${delegationId} progress note sent (${text.length} chars)`,
        );
    }

    /**
     * Handle one frame from OpenAI: relay it, feed the transcript, start
     * background tasks for delegations.
     *
     * @param raw Wire frame.
     * @param events Parsed events.
     */
    private onUpstreamEvent(
        raw: Record<string, unknown>,
        events: readonly Experimental_RealtimeServerEvent[],
    ): void {
        this.transport.forward(JSON.stringify(raw));
        for (const event of events) {
            switch (event.type) {
                case "transcript-fragment":
                    this.transcript.add({
                        speaker: event.speaker === "user" ? "user" : "assistant",
                        delta: event.delta,
                        startMs: event.startMs ?? 0,
                        endMs: event.endMs ?? event.startMs ?? 0,
                    });
                    break;
                case "delegation-created":
                    void this.broker.onDelegationCreated(event.delegationId);
                    break;
                case "session-usage":
                    this.onContextUsage(event.contextWindowUsageRatio);
                    break;
                case "session-closed":
                    this.log.info(
                        `gpt-voice: call ${this.id} closed by OpenAI (${event.reason ?? "no reason"}) after ${event.usage?.seconds ?? "?"} s`,
                    );
                    break;
                case "error":
                    this.log.warn(
                        `gpt-voice: call ${this.id} OpenAI error ${event.code ?? ""}: ${event.message}`,
                    );
                    break;
                default:
                    break;
            }
        }
    }

    /**
     * The upstream connection ended.
     *
     * @param error Why, or null for an orderly close.
     */
    private onUpstreamClosed(error: Error | null): void {
        if (error !== null) {
            this.log.warn(`gpt-voice: call ${this.id} lost the OpenAI session: ${error.message}`);
        }
        this.end(
            error === null ? 1000 : CALL_CLOSE_CODES.upstreamFailed,
            error === null ? "call ended" : "connection to OpenAI lost",
        );
    }

    /**
     * Mark the call ended once: flush the transcript, end the transport, forget the call.
     *
     * @param code Close code for the transport.
     * @param reason Close reason.
     */
    private end(code: number, reason: string): void {
        if (this.isEnded) {
            return;
        }
        this.isEnded = true;
        this.upstream = null;
        this.transcript.flush();
        this.transport.end(code, reason);
        this.deps.onEnded(this);
        this.log.info(`gpt-voice: call ${this.id} ended (${code} ${reason})`);
    }

    /**
     * Send a host frame to the client (ignored once the call ended).
     *
     * @param frame The frame.
     */
    private notifyClient(frame: HostFrame): void {
        if (!this.isEnded) {
            this.transport.forward(JSON.stringify(frame));
        }
    }

    /**
     * Values of the `voice/live.md` placeholders. A failure to read the
     * banners is logged and rendered as `(none)` — it must not stop a call.
     *
     * @returns Placeholder name → value.
     */
    private async placeholderValues(): Promise<ReadonlyMap<string, string>> {
        const host = this.deps.host;
        const timezone = host.timezone;
        let bannerList = "(none)";
        try {
            bannerList = formatBannerList(await host.banners.listActive(), timezone);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.log.warn(`gpt-voice: call ${this.id} could not read the banners: ${message}`);
        }
        return new Map([
            [LIVE_PLACEHOLDERS.assistantName, host.assistantName],
            [LIVE_PLACEHOLDERS.currentTime, formatRuntimeTime(this.now(), timezone)],
            [LIVE_PLACEHOLDERS.bannerList, bannerList],
        ]);
    }

    /**
     * The transcript of earlier calls as the session's `input` history.
     * A failure is logged and yields no history.
     *
     * @returns Input messages, oldest first (empty without earlier calls).
     */
    private async historyInput(): Promise<LiveInputMessage[]> {
        try {
            const messages = await this.deps.host.chat.listMessages({
                channelId: VOICE_CHAT_CHANNEL,
                limit: HISTORY_INPUT_MESSAGES,
            });
            return buildHistoryInput(messages);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.log.warn(
                `gpt-voice: call ${this.id} could not read earlier calls for the history: ${message}`,
            );
            return [];
        }
    }

    /**
     * Fetch the briefing (cached or built by a `voice:briefing` run) and
     * send it as silent context. Never throws; without a briefing the
     * voice model just delegates more.
     */
    private async loadBriefing(): Promise<void> {
        this.notifyClient({ type: "familiar.briefing.started" });
        let text: string;
        try {
            text = await this.deps.briefing.get(this.id);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.log.warn(`gpt-voice: call ${this.id} has no briefing: ${message}`);
            this.notifyClient({ type: "familiar.briefing.finished", is_failed: true });
            return;
        }
        if (!this.isActive) {
            return;
        }
        this.briefingText = text;
        this.pushBriefing(text);
        this.notifyClient({ type: "familiar.briefing.finished", is_failed: false });
    }

    /**
     * Send the briefing as session-wide thinking (silent context), in
     * appends of at most ~500 tokens.
     *
     * @param text The briefing.
     */
    private pushBriefing(text: string): void {
        const upstream = this.upstream;
        if (upstream === null || !this.isActive) {
            return;
        }
        const chunks = splitIntoAppends(text);
        chunks.forEach((chunk, index) => {
            const label =
                chunks.length === 1 ? "Briefing" : `Briefing (${index + 1}/${chunks.length})`;
            upstream.appendContext(null, `${label}: ${chunk}`, "thinking");
        });
        this.log.info(
            `gpt-voice: call ${this.id} sent the briefing (${text.length} chars, ${chunks.length} appends)`,
        );
    }

    /**
     * React to the session's context usage: re-send the briefing once
     * when the window nears the hand-over to a replacement engine, and
     * arm the re-send again after the usage dropped (hand-over done).
     *
     * @param ratio `context_window.usage_ratio`, if reported.
     */
    private onContextUsage(ratio: number | undefined): void {
        if (ratio === undefined || this.briefingText === null) {
            return;
        }
        if (ratio < BRIEFING_REARM_RATIO) {
            this.isBriefingRepushArmed = true;
            return;
        }
        if (ratio >= BRIEFING_REPUSH_RATIO && this.isBriefingRepushArmed) {
            this.isBriefingRepushArmed = false;
            this.log.info(
                `gpt-voice: call ${this.id} context window ${Math.round(ratio * 100)} % full — sending the briefing again`,
            );
            this.pushBriefing(this.briefingText);
        }
    }

    /**
     * Current time.
     *
     * @returns Now, from the injected clock if any.
     */
    private now(): Date {
        return this.deps.now?.() ?? new Date();
    }

    /**
     * Write a late result to the default chat channel.
     *
     * @param text The result.
     */
    private deliverAfterHangup(text: string): void {
        const channelId = this.deps.host.config.getString("core.defaultChatChannel");
        const recorder = new ChatRecorder(
            { events: this.deps.host.events, chat: this.deps.host.chat, log: this.log },
            {
                channelId,
                prompt: `Result of a background task of voice call ${this.id}, which ended before it finished. Record only, no handler runs.`,
                payload: { callId: this.id, transport: this.transport.kind },
            },
        );
        recorder.record("assistant", text);
        this.log.info(
            `gpt-voice: call ${this.id} already ended — background result sent to chat channel ${channelId}`,
        );
    }
}

/**
 * Turn the latest chat messages of earlier calls into the session's
 * `input` history: newest messages first until
 * {@link HISTORY_INPUT_MAX_CHARS} is reached, then in chronological
 * order, after a developer note that they are not part of this call.
 *
 * @param messages Messages of the `voice` channel, oldest first.
 * @returns Input messages, or none when there are no messages.
 */
export function buildHistoryInput(messages: readonly ChatMessage[]): LiveInputMessage[] {
    const kept: ChatMessage[] = [];
    let chars = 0;
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (message === undefined || message.textContent.trim() === "") {
            continue;
        }
        chars += message.textContent.length;
        if (chars > HISTORY_INPUT_MAX_CHARS) {
            break;
        }
        kept.unshift(message);
    }
    if (kept.length === 0) {
        return [];
    }
    return [
        {
            type: "message",
            role: "developer",
            content: [
                {
                    type: "input_text",
                    text: "The following messages are from earlier voice calls with the user, for context. They are not part of this call; the call starts after them.",
                },
            ],
        },
        ...kept.map(
            (message): LiveInputMessage =>
                message.role === "assistant"
                    ? {
                          type: "message",
                          role: "assistant",
                          content: [{ type: "output_text", text: message.textContent }],
                      }
                    : {
                          type: "message",
                          role: "user",
                          content: [{ type: "input_text", text: message.textContent }],
                      },
        ),
    ];
}
