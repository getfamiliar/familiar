/**
 * Lifecycle states an event can be in.
 *
 * Each event row runs through one of two lifecycles:
 *
 * - **Input events** (everything ingested by the host): `pending` →
 *   `triaging` → `done`. The triage worker owns this. It does *not*
 *   transition input events to supervisor states; instead, when a
 *   plugin's triage decides supervision is needed, it inserts one or
 *   more *new* events with state `supervisor-ready`. Multiple plugins
 *   triaging the same input can spawn multiple supervisor jobs.
 * - **Supervisor jobs** (spawned by triage): `supervisor-ready` →
 *   `supervising` → `done`.
 *
 * Any state can transition to `failed` on error.
 *
 * State changes between worker stages (`pending → triaging`,
 * `supervisor-ready → supervising`) are atomic via {@link EventBus.claim}.
 * Terminal transitions (`done` / `failed`) are explicit `update(...)`
 * calls by the worker that owns the row.
 */
export type EventState =
    | "pending"
    | "triaging"
    | "supervisor-ready"
    | "supervising"
    | "done"
    | "failed";

/**
 * Shape of a row in the `events` table after JSON-decoding from postgres.
 * The numeric `id` and `causationChain` entries are kept as strings because
 * postgres `bigint` exceeds JavaScript's safe integer range.
 */
export interface EventRow {
    /**
     * Database primary key. `bigserial` is returned as a string because
     * postgres `bigint` exceeds JavaScript's safe integer range.
     */
    readonly id: string;
    /**
     * Hierarchical event name, dot-separated (e.g. `mail.received`,
     * `chat.message.sent`). Used by triage / watchers for routing.
     */
    readonly topic: string;
    /**
     * Higher = processed first within a queue. FIFO within priority.
     * Default 50.
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
     * Prompt the supervisor uses for this event. Set by triage when it
     * spawns a `supervisor-ready` job; `null` for input events and any
     * row that has no supervisor session attached.
     */
    readonly supervisorPrompt: string | null;
    /**
     * Globally unique key for dedup. `null` when the producer didn't
     * supply one (then no dedup happens).
     */
    readonly idempotencyKey: string | null;
    /**
     * IDs of the events that caused this one (lineage; index 0 is the
     * root). Used by the hop counter to prevent runaway chains.
     */
    readonly causationChain: readonly string[];
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
    /** IDs of the events that caused this one (for lineage). */
    readonly causationChain?: readonly string[];
    /** Prompt for the supervisor. Required when `state` is `supervisor-ready`. */
    readonly supervisorPrompt?: string;
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
