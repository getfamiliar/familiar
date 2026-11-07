import type {
    ChatMessage,
    ChatUnsubscribe,
    HostContext,
    WebSocketConnectionInfo,
    WebSocketPeer,
} from "@getfamiliar/shared";
import { BriefingProvider } from "./live/BriefingProvider.js";
import {
    type CallTransport,
    LiveCall,
    type LiveModelFactory,
    OPENAI_API_KEY_CONFIG,
    openAiLiveModelFactory,
    type VoiceHost,
} from "./live/LiveCall.js";
import { type UpstreamConnector, wsConnector } from "./live/LiveUpstream.js";
import { VOICE_CHAT_CHANNEL, type VoiceStatus } from "./VoiceProtocol.js";
import { BrowserTransport } from "./web/BrowserTransport.js";

/** Dependencies of the {@link VoiceService}. */
export interface VoiceServiceDeps {
    readonly host: VoiceHost & { readonly chat: Pick<HostContext["chat"], "subscribe"> };
    readonly workspaceDir: string;
    /** Upstream socket factory (default: `ws`). */
    readonly connector?: UpstreamConnector;
    /** Live codec factory (default: direct OpenAI). */
    readonly modelFactory?: LiveModelFactory;
    /** Override of the transcript settle delay (tests). */
    readonly transcriptSettleMs?: number;
    /** Clock (tests). */
    readonly now?: () => Date;
}

/** Where a background event's chat messages go. */
interface EventRoute {
    readonly call: LiveCall;
    readonly delegationId: string;
}

/**
 * The running voice plugin: owns the active calls and the single
 * subscription to the `voice` chat channel, through which `send_chat`
 * messages of background tasks reach the call that started them (and are
 * spoken there).
 */
export class VoiceService {
    private readonly deps: VoiceServiceDeps;
    private readonly calls = new Set<LiveCall>();
    private readonly routes = new Map<string, EventRoute>();
    private unsubscribe: ChatUnsubscribe | null = null;
    /** Shared by all calls, so a fresh briefing is reused. */
    readonly briefing: BriefingProvider;

    /**
     * @param deps Host access, workspace and (for tests) upstream overrides.
     */
    constructor(deps: VoiceServiceDeps) {
        this.deps = deps;
        this.briefing = new BriefingProvider({
            events: deps.host.events,
            log: deps.host.logger,
            timezone: () => deps.host.timezone,
            ...(deps.now === undefined ? {} : { now: deps.now }),
        });
    }

    /** Subscribe to the `voice` chat channel. */
    async start(): Promise<void> {
        this.unsubscribe = await this.deps.host.chat.subscribe(
            { channelId: VOICE_CHAT_CHANNEL, role: "assistant" },
            (message) => this.onChatMessage(message),
        );
    }

    /** Hang up every call and unsubscribe. */
    async stop(): Promise<void> {
        await Promise.all([...this.calls].map((call) => call.hangup()));
        this.calls.clear();
        this.routes.clear();
        const unsubscribe = this.unsubscribe;
        this.unsubscribe = null;
        await unsubscribe?.();
    }

    /**
     * What the page needs to know before offering a call.
     *
     * @param isHttps Whether the request came over HTTPS.
     * @returns Key and HTTPS state.
     */
    status(isHttps: boolean): VoiceStatus {
        const apiKey = this.deps.host.config.getString(OPENAI_API_KEY_CONFIG, null);
        return { hasOpenAiKey: apiKey !== null && apiKey.trim() !== "", isHttps };
    }

    /**
     * A page opened the call socket.
     *
     * @param peer The socket.
     * @param info Who connected.
     */
    onBrowserSocket(peer: WebSocketPeer, info: WebSocketConnectionInfo): void {
        this.deps.host.logger.info(
            `gpt-voice: ${info.principal.login} opened a call from the web UI${info.isHttps ? "" : " (not HTTPS)"}`,
        );
        new BrowserTransport(
            peer,
            (transport) => this.createCall(transport),
            this.deps.host.logger,
        );
    }

    /** Number of active calls (tests, status). */
    get activeCallCount(): number {
        return this.calls.size;
    }

    /**
     * Create a call for a transport and track it until it ends.
     *
     * @param transport How the call reaches the user.
     * @returns The call (not yet started).
     */
    createCall(transport: CallTransport): LiveCall {
        const call = new LiveCall(
            {
                host: this.deps.host,
                workspaceDir: this.deps.workspaceDir,
                connector: this.deps.connector ?? wsConnector,
                modelFactory: this.deps.modelFactory ?? openAiLiveModelFactory,
                briefing: this.briefing,
                ...(this.deps.now === undefined ? {} : { now: this.deps.now }),
                routeEvent: (eventId, routedCall, delegationId) =>
                    this.routes.set(eventId, { call: routedCall, delegationId }),
                unrouteEvent: (eventId) => this.routes.delete(eventId),
                onEnded: (ended) => this.calls.delete(ended),
                ...(this.deps.transcriptSettleMs === undefined
                    ? {}
                    : { transcriptSettleMs: this.deps.transcriptSettleMs }),
            },
            transport,
        );
        this.calls.add(call);
        return call;
    }

    /**
     * A chat message on the `voice` channel: progress of a background
     * task (`send_chat`) is delivered to its call. Everything else there
     * (the recorded transcripts) needs no delivery.
     *
     * @param message The message.
     * @returns Always true (mark delivered).
     */
    private async onChatMessage(message: ChatMessage): Promise<boolean> {
        const route = this.routes.get(message.eventId);
        if (route !== undefined) {
            route.call.deliver(route.delegationId, message.textContent);
        }
        return true;
    }
}
