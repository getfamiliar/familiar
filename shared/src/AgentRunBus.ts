import type {
    AgentRunFilter,
    AgentRunPatch,
    AgentRunRow,
    AgentRunState,
    NewAgentRun,
} from "./AgentRun";
import type { NotificationHandler, PostgresConnection } from "./PostgresConnection";
import { AGENTRUNS_CHANNEL, EVENT_TERMINAL_UPDATE_SQL, SCHEMA_SQL } from "./Schema";

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
    error: string | null;
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
    private notifyWaiters: Array<() => void> = [];
    private listenInstalled = false;
    private readonly listenHandler: NotificationHandler = () => {
        const waiters = this.notifyWaiters.splice(0);
        for (const wake of waiters) {
            wake();
        }
    };

    constructor(connection: PostgresConnection) {
        this.connection = connection;
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
                (event_id, parent_agentrun_id, topic, handler, priority, state, prompt, payload)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
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
        if (patch.error !== undefined) {
            sets.push(`error = $${n++}`);
            values.push(patch.error);
        }
        if (patch.priority !== undefined) {
            sets.push(`priority = $${n++}`);
            values.push(patch.priority);
        }

        values.push(id);
        const idParam = `$${n}`;

        await this.connection.getPool().query(
            `UPDATE agentruns SET ${sets.join(", ")} WHERE id = ${idParam}`,
            values,
        );
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
        const result = await this.connection.getPool().query<RawAgentRunRow>(
            `UPDATE agentruns
             SET state = $1, updated_at = now()
             WHERE id = (
               SELECT id FROM agentruns
               WHERE state = $2
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

            await this.waitForNotification(signal);
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
    async waitForNext(
        filter: AgentRunFilter = {},
        signal?: AbortSignal,
    ): Promise<AgentRunRow> {
        await this.ensureListening();

        for (;;) {
            if (signal?.aborted) {
                throw new Error("waitForNext aborted");
            }

            const row = await this.queryOne(filter);
            if (row) {
                return row;
            }

            await this.waitForNotification(signal);
        }
    }

    /**
     * Terminal write for an agentrun. Transitions the row to `done` or
     * `failed`, optionally recording `result` / `error`, and recomputes
     * the parent event's terminal state in the **same transaction**.
     *
     * The reactive event update is intentionally not a counter: it
     * relies on the `agentruns(event_id)` index to check whether any
     * sibling agentruns are still pending or running.
     */
    async settle(
        id: string,
        toState: "done" | "failed",
        outcome: { readonly result?: unknown; readonly error?: string | null } = {},
    ): Promise<void> {
        const pool = this.connection.getPool();
        const client = await pool.connect();
        try {
            await client.query("BEGIN");

            const updated = await client.query<{ event_id: string }>(
                `UPDATE agentruns
                 SET state = $1,
                     result = COALESCE($2::jsonb, result),
                     error = COALESCE($3, error),
                     updated_at = now()
                 WHERE id = $4
                 RETURNING event_id`,
                [
                    toState,
                    outcome.result === undefined ? null : JSON.stringify(outcome.result),
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

    /** Subscribe this bus's wake-handler to {@link AGENTRUNS_CHANNEL}. */
    private async ensureListening(): Promise<void> {
        if (this.listenInstalled) {
            return;
        }
        this.listenInstalled = true;
        await this.connection.listen(AGENTRUNS_CHANNEL, this.listenHandler);
    }

    /** Resolve as soon as the next NOTIFY arrives or `signal` aborts. */
    private waitForNotification(signal?: AbortSignal): Promise<void> {
        return new Promise((resolve, reject) => {
            const wake = () => {
                if (signal) {
                    signal.removeEventListener("abort", onAbort);
                }
                resolve();
            };
            const onAbort = () => {
                this.notifyWaiters = this.notifyWaiters.filter((w) => w !== wake);
                reject(new Error("waitForNext aborted"));
            };

            this.notifyWaiters.push(wake);
            if (signal) {
                signal.addEventListener("abort", onAbort, { once: true });
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
        error: raw.error,
        createdAt: raw.created_at,
        updatedAt: raw.updated_at,
    };
}
