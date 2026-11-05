import * as React from "react";
import type {
    ChatHandlersDto,
    ChatHistoryDto,
    ChatMessageDto,
    ChatSendResultDto,
    ChatServerEvent,
    ChatTurnDto,
} from "@/host/ChatProtocol";

/** History page size of the initial load and of "load earlier". */
const PAGE_SIZE = 50;

/** State and actions of the web chat. */
export interface ChatState {
    /** Visible messages, oldest first (hidden ones after `/clear` left out). */
    readonly messages: readonly ChatMessageDto[];
    /** Turns sent from this browser session or still in flight, by event id. */
    readonly turns: ReadonlyMap<string, ChatTurnDto>;
    /** Whether the initial history is loaded. */
    readonly isLoaded: boolean;
    /** Whether older messages exist on the server. */
    readonly hasMore: boolean;
    /** Whether the live connection is up. */
    readonly isConnected: boolean;
    /** Whether a turn of this chat is running. */
    readonly isBusy: boolean;
    /** Last error to show (send refused, network), or null. */
    readonly error: string | null;
    /** Handler slash paths and builtins for autocompletion. */
    readonly commands: ChatHandlersDto;
    /** Your own earlier messages, oldest first (for ↑ / ↓ in the input). */
    readonly inputHistory: readonly string[];
    send(text: string): Promise<boolean>;
    loadOlder(): Promise<void>;
    clear(): void;
    dismissError(): void;
}

/**
 * Compare two message ids (bigint strings).
 *
 * @param a First id.
 * @param b Second id.
 * @returns Negative, zero or positive.
 */
function compareIds(a: string, b: string): number {
    const difference = BigInt(a) - BigInt(b);
    return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

/**
 * Merge messages into a map keyed by id.
 *
 * @param current Current map.
 * @param incoming Messages to add.
 * @returns A new map.
 */
function mergeMessages(
    current: ReadonlyMap<string, ChatMessageDto>,
    incoming: readonly ChatMessageDto[],
): Map<string, ChatMessageDto> {
    const next = new Map(current);
    for (const message of incoming) {
        next.set(message.id, message);
    }
    return next;
}

/**
 * Fetch JSON from the chat API.
 *
 * @param url Request URL.
 * @param init Fetch options.
 * @returns The parsed body and status.
 * @throws {Error} On network errors and non-JSON answers; a 401 sends the
 *   browser to the login page.
 */
async function fetchJson<T>(url: string, init?: RequestInit): Promise<{ status: number; body: T }> {
    const res = await fetch(url, {
        ...init,
        headers: { accept: "application/json", ...init?.headers },
    });
    if (res.status === 401) {
        window.location.assign("/login");
    }
    const body = (await res.json()) as T;
    return { status: res.status, body };
}

/**
 * The web chat's data: history (paged), live messages and turn progress
 * from the server-sent events, sending, and the client-side `/clear`.
 *
 * @param apiBase Base URL of the chat API (`/plugins/web-chat/api`).
 * @returns The chat state and actions.
 */
export function useChat(apiBase: string): ChatState {
    const [messages, setMessages] = React.useState<ReadonlyMap<string, ChatMessageDto>>(new Map());
    const [turns, setTurns] = React.useState<ReadonlyMap<string, ChatTurnDto>>(new Map());
    const [isLoaded, setIsLoaded] = React.useState(false);
    const [hasMore, setHasMore] = React.useState(false);
    const [isConnected, setIsConnected] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [clearedThrough, setClearedThrough] = React.useState<string | null>(null);
    const [commands, setCommands] = React.useState<ChatHandlersDto>({ handlers: [], builtins: [] });

    /** Fetch the newest page; only the initial load decides `hasMore`. */
    const loadLatest = React.useCallback(
        async (isInitial: boolean) => {
            const { body } = await fetchJson<ChatHistoryDto>(
                `${apiBase}/messages?limit=${PAGE_SIZE}`,
            );
            setMessages((current) => mergeMessages(current, body.messages));
            if (isInitial) {
                setHasMore(body.hasMore);
                setIsLoaded(true);
            }
        },
        [apiBase],
    );

    React.useEffect(() => {
        loadLatest(true).catch((err: unknown) =>
            setError(`Could not load the chat: ${String(err)}`),
        );
        fetchJson<ChatHandlersDto>(`${apiBase}/handlers`)
            .then(({ body }) => setCommands(body))
            .catch(() => {});
    }, [apiBase, loadLatest]);

    React.useEffect(() => {
        const source = new EventSource(`${apiBase}/events`);
        let hasOpened = false;
        source.onopen = () => {
            setIsConnected(true);
            if (hasOpened) {
                // Reconnected: fetch what arrived while the stream was down.
                loadLatest(false).catch(() => {});
            }
            hasOpened = true;
        };
        source.onerror = () => setIsConnected(false);
        const onEvent = (raw: MessageEvent<string>) => {
            const event = JSON.parse(raw.data) as ChatServerEvent;
            if (event.type === "snapshot") {
                setTurns((current) => {
                    const next = new Map(current);
                    for (const turn of event.turns) {
                        next.set(turn.eventId, turn);
                    }
                    return next;
                });
            } else if (event.type === "turn") {
                setTurns((current) => new Map(current).set(event.turn.eventId, event.turn));
            } else {
                setMessages((current) => mergeMessages(current, [event.message]));
            }
        };
        for (const type of ["snapshot", "turn", "message"]) {
            source.addEventListener(type, onEvent as EventListener);
        }
        return () => source.close();
    }, [apiBase, loadLatest]);

    const sorted = React.useMemo(
        () => [...messages.values()].sort((a, b) => compareIds(a.id, b.id)),
        [messages],
    );
    const visible = React.useMemo(
        () =>
            clearedThrough === null
                ? sorted
                : sorted.filter((message) => compareIds(message.id, clearedThrough) > 0),
        [sorted, clearedThrough],
    );
    const inputHistory = React.useMemo(
        () => sorted.filter((message) => message.role === "user").map((message) => message.text),
        [sorted],
    );
    const isBusy = React.useMemo(
        () => [...turns.values()].some((turn) => turn.state === "running"),
        [turns],
    );

    const send = React.useCallback(
        async (text: string): Promise<boolean> => {
            try {
                const { status, body } = await fetchJson<ChatSendResultDto>(`${apiBase}/messages`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ text }),
                });
                if ("error" in body) {
                    setError(body.error);
                    return false;
                }
                if (status >= 400) {
                    setError(`Sending failed (HTTP ${status})`);
                    return false;
                }
                setError(null);
                setTurns((current) =>
                    current.has(body.eventId)
                        ? current
                        : new Map(current).set(body.eventId, {
                              eventId: body.eventId,
                              state: "running",
                              runs: [],
                              steps: [],
                              error: null,
                          }),
                );
                return true;
            } catch (err) {
                setError(`Sending failed: ${err instanceof Error ? err.message : String(err)}`);
                return false;
            }
        },
        [apiBase],
    );

    const loadOlder = React.useCallback(async () => {
        const oldest = sorted[0];
        if (oldest === undefined) {
            return;
        }
        try {
            const { body } = await fetchJson<ChatHistoryDto>(
                `${apiBase}/messages?limit=${PAGE_SIZE}&before=${oldest.id}`,
            );
            setMessages((current) => mergeMessages(current, body.messages));
            setHasMore(body.hasMore);
        } catch (err) {
            setError(`Could not load earlier messages: ${String(err)}`);
        }
    }, [apiBase, sorted]);

    const clear = React.useCallback(() => {
        const newest = sorted.at(-1);
        setClearedThrough(newest?.id ?? null);
        setTurns((current) => new Map([...current].filter(([, turn]) => turn.state === "running")));
        setHasMore(false);
    }, [sorted]);

    return {
        messages: visible,
        turns,
        isLoaded,
        hasMore: hasMore && clearedThrough === null,
        isConnected,
        isBusy,
        error,
        commands,
        inputHistory,
        send,
        loadOlder,
        clear,
        dismissError: () => setError(null),
    };
}
