/**
 * Lifecycle states for an `agentruns` row.
 *
 * Each agentrun is a single agent invocation that responds to (or
 * descends from) an `events` row. Transitions:
 *
 * - `pending`: just inserted; waiting for the agentrun watcher.
 * - `running`: claimed by the agentrun watcher (atomic
 *   `pending → running` via {@link AgentRunBus.claim}).
 * - `done` / `failed`: terminal. Set by {@link AgentRunBus.settle},
 *   which also recomputes the parent event's terminal state in the
 *   same transaction.
 */
export type AgentRunState = "pending" | "running" | "done" | "failed";

/**
 * Shape of a row in the `agentruns` table after JSON-decoding from
 * postgres. `id`, `eventId`, and `parentAgentrunId` are kept as strings
 * because postgres `bigint` exceeds JavaScript's safe integer range.
 */
export interface AgentRunRow {
    /** Database primary key (bigint as string). */
    readonly id: string;
    /** FK to {@link EventRow.id} — the root event this tree responds to. */
    readonly eventId: string;
    /**
     * FK to another {@link AgentRunRow.id}, or `null` for the root
     * agentrun of an event. Forms the response tree.
     */
    readonly parentAgentrunId: string | null;
    /**
     * Topic copied from the originating event at queue time. Combined
     * with {@link handler} to resolve a workspace markdown file.
     */
    readonly topic: string;
    /**
     * Basename of the handler file in the workspace (e.g. `index`,
     * `analyze`). Resolution rules — for topic `chat:whatsapp` and
     * handler `analyze`:
     *   1. `workspace/chat/whatsapp/analyze.md`
     *   2. fallback `workspace/chat/analyze.md`
     */
    readonly handler: string;
    /**
     * Higher = processed first within a queue. Inherited from the
     * originating event at spawn; constant per row for now.
     */
    readonly priority: number;
    /** Lifecycle state — see {@link AgentRunState}. */
    readonly state: AgentRunState;
    /** Optional prompt seed supplied by the queueing caller. */
    readonly prompt: string | null;
    /** Spawn-time inputs from the calling agent (or the root event). */
    readonly payload: unknown;
    /** Structured terminal output (arbitrary JSON) when the run reaches `done` / `failed`. */
    readonly result: unknown;
    /**
     * The agent's final text output. Populated by the agentrun watcher
     * on success. Distinct from {@link result} so callers (notably
     * `HostContext.events.emit`'s await-and-return path) have a
     * typed, dedicated text channel without rummaging in JSON.
     */
    readonly resultText: string | null;
    /** Error message when state is `failed`. */
    readonly error: string | null;
    /** Insert timestamp — postgres `now()` at INSERT. */
    readonly createdAt: Date;
    /** Last update timestamp — bumped to `now()` on every update. */
    readonly updatedAt: Date;
}

/** Input shape for {@link AgentRunBus.add}. */
export interface NewAgentRun {
    /** FK to the root event. Required. */
    readonly eventId: string;
    /** FK to the parent agentrun, or omitted/null for the root agentrun. */
    readonly parentAgentrunId?: string | null;
    /** Topic copied from the event. Required. */
    readonly topic: string;
    /** Handler basename (e.g. `index`). Required. */
    readonly handler: string;
    /** Defaults to 50; usually inherited from the event. */
    readonly priority?: number;
    /** Initial state; default `"pending"`. */
    readonly state?: AgentRunState;
    /** Optional prompt seed. */
    readonly prompt?: string | null;
    /** Optional spawn-time payload. */
    readonly payload?: unknown;
}

/** Patch shape for {@link AgentRunBus.update}. */
export interface AgentRunPatch {
    readonly state?: AgentRunState;
    readonly payload?: unknown;
    readonly result?: unknown;
    readonly resultText?: string | null;
    readonly error?: string | null;
    readonly priority?: number;
}

/** Filter for {@link AgentRunBus.waitForNext}. */
export interface AgentRunFilter {
    readonly topics?: readonly string[];
    readonly states?: readonly AgentRunState[];
}
