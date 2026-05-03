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
}

/** Patch shape for {@link EventBus.update}. */
export interface EventPatch {
    readonly state?: EventState;
    readonly payload?: unknown;
    readonly priority?: number;
}

/** Filter for {@link EventBus.waitForNext}. */
export interface EventFilter {
    /** If set, only events whose topic is in this list will match. */
    readonly topics?: readonly string[];
    /** If set, only events in one of these states match (default `["pending"]`). */
    readonly states?: readonly EventState[];
}
