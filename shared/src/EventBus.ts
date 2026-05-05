import type { EventFilter, EventPatch, EventRow, EventState, NewEvent } from "./Event.js";
import type { Logger } from "./logging/Logger.js";
import type { NotificationHandler, PostgresConnection } from "./PostgresConnection.js";
import { EVENTS_NEW_CHANNEL, SCHEMA_SQL } from "./Schema.js";

/** Raw row shape returned by the SELECT. `pg` returns bigints as strings. */
interface RawEventRow {
    id: string;
    topic: string;
    priority: number;
    state: string;
    payload: unknown;
    idempotency_key: string | null;
    is_chat: boolean;
    preferred_chat_channel_id: string | null;
    created_at: Date;
    updated_at: Date;
}

/**
 * Domain client for the `events` table that backs the host ↔ container bus.
 *
 * Uses an injected {@link PostgresConnection} for pool + LISTEN access;
 * does not own connection lifecycle. Several `EventBus` instances can
 * share a connection, and the connection can be reused by other domain
 * clients (e.g. {@link AgentRunBus}) without opening more sockets.
 *
 * Listens on `events_new` for wake-ups — the channel that fires on
 * INSERT into `events`. State updates (which fire on `events_state`)
 * are not consumed here; host plugins that need to wait for an event to
 * settle should subscribe to that channel directly via
 * {@link PostgresConnection.listen}.
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
    private readonly log: Logger | undefined;
    private notifyWaiters: Array<() => void> = [];
    private listenInstalled = false;
    private readonly listenHandler: NotificationHandler = (payload) => {
        this.log?.debug({ channel: EVENTS_NEW_CHANNEL, payload }, "NOTIFY events_new");
        const waiters = this.notifyWaiters.splice(0);
        for (const wake of waiters) {
            wake();
        }
    };

    /**
     * @param connection - Shared pg pool / LISTEN handle.
     * @param log - Optional logger; when set, NOTIFY arrivals are
     *   debug-logged. Omitted on the host-side bus that runs inside
     *   one-shot CLI commands so they stay quiet by default.
     */
    constructor(connection: PostgresConnection, log?: Logger) {
        this.connection = connection;
        this.log = log;
    }

    /**
     * Apply the events + agentruns schema (idempotent). Safe to call on
     * every daemon start. The same SQL bundle is consumed by
     * {@link AgentRunBus.installSchema}, so calling either is sufficient.
     */
    async installSchema(): Promise<void> {
        await this.connection.getPool().query(SCHEMA_SQL);
    }

    /**
     * Insert a new event and return the persisted row.
     *
     * Transactional: when `event.isChat === true`, the matching
     * `chatmessages` row (role `'user'`) is inserted in the same
     * transaction. Both NOTIFY triggers fire post-COMMIT, so listeners
     * always observe consistent state.
     *
     * @throws If `idempotencyKey` collides with an existing event, if
     *   `topic` does not match `\w+(:\w+)*`, or if `isChat=true` but
     *   `payload` is not an object containing a `text` string.
     */
    async add(event: NewEvent): Promise<EventRow> {
        const isChat = event.isChat === true;
        const userText = isChat ? extractChatText(event.payload) : null;
        if (isChat && userText === null) {
            throw new Error(
                "EventBus.add: isChat=true requires payload to be an object with a string `text` field",
            );
        }

        const client = await this.connection.getPool().connect();
        try {
            await client.query("BEGIN");
            const result = await client.query<RawEventRow>(
                `INSERT INTO events
                   (topic, payload, priority, state, idempotency_key,
                    is_chat, preferred_chat_channel_id)
                 VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7)
                 RETURNING *`,
                [
                    event.topic,
                    JSON.stringify(event.payload ?? {}),
                    event.priority ?? 50,
                    event.state ?? "pending",
                    event.idempotencyKey ?? null,
                    isChat,
                    event.preferredChatChannelId ?? null,
                ],
            );
            const row = mapRow(result.rows[0]);

            if (isChat && userText !== null) {
                await client.query(
                    `INSERT INTO chatmessages (event_id, role, text_content)
                     VALUES ($1, 'user', $2)`,
                    [row.id, userText],
                );
            }

            await client.query("COMMIT");
            return row;
        } catch (err) {
            try {
                await client.query("ROLLBACK");
            } catch {
                // best-effort rollback; preserve original error
            }
            throw err;
        } finally {
            client.release();
        }
    }

    /**
     * Fetch one event by id. Returns `undefined` if not found. Mirrors
     * {@link import("./StepResultBus").StepResultBus.getById} so
     * notification consumers can promote a payload-only id into a full
     * typed row without a hand-written query.
     */
    async getById(id: string): Promise<EventRow | undefined> {
        const result = await this.connection
            .getPool()
            .query<RawEventRow>(`SELECT * FROM events WHERE id = $1`, [id]);
        return result.rows.length > 0 ? mapRow(result.rows[0]) : undefined;
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
        if (patch.preferredChatChannelId !== undefined) {
            sets.push(`preferred_chat_channel_id = $${n++}`);
            values.push(patch.preferredChatChannelId);
        }

        values.push(id);
        const idParam = `$${n}`;

        await this.connection
            .getPool()
            .query(`UPDATE events SET ${sets.join(", ")} WHERE id = ${idParam}`, values);
    }

    /**
     * Block until an event matching `filter` is in the table. Returns
     * the highest-priority such event (FIFO within priority). Subscribes
     * to `LISTEN events_new` on first call so subsequent waits sleep
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
    async claim(fromState: EventState, toState: EventState): Promise<EventRow | undefined> {
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

    /** Subscribe this bus's wake-handler to {@link EVENTS_NEW_CHANNEL}. */
    private async ensureListening(): Promise<void> {
        if (this.listenInstalled) {
            return;
        }
        this.listenInstalled = true;
        await this.connection.listen(EVENTS_NEW_CHANNEL, this.listenHandler);
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
 * The DB column is `text` with no CHECK constraint on the value, so
 * `raw.state` is trusted to be a known {@link EventState} (we control
 * every writer).
 */
function mapRow(raw: RawEventRow): EventRow {
    return {
        id: raw.id,
        topic: raw.topic,
        priority: raw.priority,
        state: raw.state as EventState,
        payload: raw.payload,
        idempotencyKey: raw.idempotency_key,
        isChat: raw.is_chat,
        preferredChatChannelId: raw.preferred_chat_channel_id,
        createdAt: raw.created_at,
        updatedAt: raw.updated_at,
    };
}

/**
 * Pull the user's chat text out of an event payload. Accepts only the
 * documented `{ text: string, … }` shape; everything else (string
 * payloads, missing field, non-string text) returns `null` so
 * `EventBus.add` can throw with a clear error.
 */
function extractChatText(payload: unknown): string | null {
    if (payload === null || typeof payload !== "object") {
        return null;
    }
    const text = (payload as { text?: unknown }).text;
    return typeof text === "string" ? text : null;
}
