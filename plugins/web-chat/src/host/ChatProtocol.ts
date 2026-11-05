/**
 * Wire format between the web-chat controller and its page. Types only:
 * the page imports them with `import type`, so nothing of the host side
 * ends up in the browser bundle.
 */

/** Channel id of the web chat (`events.preferred_chat_channel_id`). */
export const WEB_CHAT_CHANNEL = "web";

/** Topic of plain web chat messages (direct handler calls carry their own). */
export const WEB_CHAT_TOPIC = "chat:web";

/** Commands the page handles itself (not sent to the server). */
export const WEB_CHAT_BUILTINS = ["/clear"] as const;

/** One stored chat message. */
export interface ChatMessageDto {
    /** Message id (bigint as string); increases with insertion order. */
    readonly id: string;
    /** Event the message belongs to. */
    readonly eventId: string;
    readonly role: "user" | "assistant";
    readonly text: string;
    /** ISO timestamp. */
    readonly createdAt: string;
}

/** Lifecycle of one agentrun of a turn. */
export interface ChatRunDto {
    readonly id: string;
    readonly parentId: string | null;
    readonly topic: string;
    /** Resolved `<provider>/<model>`, once known. */
    readonly model: string | null;
    readonly state: "pending" | "running" | "waiting" | "done" | "failed";
    readonly error: string | null;
}

/** One tool call of a step (a `tool_call` proxy call shows its target). */
export interface ChatToolCallDto {
    readonly id: string;
    readonly name: string;
    /** Truncated JSON of the arguments. */
    readonly input: string;
    /** Truncated output or error text, once the step finished. */
    readonly output: string | null;
    readonly isError: boolean;
}

/** One finished model step of an agentrun. */
export interface ChatStepDto {
    readonly agentRunId: string;
    /** 1-based step number within the agentrun. */
    readonly stepNumber: number;
    readonly reasoning: string | null;
    readonly text: string | null;
    readonly tools: readonly ChatToolCallDto[];
}

/** A message the user sent from the web chat and its progress. */
export interface ChatTurnDto {
    readonly eventId: string;
    readonly state: "running" | "done" | "failed";
    readonly runs: readonly ChatRunDto[];
    readonly steps: readonly ChatStepDto[];
    /** Failure text when `state` is `failed`. */
    readonly error: string | null;
}

/** Answer of `GET /api/messages`. */
export interface ChatHistoryDto {
    /** Oldest first. */
    readonly messages: readonly ChatMessageDto[];
    /** Whether older messages exist (pass the first id as `before`). */
    readonly hasMore: boolean;
}

/** Answer of `GET /api/handlers`. */
export interface ChatHandlersDto {
    /** Slash paths of the direct-callable handlers (`/mail/draft`). */
    readonly handlers: readonly string[];
    /** Commands the page handles itself. */
    readonly builtins: readonly string[];
}

/** Answer of `POST /api/messages`. */
export type ChatSendResultDto = { readonly eventId: string } | { readonly error: string };

/** Server-sent events of `GET /api/events`. */
export type ChatServerEvent =
    /** First event of a stream: the turns in flight. */
    | { readonly type: "snapshot"; readonly turns: readonly ChatTurnDto[] }
    /** A message was stored on the web channel (both roles). */
    | { readonly type: "message"; readonly message: ChatMessageDto }
    /** A turn changed (full state). */
    | { readonly type: "turn"; readonly turn: ChatTurnDto };
