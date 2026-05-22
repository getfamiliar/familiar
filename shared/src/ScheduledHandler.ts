/**
 * A persisted row in `scheduled_handlers` — one future one-off wake-up
 * the agent has asked the host to fire. Only produced when the agent
 * called `schedule_handler` with a future `when`; without `when`, the
 * tool inserts a child agentrun directly instead and never touches
 * this table. Lifecycle:
 *
 * 1. Container's `schedule_handler` tool upserts (on `key`) a row with
 *    `fireAt` in UTC, copying the calling agentrun's `priority` and
 *    `privileged` flag.
 * 2. Host's `ScheduledHandlerScheduler` reacts to the
 *    `scheduled_handlers_changed` NOTIFY and installs a Croner job for
 *    `fireAt` with `maxRuns: 1`.
 * 3. When the job fires, the host atomically claims-and-deletes the
 *    row, then emits a fresh event with the row's topic / handler /
 *    prompt / payload / priority / privileged.
 *
 * `prompt` is optional at the table level so the agent can schedule
 * "the handler knows what to do" wake-ups; the firing path supplies
 * a generic default (`Scheduled handler fired`) before calling
 * `EventBus.add`, which requires a non-empty prompt.
 */
export interface ScheduledHandlerRow {
    /** Agent-supplied unique id. UPSERT target. */
    readonly key: string;
    /** UTC ISO-8601 firing time (e.g. `2026-05-21T13:00:00Z`). */
    readonly fireAt: string;
    readonly topic: string;
    readonly handler: string;
    readonly prompt: string | null;
    readonly payload: unknown;
    readonly priority: number;
    readonly privileged: boolean;
    readonly createdAt: Date;
}

/**
 * Insert shape for {@link ScheduledHandlerBus.upsert}. Mirrors
 * {@link ScheduledHandlerRow} minus `createdAt` (filled by the DB).
 */
export interface NewScheduledHandler {
    readonly key: string;
    readonly fireAt: string;
    readonly topic: string;
    readonly handler: string;
    readonly prompt?: string | null;
    readonly payload?: unknown;
    readonly priority?: number;
    readonly privileged?: boolean;
}
