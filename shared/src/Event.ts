/**
 * Shape of a row in the `events` table after JSON-decoding from postgres.
 * The numeric `id` and `causationChain` entries are kept as strings because
 * postgres `bigint` exceeds JavaScript's safe integer range.
 */
export interface EventRow {
    readonly id: string;
    readonly topic: string;
    readonly priority: number;
    readonly state: string;
    readonly payload: unknown;
    readonly idempotencyKey: string | null;
    readonly causationChain: readonly string[];
    readonly createdAt: Date;
    readonly updatedAt: Date;
}

/** Input shape for {@link EventBus.add}. */
export interface NewEvent {
    readonly topic: string;
    readonly payload?: unknown;
    /** Higher = processed first; default 50. */
    readonly priority?: number;
    /** Initial state; default `"pending"`. */
    readonly state?: string;
    /** Globally unique key for dedup; null = no dedup. */
    readonly idempotencyKey?: string;
    /** IDs of the events that caused this one (for lineage). */
    readonly causationChain?: readonly string[];
}

/** Patch shape for {@link EventBus.update}. */
export interface EventPatch {
    readonly state?: string;
    readonly payload?: unknown;
    readonly priority?: number;
}

/** Filter for {@link EventBus.waitForNext}. */
export interface EventFilter {
    /** If set, only events whose topic is in this list will match. */
    readonly topics?: readonly string[];
    /** If set, only events in one of these states match (default `["pending"]`). */
    readonly states?: readonly string[];
}
