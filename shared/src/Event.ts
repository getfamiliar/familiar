/**
 * Lifecycle states for an `events` row.
 *
 * Events are the immutable record of "the world said this happened".
 * They no longer participate in any worker state machine themselves —
 * the actual work runs in `agentruns` rows that reference the event.
 *
 * Transitions:
 *
 * - `pending`: row inserted by a host plugin via {@link EventBus.add}.
 * - `running`: the container's input-event watcher has spawned the root
 *   agentrun for this event.
 * - `done` / `failed`: set reactively when the last `pending` /
 *   `running` agentrun for this event settles. `failed` wins if any
 *   agentrun for the event has failed.
 */
export type EventState = "pending" | "running" | "done" | "failed";

/**
 * Shape of a row in the `events` table after JSON-decoding from postgres.
 * The numeric `id` is kept as a string because postgres `bigint` exceeds
 * JavaScript's safe integer range.
 */
export interface EventRow {
    /**
     * Database primary key. `bigserial` is returned as a string because
     * postgres `bigint` exceeds JavaScript's safe integer range.
     */
    readonly id: string;
    /**
     * Event topic, matching `\w+(:\w+)?` (e.g. `mail`, `chat:whatsapp`).
     * Resolved to a handler file by the container at runtime.
     */
    readonly topic: string;
    /**
     * Higher = processed first within a queue. FIFO within priority.
     * Default 50. Inherited by all agentruns spawned for this event.
     */
    readonly priority: number;
    /** Lifecycle state — see {@link EventState}. */
    readonly state: EventState;
    /**
     * Event-specific data; arbitrary JSON. Schema is owned by the
     * producing plugin / topic, not by the bus.
     */
    readonly payload: unknown;
    /**
     * Globally unique key for dedup. `null` when the producer didn't
     * supply one (then no dedup happens).
     */
    readonly idempotencyKey: string | null;
    /**
     * Whether this event is a chat message from the user. When `true`,
     * `EventBus.add` persists `payload.text` into `chatmessages` (role
     * `'user'`) in the same transaction as the event INSERT.
     */
    readonly isChat: boolean;
    /**
     * Channel the assistant should reply on (e.g. `"cli"`, `"telegram"`).
     * Stamped host-side at emit time, falling back to
     * `DEFAULT_CHAT_CHANNEL_ID`. The container never reads this field;
     * routing happens via JOIN in the chatmessages trigger and in
     * `ChatMessageBus`. May be `null` for non-chat events whose source
     * plugin didn't set a default routing target.
     */
    readonly preferredChatChannelId: string | null;
    /** Insert timestamp — postgres `now()` at INSERT. */
    readonly createdAt: Date;
    /** Last `update()` timestamp — bumped to `now()` on every update. */
    readonly updatedAt: Date;
}

/** Input shape for {@link EventBus.add}. */
export interface NewEvent {
    readonly topic: string;
    readonly payload?: unknown;
    /** Higher = processed first; default 50. */
    readonly priority?: number;
    /** Initial state; default `"pending"`. */
    readonly state?: EventState;
    /** Globally unique key for dedup; null = no dedup. */
    readonly idempotencyKey?: string;
    /**
     * Mark this event as a chat message from the user. When `true`,
     * `payload` MUST be an object with a `text: string` field;
     * `EventBus.add` will persist that text to `chatmessages` (role
     * `'user'`) in the same transaction. Default `false`.
     */
    readonly isChat?: boolean;
    /**
     * Channel id the assistant should reply on. Plugins typically set
     * this to their own channel name (e.g. `"cli"`). When omitted, the
     * host's `HostContextImpl.emit` stamps `DEFAULT_CHAT_CHANNEL_ID`.
     */
    readonly preferredChatChannelId?: string | null;
}

/** Patch shape for {@link EventBus.update}. */
export interface EventPatch {
    readonly state?: EventState;
    readonly payload?: unknown;
    readonly priority?: number;
    readonly preferredChatChannelId?: string | null;
}

/** Filter for {@link EventBus.waitForNext}. */
export interface EventFilter {
    /** If set, only events whose topic is in this list will match. */
    readonly topics?: readonly string[];
    /** If set, only events in one of these states match (default `["pending"]`). */
    readonly states?: readonly EventState[];
}
