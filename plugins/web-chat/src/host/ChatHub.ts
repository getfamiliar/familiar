import {
    type AgentRunRow,
    type ChatMessage,
    DaemonStoppedError,
    EVENT_PRIORITY,
    type HostContext,
    type Logger,
    type NewEvent,
    type ParsedChatInput,
    parseChatInput,
    type StepResultRow,
} from "@getfamiliar/shared";
import {
    type ChatHistoryDto,
    type ChatRunDto,
    type ChatServerEvent,
    type ChatStepDto,
    type ChatTurnDto,
    WEB_CHAT_BUILTINS,
    WEB_CHAT_CHANNEL,
    WEB_CHAT_TOPIC,
} from "./ChatProtocol.js";
import { toMessageDto, toRunDto, toStepDto } from "./StepProjection.js";

/** How long a finished turn stays in the snapshot (so a reload still shows its trace). */
const FINISHED_TURN_RETENTION_MS = 5 * 60 * 1000;

/** Largest history page the API serves. */
export const MAX_HISTORY_PAGE = 100;

/** The handler catalog operations the hub needs (`HandlerCatalog` from shared). */
export interface ChatHandlerCatalog {
    list(): Promise<readonly { readonly slashPath: string }[]>;
    resolve(topic: string, options: { readonly isExactTopic: boolean }): Promise<unknown | null>;
}

/** What the hub needs from the host. */
export interface ChatHubDeps {
    readonly chat: HostContext["chat"];
    readonly events: HostContext["events"];
    readonly handlers: ChatHandlerCatalog;
    readonly log: Logger;
}

/** A browser connection receiving server events. */
export type ChatClient = (event: ChatServerEvent) => void;

/** A user input the hub refuses (answered with 400). */
export class ChatInputError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ChatInputError";
    }
}

/** Mutable state of a turn in flight. */
interface TurnState {
    eventId: string;
    state: ChatTurnDto["state"];
    readonly runs: Map<string, ChatRunDto>;
    readonly steps: ChatStepDto[];
    error: string | null;
}

/**
 * The web chat's server side: one subscription to the chat bus for the
 * `web` channel, fanned out to every connected browser tab (the bus marks
 * a row delivered once, so tabs must not subscribe individually), plus
 * sending user input as events and tracking their progress.
 *
 * Mirrors cli-chat: plain messages go to `chat:web`, `/topic/sub …` lines
 * are direct handler calls (validated against the workspace), events are
 * `privileged` (only allowlisted users reach the web UI), failures are
 * written to the chat, and a direct call that produced no chat reply gets
 * its result text appended as the reply.
 */
export class ChatHub {
    private readonly deps: ChatHubDeps;
    private readonly clients = new Set<ChatClient>();
    private readonly turns = new Map<string, TurnState>();
    /** Events of in-flight turns that already got an assistant message. */
    private readonly answeredEvents = new Set<string>();
    private readonly retentionTimers = new Set<NodeJS.Timeout>();
    private unsubscribe: (() => Promise<void>) | null = null;

    /**
     * @param deps Host services.
     */
    constructor(deps: ChatHubDeps) {
        this.deps = deps;
    }

    /**
     * Subscribe to the `web` channel. Undelivered messages replayed by the
     * bus are broadcast like live ones (there is nobody to show them to
     * yet, so assistant messages stay undelivered until a tab is open).
     */
    async start(): Promise<void> {
        this.unsubscribe = await this.deps.chat.subscribe(
            { channelId: WEB_CHAT_CHANNEL },
            (message) => Promise.resolve(this.onChatMessage(message)),
        );
    }

    /** Drop the subscription, the turns and every client. */
    async stop(): Promise<void> {
        const unsubscribe = this.unsubscribe;
        this.unsubscribe = null;
        for (const timer of this.retentionTimers) {
            clearTimeout(timer);
        }
        this.retentionTimers.clear();
        this.turns.clear();
        this.answeredEvents.clear();
        this.clients.clear();
        await unsubscribe?.();
    }

    /**
     * Connect a browser tab. It first receives a snapshot of the turns in
     * flight, then every event.
     *
     * @param client Event sink of the connection.
     * @returns Disconnect function.
     */
    addClient(client: ChatClient): () => void {
        this.clients.add(client);
        client({ type: "snapshot", turns: [...this.turns.values()].map(toTurnDto) });
        return () => {
            this.clients.delete(client);
        };
    }

    /**
     * One page of the web channel's history.
     *
     * @param beforeId Cursor (message id) or undefined for the newest page.
     * @param limit Page size, 1 … {@link MAX_HISTORY_PAGE}.
     * @returns The page and whether older messages exist.
     */
    async history(beforeId: string | undefined, limit: number): Promise<ChatHistoryDto> {
        const page = await this.deps.chat.listMessages({
            channelId: WEB_CHAT_CHANNEL,
            beforeId,
            limit: limit + 1,
        });
        const hasMore = page.length > limit;
        const messages = (hasMore ? page.slice(1) : page).map(toMessageDto);
        return { messages, hasMore };
    }

    /**
     * Slash paths for autocompletion.
     *
     * @returns Handler paths and the page's builtins.
     */
    async handlerPaths(): Promise<{ handlers: string[]; builtins: string[] }> {
        const handlers = (await this.deps.handlers.list()).map((handler) => handler.slashPath);
        return { handlers, builtins: [...WEB_CHAT_BUILTINS] };
    }

    /**
     * Send one typed line as an event.
     *
     * @param text The line.
     * @returns The event id.
     * @throws {ChatInputError} For an empty line, a builtin (handled by the
     *   page) or an unknown handler path.
     */
    async send(text: string): Promise<string> {
        const parsed = parseChatInput(text, WEB_CHAT_BUILTINS);
        if (parsed.kind === "builtin") {
            throw new ChatInputError(`${parsed.command} is handled by the chat page, not sent`);
        }
        if (parsed.prompt === "" && parsed.topic === undefined) {
            throw new ChatInputError("empty message");
        }
        if (parsed.topic !== undefined) {
            const resolved = await this.deps.handlers.resolve(parsed.topic, { isExactTopic: true });
            if (resolved === null) {
                throw new ChatInputError(
                    `no handler found for /${parsed.topic.split(":").join("/")}`,
                );
            }
        }
        const turn: TurnState = {
            eventId: "",
            state: "running",
            runs: new Map(),
            steps: [],
            error: null,
        };
        const handle = await this.deps.events.emit(buildNewEvent(parsed), {
            onAgentRun: (row) => this.onAgentRun(turn, row),
            onStep: (step) => this.onStep(turn, step),
        });
        turn.eventId = handle.id;
        this.turns.set(handle.id, turn);
        this.broadcastTurn(turn);
        void handle.settled.then(
            (resultText) => this.onSettled(turn, resultText),
            (err: unknown) => this.onFailed(turn, err),
        );
        return handle.id;
    }

    /**
     * Bus handler: broadcast the message. User rows count as delivered
     * (they came from the user); assistant rows only when a tab shows them.
     *
     * @param message The stored message.
     * @returns Whether to mark it delivered.
     */
    private onChatMessage(message: ChatMessage): boolean {
        if (message.role === "assistant") {
            this.answeredEvents.add(message.eventId);
        }
        this.broadcast({ type: "message", message: toMessageDto(message) });
        return message.role === "user" || this.clients.size > 0;
    }

    /**
     * Record an agentrun state change of a turn.
     *
     * @param turn The turn.
     * @param row The agentrun row.
     */
    private onAgentRun(turn: TurnState, row: AgentRunRow): void {
        turn.runs.set(row.id, toRunDto(row));
        this.broadcastTurn(turn);
    }

    /**
     * Record a finished step of a turn.
     *
     * @param turn The turn.
     * @param step The step row.
     */
    private onStep(turn: TurnState, step: StepResultRow): void {
        turn.steps.push(toStepDto(step));
        this.broadcastTurn(turn);
    }

    /**
     * The event finished: append the result text as the reply when the
     * run produced no chat message (direct calls to non-chat handlers).
     *
     * @param turn The turn.
     * @param resultText Result text of the last agentrun.
     */
    private async onSettled(turn: TurnState, resultText: string): Promise<void> {
        const text = resultText.trim();
        if (!this.answeredEvents.has(turn.eventId) && text !== "") {
            try {
                await this.deps.chat.appendAssistantMessage(turn.eventId, text);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                this.deps.log.error(
                    `web-chat: could not store the result of event ${turn.eventId} as reply: ${message}`,
                );
            }
        }
        this.finishTurn(turn, "done", null);
    }

    /**
     * The event failed (the host already wrote the failure to the chat).
     *
     * @param turn The turn.
     * @param err The rejection.
     */
    private onFailed(turn: TurnState, err: unknown): void {
        const message =
            err instanceof DaemonStoppedError
                ? "the daemon stopped"
                : err instanceof Error
                  ? err.message
                  : String(err);
        this.finishTurn(turn, "failed", message);
    }

    /**
     * Mark a turn finished, broadcast it, and drop it after the retention time.
     *
     * @param turn The turn.
     * @param state Final state.
     * @param error Failure text or null.
     */
    private finishTurn(turn: TurnState, state: "done" | "failed", error: string | null): void {
        turn.state = state;
        turn.error = error;
        this.answeredEvents.delete(turn.eventId);
        this.broadcastTurn(turn);
        const timer = setTimeout(() => {
            this.retentionTimers.delete(timer);
            this.turns.delete(turn.eventId);
        }, FINISHED_TURN_RETENTION_MS);
        timer.unref();
        this.retentionTimers.add(timer);
    }

    /**
     * Broadcast a turn's full state (once its event id is known).
     *
     * @param turn The turn.
     */
    private broadcastTurn(turn: TurnState): void {
        if (turn.eventId !== "") {
            this.broadcast({ type: "turn", turn: toTurnDto(turn) });
        }
    }

    /**
     * Send an event to every connected tab. A failing client is dropped.
     *
     * @param event The event.
     */
    private broadcast(event: ChatServerEvent): void {
        for (const client of this.clients) {
            try {
                client(event);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                this.deps.log.warn(
                    `web-chat: dropping a browser connection that failed: ${message}`,
                );
                this.clients.delete(client);
            }
        }
    }
}

/**
 * The event for one typed line, as cli-chat builds it: plain messages are
 * chat events on `chat:web`; direct handler calls are exact-topic runs
 * whose typed line is stored as the user message.
 *
 * @param parsed The parsed line.
 * @returns The event.
 */
export function buildNewEvent(parsed: Extract<ParsedChatInput, { kind: "handler" }>): NewEvent {
    const common = {
        priority: EVENT_PRIORITY.CHAT,
        preferredChatChannelId: WEB_CHAT_CHANNEL,
        privileged: true,
        outputChatOnFailure: true,
    } as const;
    if (parsed.topic === undefined) {
        return { ...common, topic: WEB_CHAT_TOPIC, isChat: true, prompt: parsed.prompt };
    }
    return {
        ...common,
        topic: parsed.topic,
        isExactTopic: true,
        isChat: false,
        prompt: parsed.prompt.length > 0 ? parsed.prompt : "(handler invoked from web-chat)",
        userChatMessage: parsed.rawInput,
    };
}

/**
 * Snapshot a turn for the browser.
 *
 * @param turn The turn.
 * @returns The DTO.
 */
function toTurnDto(turn: TurnState): ChatTurnDto {
    return {
        eventId: turn.eventId,
        state: turn.state,
        runs: [...turn.runs.values()],
        steps: [...turn.steps],
        error: turn.error,
    };
}
