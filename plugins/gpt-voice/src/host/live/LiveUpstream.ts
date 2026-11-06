import type { Experimental_OpenAIRealtimeModelLive } from "@ai-sdk/openai";
import type { Logger } from "@getfamiliar/shared";
import type { Experimental_RealtimeServerEvent } from "ai";
import WebSocket from "ws";

/** Default wait for `session.started` after connecting. */
export const DEFAULT_START_TIMEOUT_MS = 30_000;

/** Default wait for `session.closed` after `session.close` (OpenAI's own guidance). */
export const DEFAULT_CLOSE_TIMEOUT_MS = 15_000;

/** Minimal client socket {@link LiveUpstream} needs; {@link wsConnector} adapts `ws`. */
export interface UpstreamSocket {
    /** Send one text frame. */
    send(data: string): void;
    /** Close the socket (no-op when already closed). */
    close(): void;
    /** Register the open handler. */
    onOpen(handler: () => void): void;
    /** Register the text frame handler. */
    onMessage(handler: (text: string) => void): void;
    /** Register the close handler (called once). */
    onClose(handler: (code: number, reason: string) => void): void;
    /** Register the error handler (connection errors, failed handshake). */
    onError(handler: (err: Error) => void): void;
}

/** Opens an {@link UpstreamSocket} to a URL with headers. */
export type UpstreamConnector = (url: string, headers: Record<string, string>) => UpstreamSocket;

/**
 * The production connector: a `ws` client socket (needed because the
 * upstream authenticates with an `Authorization` header).
 *
 * @param url Upstream URL.
 * @param headers Handshake headers.
 * @returns The adapted socket.
 */
export const wsConnector: UpstreamConnector = (url, headers) => {
    const ws = new WebSocket(url, { headers });
    return {
        send: (data) => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(data);
            }
        },
        close: () => {
            if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) {
                ws.close();
            }
        },
        onOpen: (handler) => ws.on("open", handler),
        onMessage: (handler) => ws.on("message", (data) => handler(String(data))),
        onClose: (handler) =>
            ws.on("close", (code: number, reason: Buffer) => handler(code, reason.toString())),
        onError: (handler) => {
            ws.on("error", handler);
            ws.on("unexpected-response", (_req, res) => {
                let body = "";
                res.on("data", (chunk: Buffer) => {
                    body += chunk.toString();
                });
                res.on("end", () => {
                    handler(
                        new Error(
                            `OpenAI refused the connection with HTTP ${res.statusCode}: ${body.slice(0, 300)}`,
                        ),
                    );
                    ws.terminate();
                });
            });
        },
    };
};

/** Callbacks of a {@link LiveUpstream}. */
export interface LiveUpstreamHandlers {
    /**
     * Every server frame, raw (for relaying) and parsed by the AI SDK's
     * Live codec (for the host's own logic).
     */
    onEvent(
        raw: Record<string, unknown>,
        events: readonly Experimental_RealtimeServerEvent[],
    ): void;
    /**
     * The upstream connection ended. `error` is null after an orderly
     * close (`session.closed`, or {@link LiveUpstream.close}).
     */
    onClose(error: Error | null): void;
}

/** Options of a {@link LiveUpstream}. */
export interface LiveUpstreamOptions {
    /** The AI SDK's Live codec (connection config, event (de)serialization). */
    readonly model: Experimental_OpenAIRealtimeModelLive;
    readonly connector: UpstreamConnector;
    readonly handlers: LiveUpstreamHandlers;
    readonly log: Logger;
}

/**
 * The host's connection to an OpenAI Live session
 * (`wss://api.openai.com/v1/live/sessions`, authenticated with the API
 * key — which therefore never reaches the browser).
 *
 * Today it always creates the session itself ({@link start} sends
 * `session.start`). A phone call accepted over SIP will instead attach as
 * a sideband to the session OpenAI created
 * (`/v1/live/sessions/<id>/attach`, no `session.start`); everything after
 * the handshake — events, context appends, close — is the same.
 */
export class LiveUpstream {
    private readonly options: LiveUpstreamOptions;
    private socket: UpstreamSocket | null = null;
    private readonly parse: (raw: unknown) => Experimental_RealtimeServerEvent[];
    /** Resolvers waiting for `session.closed`. */
    private readonly closedWaiters: Array<() => void> = [];
    private isClosed = false;
    /** Rejects a pending {@link start}; null once startup settled. */
    private abortStart: ((error: Error) => void) | null = null;

    /**
     * @param options Codec, connector, handlers, logger.
     */
    constructor(options: LiveUpstreamOptions) {
        this.options = options;
        this.parse = options.model.createServerEventParser();
    }

    /**
     * Connect and start the session; resolves once OpenAI confirmed it
     * (`session.started`). Frames received meanwhile already reach
     * {@link LiveUpstreamHandlers.onEvent}.
     *
     * @param sessionStart The serialized `session.start` frame.
     * @param timeoutMs Startup limit.
     * @throws {Error} When the connection fails, OpenAI answers with an
     *   error or closes, or the timeout passes — the socket is closed then.
     */
    async start(
        sessionStart: Record<string, unknown>,
        timeoutMs = DEFAULT_START_TIMEOUT_MS,
    ): Promise<void> {
        const connection = await this.options.model.getServerWebSocketConfig();
        await new Promise<void>((resolve, reject) => {
            let isSettled = false;
            const settle = (error: Error | null): void => {
                if (isSettled) {
                    return;
                }
                isSettled = true;
                this.abortStart = null;
                clearTimeout(timer);
                if (error === null) {
                    resolve();
                    return;
                }
                this.dropSocket();
                reject(error);
            };
            const timer = setTimeout(
                () => settle(new Error(`OpenAI did not start the session within ${timeoutMs} ms`)),
                timeoutMs,
            );
            this.abortStart = (error) => settle(error);
            const socket = this.options.connector(connection.url, connection.headers);
            this.socket = socket;
            socket.onOpen(() => socket.send(JSON.stringify(sessionStart)));
            socket.onError((err) => {
                if (isSettled) {
                    this.finish(err);
                } else {
                    settle(err);
                }
            });
            socket.onClose((code, reason) => {
                if (isSettled) {
                    this.finish(
                        this.isClosed
                            ? null
                            : new Error(`OpenAI closed the session socket (${code} ${reason})`),
                    );
                } else {
                    settle(
                        new Error(
                            `OpenAI closed the connection during startup (${code} ${reason})`,
                        ),
                    );
                }
            });
            socket.onMessage((text) => {
                const raw = parseFrame(text);
                if (raw === null) {
                    this.options.log.warn(
                        `gpt-voice: ignored a non-JSON frame from OpenAI: ${text.slice(0, 120)}`,
                    );
                    return;
                }
                const events = this.parse(raw);
                if (!isSettled) {
                    const error = events.find((event) => event.type === "error");
                    if (error !== undefined) {
                        settle(new Error(`OpenAI rejected the session: ${describeError(error)}`));
                        return;
                    }
                    if (events.some((event) => event.type === "session-started")) {
                        settle(null);
                    }
                }
                if (events.some((event) => event.type === "session-closed")) {
                    this.isClosed = true;
                    for (const wake of this.closedWaiters.splice(0)) {
                        wake();
                    }
                }
                this.options.handlers.onEvent(raw, events);
            });
        });
    }

    /**
     * Send a frame that is already in the OpenAI Live wire format (relayed
     * from the page). Dropped once the session is closing.
     *
     * @param frame The frame.
     */
    sendWire(frame: Record<string, unknown>): void {
        if (this.isClosed) {
            return;
        }
        this.socket?.send(JSON.stringify(frame));
    }

    /**
     * Inject text into the conversation: `commentary` is said aloud
     * (paraphrased), `thinking` is silent context for later replies.
     *
     * @param delegationId The delegation the text answers, or null for session-wide context.
     * @param content The text (at most ~500 tokens per append).
     * @param channel `commentary` or `thinking`.
     */
    appendContext(
        delegationId: string | null,
        content: string,
        channel: "commentary" | "thinking",
    ): void {
        const frame = this.options.model.serializeClientEvent({
            type: "context-append",
            content,
            delegationId,
            providerOptions: { openai: { channel } },
        });
        this.sendWire(frame as Record<string, unknown>);
    }

    /**
     * End the session: send `session.close`, wait for `session.closed`
     * (final usage) up to `timeoutMs`, then drop the socket.
     *
     * @param timeoutMs Wait limit.
     */
    async close(timeoutMs = DEFAULT_CLOSE_TIMEOUT_MS): Promise<void> {
        if (this.abortStart !== null) {
            // Still starting: there is no session to close yet.
            this.abortStart(new Error("the call was hung up during setup"));
            return;
        }
        if (this.socket === null) {
            return;
        }
        if (!this.isClosed) {
            this.socket.send(
                JSON.stringify(this.options.model.serializeClientEvent({ type: "session-close" })),
            );
            await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, timeoutMs);
                this.closedWaiters.push(() => {
                    clearTimeout(timer);
                    resolve();
                });
            });
        }
        this.finish(null);
    }

    /**
     * Drop the socket and report the end of the connection, once.
     *
     * @param error Why it ended, or null for an orderly close.
     */
    private finish(error: Error | null): void {
        if (this.socket === null) {
            return;
        }
        this.dropSocket();
        this.options.handlers.onClose(error);
    }

    /** Close and forget the socket without reporting (failed startup). */
    private dropSocket(): void {
        const socket = this.socket;
        this.socket = null;
        this.isClosed = true;
        for (const wake of this.closedWaiters.splice(0)) {
            wake();
        }
        socket?.close();
    }
}

/**
 * Parse a text frame as a JSON object.
 *
 * @param text Frame text.
 * @returns The object, or null when it is not a JSON object.
 */
export function parseFrame(text: string): Record<string, unknown> | null {
    try {
        const value: unknown = JSON.parse(text);
        return value !== null && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
}

/**
 * Render a parsed `error` event for a message.
 *
 * @param event The error event.
 * @returns `code: message`.
 */
function describeError(event: Experimental_RealtimeServerEvent): string {
    if (event.type !== "error") {
        return event.type;
    }
    return event.code === undefined ? event.message : `${event.code}: ${event.message}`;
}
