import type {
    AgentRunCallType,
    AgentRunPatch,
    AgentRunRow,
    AgentRunState,
    NewAgentRun,
} from "./AgentRun.js";
import type { Logger } from "./logging/Logger.js";
import type { NotificationHandler, PostgresConnection } from "./PostgresConnection.js";
import { AGENTRUNS_CHANNEL, EVENT_TERMINAL_UPDATE_SQL, SCHEMA_SQL } from "./Schema.js";

/**
 * Disposer returned by {@link AgentRunBus.listen}. Calling it
 * unsubscribes the handler from the underlying NOTIFY channel.
 * Idempotent: calling more than once is safe.
 */
export type AgentRunUnsubscribe = () => Promise<void>;

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
    calltype: string | null;
    retry_count: number;
    not_before: Date | null;
    model: string | null;
    system_prompt: string | null;
    initial_messages: unknown;
    created_at: Date;
    updated_at: Date;
}

/**
 * Domain client for the `agentruns` table — the assistant's response
 * tree. Each row is one agent invocation that responds to (or descends
 * from) an `events` row.
 *
 * Uses an injected {@link PostgresConnection} for pool + LISTEN access;
 * does not own connection lifecycle.
 *
 * The bus is purely a CRUD surface — no claim queue, no in-process
 * blocking primitive. The {@link import("@getfamiliar/container").AgentrunScheduler}
 * is the sole authority on which row runs next and is guaranteed
 * singleton inside the container, so a postgres-side claim queue
 * (`FOR UPDATE SKIP LOCKED`) would be overkill. The Scheduler reads
 * eligible pending rows via {@link listEligible} and writes lifecycle
 * transitions via {@link update} / {@link settle} / {@link postpone}.
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
     *   (unknown `eventId`, malformed `topic`, invalid `calltype`).
     */
    async add(run: NewAgentRun): Promise<AgentRunRow> {
        const result = await this.connection.getPool().query<RawAgentRunRow>(
            `INSERT INTO agentruns
                (event_id, parent_agentrun_id, topic, handler, priority, state, prompt, payload, privileged, calltype)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
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
                run.calltype ?? null,
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
        if (patch.initialMessages !== undefined) {
            sets.push(`initial_messages = $${n++}::jsonb`);
            values.push(JSON.stringify(patch.initialMessages));
        }
        if (patch.calltype !== undefined) {
            sets.push(`calltype = $${n++}`);
            values.push(patch.calltype);
        }

        values.push(id);
        const idParam = `$${n}`;

        await this.connection
            .getPool()
            .query(`UPDATE agentruns SET ${sets.join(", ")} WHERE id = ${idParam}`, values);
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
     * Fetch one agentrun by id, or `undefined` when missing.
     */
    async getById(id: string): Promise<AgentRunRow | undefined> {
        const result = await this.connection
            .getPool()
            .query<RawAgentRunRow>(`SELECT * FROM agentruns WHERE id = $1`, [id]);
        return result.rows.length > 0 ? mapRow(result.rows[0]) : undefined;
    }

    /**
     * Fetch every agentrun in `state='pending'` whose `not_before` window
     * has opened, in dispatch order (`priority desc, id asc`). The
     * {@link AgentrunScheduler} calls this once per scheduling pass.
     *
     * Returns an empty array when nothing is ready. The Scheduler then
     * waits on its NOTIFY subscription or a parked `not_before` timer
     * before re-checking.
     */
    async listEligible(): Promise<readonly AgentRunRow[]> {
        const result = await this.connection.getPool().query<RawAgentRunRow>(
            `SELECT * FROM agentruns
             WHERE state = 'pending'
               AND (not_before IS NULL OR not_before <= now())
             ORDER BY priority DESC, id ASC`,
        );
        return result.rows.map(mapRow);
    }

    /**
     * `true` when every `calltype='started'` child of `parentId` is in
     * a terminal state (`done` / `failed`). Used by the Scheduler
     * after a started child settles, to decide whether the parent can
     * leave `waiting` and go back to `pending`.
     *
     * Returns `true` when there are no started children at all (the
     * trivially-vacuous case); the Scheduler still owns the "should
     * we actually re-pend this parent?" decision and only invokes
     * this method when at least one started child has just settled.
     */
    async areAllStartedChildrenSettled(parentId: string): Promise<boolean> {
        const result = await this.connection.getPool().query<{ exists: boolean }>(
            `SELECT EXISTS (
               SELECT 1 FROM agentruns
               WHERE parent_agentrun_id = $1
                 AND calltype = 'started'
                 AND state NOT IN ('done','failed')
             ) AS exists`,
            [parentId],
        );
        return result.rows[0]?.exists === false;
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
     * Postpone an agentrun after a retryable inference error.
     * Returns the row to `pending`, bumps `retry_count`, sets
     * `not_before` to the supplied timestamp, and records the latest
     * attempt's error text. The existing `agentruns_changed` UPDATE
     * trigger fires on the state write so a NOTIFY-subscribed
     * Scheduler wakes up — it just won't include the row in
     * {@link listEligible} until `not_before` passes.
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
     * Subscribe to {@link AGENTRUNS_CHANNEL}. The notification payload
     * (`<event_id>:<id>`) is parsed, the row is fetched by id, and
     * `handler` is invoked with it. Fires on both INSERT and state
     * UPDATE — callers that only care about one transition must filter
     * on `row.state` themselves.
     *
     * Errors thrown by `handler` are caught and logged so one bad
     * subscriber doesn't break others on the same channel.
     *
     * Returns a disposer; call it to unlisten. Idempotent.
     *
     * The {@link AgentrunScheduler} subscribes via
     * {@link PostgresConnection.listen} directly (it only needs a
     * "something changed" wake hint, not full row fetches); this
     * helper exists for host-side consumers like
     * `HostContext.events.emit`'s `onAgentRun` callback.
     */
    async listen(
        handler: (row: AgentRunRow) => void | Promise<void>,
    ): Promise<AgentRunUnsubscribe> {
        const wrapper: NotificationHandler = (payload) => {
            this.log?.debug({ channel: AGENTRUNS_CHANNEL, payload }, "NOTIFY agentruns_changed");
            void this.dispatchNotification(payload, handler);
        };
        await this.connection.listen(AGENTRUNS_CHANNEL, wrapper);

        let disposed = false;
        return async () => {
            if (disposed) {
                return;
            }
            disposed = true;
            await this.connection.unlisten(AGENTRUNS_CHANNEL, wrapper);
        };
    }

    /**
     * Inner notification dispatcher for {@link listen}. Parses the
     * channel payload (`<event_id>:<id>`), fetches the row by id, and
     * invokes the handler — catching and logging any error from the
     * handler itself.
     */
    private async dispatchNotification(
        payload: string,
        handler: (row: AgentRunRow) => void | Promise<void>,
    ): Promise<void> {
        // Payload format: `<event_id>:<agent_run_id>` (see Schema.ts
        // `agentruns_notify_changed`). A malformed payload is a
        // strong signal that the deployed trigger function is out of
        // sync with the source — surface it loudly instead of
        // silently dropping notifications and leaving the caller's
        // spinner stuck forever.
        const colon = payload.indexOf(":");
        if (colon < 0) {
            const warning = `AgentRunBus: malformed ${AGENTRUNS_CHANNEL} payload (no colon): "${payload}" — is the agentruns_notify_changed trigger function out of date? Restart the daemon to reinstall the schema.`;
            if (this.log) {
                this.log.warn({ payload }, warning);
            } else {
                console.warn(warning);
            }
            return;
        }
        const id = payload.slice(colon + 1);
        try {
            const row = await this.getById(id);
            if (!row) {
                const warning = `AgentRunBus: no agentrun found for id="${id}" (payload="${payload}") — stale or malformed NOTIFY payload?`;
                if (this.log) {
                    this.log.warn({ id, payload }, warning);
                } else {
                    console.warn(warning);
                }
                return;
            }
            await handler(row);
        } catch (err) {
            this.log?.error(
                { id, err: err instanceof Error ? err.message : String(err) },
                "AgentRunBus listen handler error",
            );
        }
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
        calltype:
            raw.calltype === "scheduled" || raw.calltype === "started"
                ? (raw.calltype as AgentRunCallType)
                : null,
        retryCount: raw.retry_count,
        notBefore: raw.not_before,
        model: raw.model,
        systemPrompt: raw.system_prompt,
        initialMessages: raw.initial_messages,
        createdAt: raw.created_at,
        updatedAt: raw.updated_at,
    };
}
