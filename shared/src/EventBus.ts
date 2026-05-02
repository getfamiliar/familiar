import type { EventFilter, EventPatch, EventRow, EventState, NewEvent } from "./Event";
import type { NotificationHandler, PostgresConnection } from "./PostgresConnection";
import { EVENTS_NOTIFY_CHANNEL, EVENTS_SCHEMA_SQL } from "./Schema";

/** Raw row shape returned by the SELECT. `pg` returns bigints as strings. */
interface RawEventRow {
    id: string;
    topic: string;
    priority: number;
    state: string;
    payload: unknown;
    supervisor_prompt: string | null;
    idempotency_key: string | null;
    causation_chain: string[] | null;
    created_at: Date;
    updated_at: Date;
}

/**
 * Domain client for the `events` table that backs the host ↔ container bus.
 *
 * Uses an injected {@link PostgresConnection} for pool + LISTEN access;
 * does not own connection lifecycle. Several `EventBus` instances can
 * share a connection, and the connection can be reused by other domain
 * clients (e.g. a future `PendingActionsBus`) without opening more
 * sockets.
 *
 * `waitForNext()` does an initial query before sleeping on the listen
 * channel, so events that already existed when the call started are
 * picked up immediately.
 *
 * The bus is *not* a multi-consumer queue: two waiters may observe the
 * same event. Caller is responsible for transitioning state via
 * {@link update} after handling.
 */
export class EventBus {
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

    /** Apply the events schema (idempotent). Safe to call on every daemon start. */
    async installSchema(): Promise<void> {
        await this.connection.getPool().query(EVENTS_SCHEMA_SQL);
    }

    /**
     * Insert a new event and return the persisted row.
     *
     * @throws If `idempotencyKey` collides with an existing event.
     */
    async add(event: NewEvent): Promise<EventRow> {
        const result = await this.connection.getPool().query<RawEventRow>(
            `INSERT INTO events
                (topic, payload, priority, state, supervisor_prompt, idempotency_key, causation_chain)
             VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7::bigint[])
             RETURNING *`,
            [
                event.topic,
                JSON.stringify(event.payload ?? {}),
                event.priority ?? 50,
                event.state ?? "pending",
                event.supervisorPrompt ?? null,
                event.idempotencyKey ?? null,
                event.causationChain ?? [],
            ],
        );
        return mapRow(result.rows[0]);
    }

    /**
     * Patch one or more fields on an existing event by id. Always bumps
     * `updated_at`. No-op if `patch` contains no recognized fields.
     */
    async update(id: string, patch: EventPatch): Promise<void> {
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
        if (patch.priority !== undefined) {
            sets.push(`priority = $${n++}`);
            values.push(patch.priority);
        }

        values.push(id);
        const idParam = `$${n}`;

        await this.connection.getPool().query(
            `UPDATE events SET ${sets.join(", ")} WHERE id = ${idParam}`,
            values,
        );
    }

    /**
     * Block until an event matching `filter` is in the table. Returns
     * the highest-priority such event (FIFO within priority). Subscribes
     * to `LISTEN events_changed` on first call so subsequent waits sleep
     * until a NOTIFY arrives instead of polling.
     *
     * **Read-only**: does not mutate the row. For multi-consumer queues,
     * use {@link waitAndClaim} instead, which atomically transitions the
     * row's state on read.
     *
     * @param filter - Topic / state filter; default `{ states: ["pending"] }`.
     * @param signal - Optional AbortSignal to cancel the wait.
     * @throws If aborted via `signal`.
     */
    async waitForNext(filter: EventFilter = {}, signal?: AbortSignal): Promise<EventRow> {
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
     * Atomically transition the highest-priority event in `fromState` to
     * `toState` and return the updated row. Race-safe across multiple
     * concurrent workers via `FOR UPDATE SKIP LOCKED`.
     *
     * Returns `undefined` if no row is in `fromState`. Non-blocking — for
     * blocking semantics, use {@link waitAndClaim}.
     */
    async claim(
        fromState: EventState,
        toState: EventState,
    ): Promise<EventRow | undefined> {
        const result = await this.connection.getPool().query<RawEventRow>(
            `UPDATE events
             SET state = $1, updated_at = now()
             WHERE id = (
               SELECT id FROM events
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
     * Block until an event in `fromState` is available, then atomically
     * claim it (transition to `toState`) and return it. Combines
     * {@link claim} with the LISTEN/NOTIFY wait loop used by
     * {@link waitForNext}.
     *
     * @throws If aborted via `signal`.
     */
    async waitAndClaim(
        fromState: EventState,
        toState: EventState,
        signal?: AbortSignal,
    ): Promise<EventRow> {
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

    /** Subscribe this bus's wake-handler to {@link EVENTS_NOTIFY_CHANNEL}. */
    private async ensureListening(): Promise<void> {
        if (this.listenInstalled) {
            return;
        }
        this.listenInstalled = true;
        await this.connection.listen(EVENTS_NOTIFY_CHANNEL, this.listenHandler);
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

    /** Single SELECT for the highest-priority matching pending event. */
    private async queryOne(filter: EventFilter): Promise<EventRow | undefined> {
        const states = filter.states ?? ["pending"];
        const conditions: string[] = ["state = ANY($1)"];
        const values: unknown[] = [states];
        let n = 2;

        if (filter.topics && filter.topics.length > 0) {
            conditions.push(`topic = ANY($${n++})`);
            values.push(filter.topics);
        }

        const result = await this.connection.getPool().query<RawEventRow>(
            `SELECT * FROM events
             WHERE ${conditions.join(" AND ")}
             ORDER BY priority DESC, id ASC
             LIMIT 1`,
            values,
        );

        return result.rows.length > 0 ? mapRow(result.rows[0]) : undefined;
    }
}

/**
 * Convert a snake_case raw row into the camelCase {@link EventRow}.
 *
 * The DB column is `text` with no CHECK constraint, so `raw.state` is
 * trusted to be a known {@link EventState} (we control every writer).
 * Pre-existing rows from before the union was introduced may surface
 * with stale labels like `"processed"`; truncate `events` if that
 * matters.
 */
function mapRow(raw: RawEventRow): EventRow {
    return {
        id: raw.id,
        topic: raw.topic,
        priority: raw.priority,
        state: raw.state as EventState,
        payload: raw.payload,
        supervisorPrompt: raw.supervisor_prompt,
        idempotencyKey: raw.idempotency_key,
        causationChain: raw.causation_chain ?? [],
        createdAt: raw.created_at,
        updatedAt: raw.updated_at,
    };
}
