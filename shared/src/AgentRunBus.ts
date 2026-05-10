import type {
    AgentRunFilter,
    AgentRunPatch,
    AgentRunRow,
    AgentRunState,
    NewAgentRun,
} from "./AgentRun.js";
import type { Logger } from "./logging/Logger.js";
import type { NotificationHandler, PostgresConnection } from "./PostgresConnection.js";
import { AGENTRUNS_CHANNEL, EVENT_TERMINAL_UPDATE_SQL, SCHEMA_SQL } from "./Schema.js";

/** Raw row shape returned by the SELECT. `pg` returns bigints as strings. */
interface RawAgentRunRow {
    id: string;
    event_id: string;
    parent_agentrun_id: string | null;
    topic: string;
    handler: string;
    priority: number;
    state: string;
    prompt: string | null;
    payload: unknown;
    result: unknown;
    result_text: string | null;
    error: string | null;
    privileged: boolean;
    retry_count: number;
    not_before: Date | null;
    model: string | null;
    system_prompt: string | null;
    created_at: Date;
    updated_at: Date;
}

/**
 * Domain client for the `agentruns` table — the assistant's response
 * tree. Each row is one agent invocation that responds to (or descends
 * from) an `events` row.
 *
 * Uses an injected {@link PostgresConnection} for pool + LISTEN access;
 * does not own connection lifecycle. Mirrors {@link EventBus} in shape:
 * `add` / `update` / `claim` / `waitAndClaim` / `waitForNext`. Listens
 * on `agentruns_changed`, which fires on INSERT and on state UPDATE.
 *
 * The terminal write goes through {@link settle}, which transitions the
 * agentrun to `done` / `failed` *and* recomputes the parent event's
 * terminal state in the same transaction. That keeps the event
 * terminal logic invariant-free — no counter to corrupt — at the cost
 * of one extra query per terminal write.
 */
export class AgentRunBus {
    private readonly connection: PostgresConnection;
    private readonly log: Logger | undefined;
    private notifyWaiters: Array<() => void> = [];
    private listenInstalled = false;
    private readonly listenHandler: NotificationHandler = (payload) => {
        this.log?.debug({ channel: AGENTRUNS_CHANNEL, payload }, "NOTIFY agentruns_changed");
        const waiters = this.notifyWaiters.splice(0);
        for (const wake of waiters) {
            wake();
        }
    };

    constructor(connection: PostgresConnection, log?: Logger) {
        this.connection = connection;
        this.log = log;
    }

    /**
     * Apply the events + agentruns schema (idempotent). The same SQL
     * bundle is consumed by {@link EventBus.installSchema}, so calling
     * either is sufficient on daemon start.
     */
    async installSchema(): Promise<void> {
        await this.connection.getPool().query(SCHEMA_SQL);
    }

    /**
     * Insert a new agentrun and return the persisted row.
     *
     * @throws If the underlying FK / check constraints reject the row
     *   (unknown `eventId`, malformed `topic`).
     */
    async add(run: NewAgentRun): Promise<AgentRunRow> {
        const result = await this.connection.getPool().query<RawAgentRunRow>(
            `INSERT INTO agentruns
                (event_id, parent_agentrun_id, topic, handler, priority, state, prompt, payload, privileged)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
             RETURNING *`,
            [
                run.eventId,
                run.parentAgentrunId ?? null,
                run.topic,
                run.handler,
                run.priority ?? 50,
                run.state ?? "pending",
                run.prompt ?? null,
                JSON.stringify(run.payload ?? {}),
                run.privileged ?? false,
            ],
        );
        return mapRow(result.rows[0]);
    }

    /**
     * Patch one or more fields on an existing agentrun by id. Always
     * bumps `updated_at`. **Do not** use this to write a terminal state
     * — use {@link settle} instead so the parent event's terminal state
     * is recomputed in the same transaction.
     */
    async update(id: string, patch: AgentRunPatch): Promise<void> {
        const sets: string[] = ["updated_at = now()"];
        const values: unknown[] = [];
        let n = 1;

        if (patch.state !== undefined) {
            sets.push(`state = $${n++}`);
            values.push(patch.state);
        }
        if (patch.payload !== undefined) {
            sets.push(`payload = $${n++}::jsonb`);
            values.push(JSON.stringify(patch.payload));
        }
        if (patch.result !== undefined) {
            sets.push(`result = $${n++}::jsonb`);
            values.push(JSON.stringify(patch.result));
        }
        if (patch.resultText !== undefined) {
            sets.push(`result_text = $${n++}`);
            values.push(patch.resultText);
        }
        if (patch.error !== undefined) {
            sets.push(`error = $${n++}`);
            values.push(patch.error);
        }
        if (patch.priority !== undefined) {
            sets.push(`priority = $${n++}`);
            values.push(patch.priority);
        }
        if (patch.model !== undefined) {
            sets.push(`model = $${n++}`);
            values.push(patch.model);
        }
        if (patch.systemPrompt !== undefined) {
            sets.push(`system_prompt = $${n++}`);
            values.push(patch.systemPrompt);
        }

        values.push(id);
        const idParam = `$${n}`;

        await this.connection
            .getPool()
            .query(`UPDATE agentruns SET ${sets.join(", ")} WHERE id = ${idParam}`, values);
    }

    /**
     * Atomically transition the highest-priority agentrun in `fromState`
     * to `toState` and return the updated row. Race-safe across multiple
     * concurrent workers via `FOR UPDATE SKIP LOCKED`.
     *
     * Returns `undefined` if no row is in `fromState`. Non-blocking — for
     * blocking semantics, use {@link waitAndClaim}.
     */
    async claim(
        fromState: AgentRunState,
        toState: AgentRunState,
    ): Promise<AgentRunRow | undefined> {
        // The `not_before IS NULL OR not_before <= now()` predicate
        // skips agentruns that AgentRunner postponed after a retryable
        // inference error. They stay `pending` but invisible to the
        // claim until their re-run window opens, freeing the watcher
        // slot for other rows in the meantime.
        const result = await this.connection.getPool().query<RawAgentRunRow>(
            `UPDATE agentruns
             SET state = $1, updated_at = now()
             WHERE id = (
               SELECT id FROM agentruns
               WHERE state = $2
                 AND (not_before IS NULL OR not_before <= now())
               ORDER BY priority DESC, id ASC
               FOR UPDATE SKIP LOCKED
               LIMIT 1
             )
             RETURNING *`,
            [toState, fromState],
        );
        return result.rows.length > 0 ? mapRow(result.rows[0]) : undefined;
    }

    /**
     * Block until an agentrun in `fromState` is available, then
     * atomically claim it (transition to `toState`) and return it.
     *
     * @throws If aborted via `signal`.
     */
    async waitAndClaim(
        fromState: AgentRunState,
        toState: AgentRunState,
        signal?: AbortSignal,
    ): Promise<AgentRunRow> {
        await this.ensureListening();

        for (;;) {
            if (signal?.aborted) {
                throw new Error("waitAndClaim aborted");
            }

            const row = await this.claim(fromState, toState);
            if (row) {
                return row;
            }

            // If any postponed rows exist, wake up at the earliest
            // `not_before` so the postponed row gets re-checked even
            // when no NOTIFY arrives in the meantime. Otherwise wait
            // for NOTIFY indefinitely (the existing pattern).
            const next = await this.nextEligibleAt();
            const maxWaitMs = next === null ? undefined : Math.max(0, next.getTime() - Date.now());
            await this.waitForNotification(signal, maxWaitMs);
        }
    }

    /**
     * Block until an agentrun matching `filter` is in the table. Returns
     * the highest-priority such row (FIFO within priority).
     *
     * Read-only; for the multi-consumer queue pattern use
     * {@link waitAndClaim}.
     *
     * @throws If aborted via `signal`.
     */
    async waitForNext(filter: AgentRunFilter = {}, signal?: AbortSignal): Promise<AgentRunRow> {
        await this.ensureListening();

        for (;;) {
            if (signal?.aborted) {
                throw new Error("waitForNext aborted");
            }

            const row = await this.queryOne(filter);
            if (row) {
                return row;
            }

            const next = await this.nextEligibleAt();
            const maxWaitMs = next === null ? undefined : Math.max(0, next.getTime() - Date.now());
            await this.waitForNotification(signal, maxWaitMs);
        }
    }

    /**
     * Terminal write for an agentrun. Transitions the row to `done` or
     * `failed`, optionally recording `result` / `resultText` / `error`,
     * and recomputes the parent event's terminal state in the **same
     * transaction**.
     *
     * The reactive event update is intentionally not a counter: it
     * relies on the `agentruns(event_id)` index to check whether any
     * sibling agentruns are still pending or running.
     */
    async settle(
        id: string,
        toState: "done" | "failed",
        outcome: {
            readonly result?: unknown;
            readonly resultText?: string | null;
            readonly error?: string | null;
        } = {},
    ): Promise<void> {
        const pool = this.connection.getPool();
        const client = await pool.connect();
        try {
            await client.query("BEGIN");

            const updated = await client.query<{ event_id: string }>(
                `UPDATE agentruns
                 SET state = $1,
                     result = COALESCE($2::jsonb, result),
                     result_text = COALESCE($3, result_text),
                     error = COALESCE($4, error),
                     updated_at = now()
                 WHERE id = $5
                 RETURNING event_id`,
                [
                    toState,
                    outcome.result === undefined ? null : JSON.stringify(outcome.result),
                    outcome.resultText ?? null,
                    outcome.error ?? null,
                    id,
                ],
            );

            if (updated.rows.length === 0) {
                await client.query("ROLLBACK");
                throw new Error(`Agentrun ${id} not found`);
            }

            const eventId = updated.rows[0].event_id;
            await client.query(EVENT_TERMINAL_UPDATE_SQL, [eventId, id, toState]);

            await client.query("COMMIT");
        } catch (err) {
            await client.query("ROLLBACK").catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    }

    /**
     * Fetch one agentrun by id, or `undefined` when missing. Mirrors
     * {@link EventBus.getById}.
     */
    async getById(id: string): Promise<AgentRunRow | undefined> {
        const result = await this.connection
            .getPool()
            .query<RawAgentRunRow>(`SELECT * FROM agentruns WHERE id = $1`, [id]);
        return result.rows.length > 0 ? mapRow(result.rows[0]) : undefined;
    }

    /**
     * Fetch all agentrun rows whose `updated_at` is `>= since`, ordered
     * by `(updated_at, id)`. Used by the polling-based report layer to
     * pick up new agentruns and state transitions without NOTIFY.
     */
    async listSince(since: Date): Promise<AgentRunRow[]> {
        const result = await this.connection.getPool().query<RawAgentRunRow>(
            `SELECT * FROM agentruns
             WHERE updated_at >= $1
             ORDER BY updated_at, id`,
            [since],
        );
        return result.rows.map(mapRow);
    }

    /**
     * Fetch all agentruns belonging to one event, ordered by id.
     * Used by the report layer to aggregate token totals and runtime
     * across an event's full agentrun tree at finalization time.
     */
    async listByEventId(eventId: string): Promise<readonly AgentRunRow[]> {
        const result = await this.connection.getPool().query<RawAgentRunRow>(
            `SELECT * FROM agentruns
             WHERE event_id = $1
             ORDER BY id`,
            [eventId],
        );
        return result.rows.map(mapRow);
    }

    /**
     * Sweep agentruns left in `running` state by a previous daemon
     * instance and settle them as `failed` with a clear marker. The
     * watcher's claim filter is `state='pending'`, so a row stuck in
     * `running` (because the daemon died mid-`agent.generate`) is
     * orphaned forever without this — the agentrun never finishes,
     * the parent event never settles, and any plugin awaiting that
     * event waits indefinitely.
     *
     * Two SQL writes in sequence:
     *   1. UPDATE every `running` agentrun → `failed` with the
     *      orphan-recovery error message.
     *   2. UPDATE every `running` event whose tree has no remaining
     *      pending/running agentruns to its terminal state (`failed`
     *      if any failed, else `done`). Mirrors the per-row logic in
     *      `EVENT_TERMINAL_UPDATE_SQL` but in bulk.
     *
     * Returns the count of agentruns that were transitioned. Safe
     * to call on every daemon start; a no-op when nothing's stuck.
     */
    async failOrphanedRunning(): Promise<number> {
        const pool = this.connection.getPool();
        const message = "daemon was restarted while this agentrun was running";
        const runs = await pool.query<{ id: string }>(
            `UPDATE agentruns
             SET state = 'failed',
                 error = COALESCE(error, $1),
                 updated_at = now()
             WHERE state = 'running'
             RETURNING id`,
            [message],
        );
        if (runs.rowCount === 0) {
            return 0;
        }
        await pool.query(
            `UPDATE events
             SET state = CASE
               WHEN EXISTS (
                 SELECT 1 FROM agentruns
                 WHERE event_id = events.id
                   AND state IN ('pending', 'running')
               ) THEN state
               WHEN EXISTS (
                 SELECT 1 FROM agentruns
                 WHERE event_id = events.id
                   AND state = 'failed'
               ) THEN 'failed'
               ELSE 'done'
             END,
             updated_at = now()
             WHERE state = 'running'`,
        );
        return runs.rowCount ?? 0;
    }

    /**
     * Postpone an agentrun after a retryable inference error.
     * Returns the row to `pending`, bumps `retry_count`, sets
     * `not_before` to the supplied timestamp, and records the latest
     * attempt's error text. The existing `agentruns_changed` UPDATE
     * trigger fires on the state write so any watcher waiting on
     * NOTIFY wakes up — it just won't be able to claim the row again
     * until `not_before` passes.
     *
     * Throws if the row is missing (mirrors {@link settle}).
     */
    async postpone(id: string, runAfter: Date, errorText: string | null): Promise<void> {
        const result = await this.connection.getPool().query(
            `UPDATE agentruns
             SET state = 'pending',
                 retry_count = retry_count + 1,
                 not_before = $2,
                 error = $3,
                 updated_at = now()
             WHERE id = $1`,
            [id, runAfter, errorText],
        );
        if (result.rowCount === 0) {
            throw new Error(`Agentrun ${id} not found`);
        }
    }

    /**
     * Earliest `not_before` among `pending` agentruns whose window
     * hasn't opened yet. Returns `null` when nothing is parked.
     * Used by {@link waitAndClaim} to put a ceiling on the wait so
     * a postponed row gets re-checked even if no new INSERT or
     * state update wakes the listener.
     */
    async nextEligibleAt(): Promise<Date | null> {
        const result = await this.connection.getPool().query<{ next: Date | null }>(
            `SELECT MIN(not_before) AS next
             FROM agentruns
             WHERE state = 'pending'
               AND not_before IS NOT NULL
               AND not_before > now()`,
        );
        return result.rows[0]?.next ?? null;
    }

    /** Subscribe this bus's wake-handler to {@link AGENTRUNS_CHANNEL}. */
    private async ensureListening(): Promise<void> {
        if (this.listenInstalled) {
            return;
        }
        this.listenInstalled = true;
        await this.connection.listen(AGENTRUNS_CHANNEL, this.listenHandler);
    }

    /**
     * Resolve as soon as the next NOTIFY arrives, `signal` aborts, or
     * `maxWaitMs` elapses (when supplied). The timeout exists so a
     * watcher waiting on a postponed row's `not_before` wakes up to
     * re-check eligibility even if no INSERT or state update fires
     * NOTIFY in the meantime.
     */
    private waitForNotification(signal?: AbortSignal, maxWaitMs?: number): Promise<void> {
        return new Promise((resolve, reject) => {
            let timer: NodeJS.Timeout | undefined;
            const wake = () => {
                if (timer) {
                    clearTimeout(timer);
                }
                if (signal) {
                    signal.removeEventListener("abort", onAbort);
                }
                resolve();
            };
            const onAbort = () => {
                if (timer) {
                    clearTimeout(timer);
                }
                this.notifyWaiters = this.notifyWaiters.filter((w) => w !== wake);
                reject(new Error("waitForNext aborted"));
            };

            this.notifyWaiters.push(wake);
            if (signal) {
                signal.addEventListener("abort", onAbort, { once: true });
            }
            if (maxWaitMs !== undefined && maxWaitMs >= 0) {
                timer = setTimeout(() => {
                    this.notifyWaiters = this.notifyWaiters.filter((w) => w !== wake);
                    if (signal) {
                        signal.removeEventListener("abort", onAbort);
                    }
                    resolve();
                }, maxWaitMs);
            }
        });
    }

    /** Single SELECT for the highest-priority matching agentrun. */
    private async queryOne(filter: AgentRunFilter): Promise<AgentRunRow | undefined> {
        const states = filter.states ?? ["pending"];
        const conditions: string[] = ["state = ANY($1)"];
        const values: unknown[] = [states];
        let n = 2;

        if (filter.topics && filter.topics.length > 0) {
            conditions.push(`topic = ANY($${n++})`);
            values.push(filter.topics);
        }

        // Mirror `claim`'s not_before gating so blocking observers
        // (waitForNext) don't return rows that aren't yet eligible.
        conditions.push("(not_before IS NULL OR not_before <= now())");

        const result = await this.connection.getPool().query<RawAgentRunRow>(
            `SELECT * FROM agentruns
             WHERE ${conditions.join(" AND ")}
             ORDER BY priority DESC, id ASC
             LIMIT 1`,
            values,
        );

        return result.rows.length > 0 ? mapRow(result.rows[0]) : undefined;
    }
}

/**
 * Convert a snake_case raw row into the camelCase {@link AgentRunRow}.
 * `state` is trusted to be a known {@link AgentRunState} (we control
 * every writer).
 */
function mapRow(raw: RawAgentRunRow): AgentRunRow {
    return {
        id: raw.id,
        eventId: raw.event_id,
        parentAgentrunId: raw.parent_agentrun_id,
        topic: raw.topic,
        handler: raw.handler,
        priority: raw.priority,
        state: raw.state as AgentRunState,
        prompt: raw.prompt,
        payload: raw.payload,
        result: raw.result,
        resultText: raw.result_text,
        error: raw.error,
        privileged: raw.privileged,
        retryCount: raw.retry_count,
        notBefore: raw.not_before,
        model: raw.model,
        systemPrompt: raw.system_prompt,
        createdAt: raw.created_at,
        updatedAt: raw.updated_at,
    };
}
