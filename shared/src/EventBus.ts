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
    prompt: string | null;
    start_handler: string | null;
    privileged: boolean;
    output_chat_on_failure: boolean;
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
     * Transactional: when `event.isChat === true`, a `chatmessages`
     * row (role `'user'`) carrying the same `prompt` text is inserted
     * in the same transaction. Both NOTIFY triggers fire post-COMMIT,
     * so listeners always observe consistent state.
     *
     * Validation: `prompt` must be a non-empty string after trimming —
     * for any event, chat or not. The single check exists at this
     * boundary so plugins that bypass the type system (untyped JS,
     * unsafe casts) still surface the bug at emit time instead of
     * leaving the AgentRunner with an empty messages array.
     *
     * `beforeCommit` runs **inside the transaction** after the event
     * row (and any chat mirror) is inserted but before COMMIT. Use it
     * for filesystem side-effects that must be atomic with the INSERT
     * from the watcher's perspective — most importantly, staging
     * `event.files` under `<scratchDir>/<row.id>/` so the container
     * never observes an event without its scratch files in place.
     * Throwing from `beforeCommit` rolls the INSERT back; cleaning up
     * any partial filesystem state is the callback's responsibility.
     *
     * @throws If `idempotencyKey` collides, if `topic` does not match
     *   `\w+(:\w+)*`, if `prompt` is missing or whitespace-only, or if
     *   `beforeCommit` throws.
     */
    async add(event: NewEvent, beforeCommit?: (row: EventRow) => Promise<void>): Promise<EventRow> {
        if (typeof event.prompt !== "string" || event.prompt.trim().length === 0) {
            throw new Error(
                "EventBus.add: every event requires a non-empty `prompt` (the agent-visible text)",
            );
        }
        const isChat = event.isChat === true;
        const prompt = event.prompt;

        const client = await this.connection.getPool().connect();
        try {
            await client.query("BEGIN");
            const result = await client.query<RawEventRow>(
                `INSERT INTO events
                   (topic, payload, priority, state, idempotency_key,
                    is_chat, preferred_chat_channel_id, prompt, privileged,
                    start_handler, output_chat_on_failure)
                 VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                 RETURNING *`,
                [
                    event.topic,
                    JSON.stringify(event.payload ?? {}),
                    event.priority ?? 50,
                    event.state ?? "pending",
                    event.idempotencyKey ?? null,
                    isChat,
                    event.preferredChatChannelId ?? null,
                    prompt,
                    event.privileged ?? false,
                    event.startHandler ?? null,
                    event.outputChatOnFailure ?? false,
                ],
            );
            const row = mapRow(result.rows[0]);

            // Atomic user-chatmessage insert. Two modes:
            //   - `userChatMessage` set: insert that text verbatim,
            //     irrespective of isChat. Used by plugins (cli-chat
            //     direct calls) that want a chatmessage text different
            //     from `prompt`.
            //   - else `isChat: true`: insert `prompt` (back-compat
            //     with chat-event emitters that don't know about the
            //     new field).
            //
            // Doing the INSERT here, inside the same transaction as the
            // event INSERT, ensures the FK row-lock is released before
            // NOTIFY events_new fires post-commit — otherwise the
            // input-event watcher's `FOR UPDATE SKIP LOCKED` claim can
            // race with the chatmessages lock and leave the event
            // stuck `pending` forever (the NOTIFY waiter is consumed
            // even though `claim()` returned zero rows).
            const chatMessageText = event.userChatMessage ?? (isChat ? prompt : undefined);
            if (chatMessageText !== undefined) {
                await client.query(
                    `INSERT INTO chatmessages (event_id, role, text_content)
                     VALUES ($1, 'user', $2)`,
                    [row.id, chatMessageText],
                );
            }

            if (beforeCommit) {
                await beforeCommit(row);
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
     * Fetch all event rows whose `updated_at` is `>= since`, ordered by
     * `(updated_at, id)`. Used by the polling-based report layer to
     * pick up new inserts and state transitions without subscribing to
     * NOTIFY. Returns an empty array when nothing changed since the
     * anchor.
     */
    async listSince(since: Date): Promise<EventRow[]> {
        const result = await this.connection.getPool().query<RawEventRow>(
            `SELECT * FROM events
                 WHERE updated_at >= $1
                 ORDER BY updated_at, id`,
            [since],
        );
        return result.rows.map(mapRow);
    }

    /**
     * Fetch the most recently created N event rows, newest first. Used by
     * `./cli.sh events list` to surface recent bus activity for operators
     * looking for an event id to inspect with `events report <id>`.
     *
     * @param limit Maximum number of rows to return. Must be a positive integer.
     * @returns Up to `limit` event rows ordered by descending `(created_at, id)`.
     */
    async listLatest(limit: number): Promise<EventRow[]> {
        const result = await this.connection.getPool().query<RawEventRow>(
            `SELECT * FROM events
                 ORDER BY created_at DESC, id DESC
                 LIMIT $1`,
            [limit],
        );
        return result.rows.map(mapRow);
    }

    /**
     * Fetch the most recently created N event rows whose topic, start_handler,
     * prompt, or payload (cast to text) case-insensitively contains `needle`.
     * Used by `./cli.sh events list <search>` so the operator can grep the
     * recent bus without piping through `grep`.
     *
     * Substring match via `ILIKE '%needle%'`; the needle is escaped for the
     * SQL `LIKE` metacharacters `%`, `_`, and `\`. No index is added — at
     * interactive scale a sequential scan is fine.
     *
     * @param limit Maximum number of rows to return. Must be a positive integer.
     * @param needle Case-insensitive substring to search for.
     * @returns Up to `limit` matching event rows ordered by descending `(created_at, id)`.
     */
    async searchLatest(limit: number, needle: string): Promise<EventRow[]> {
        const pattern = `%${needle.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        const result = await this.connection.getPool().query<RawEventRow>(
            `SELECT * FROM events
                 WHERE topic                          ILIKE $2
                    OR coalesce(start_handler, '')    ILIKE $2
                    OR coalesce(prompt, '')           ILIKE $2
                    OR payload::text                  ILIKE $2
                 ORDER BY created_at DESC, id DESC
                 LIMIT $1`,
            [limit, pattern],
        );
        return result.rows.map(mapRow);
    }

    /**
     * Latest N event rows matching every supplied filter. Drives the
     * agent-facing `event_list` reflection tool, which lets the agent
     * narrow by state, date window, and free-text needle simultaneously
     * — combinations the older {@link listLatest} / {@link searchLatest}
     * pair can't express. Both of those stay as the CLI's call sites.
     *
     * Substring match (when `search` is set) is the same ILIKE-against-
     * `(topic, start_handler, prompt, payload::text)` predicate
     * {@link searchLatest} uses. `dateFrom` is inclusive, `dateTo` is
     * exclusive (`created_at >= $from AND created_at < $to`), so the
     * agent can pass two midnights to get a single local day without
     * worrying about the boundary instant.
     */
    async listFiltered(filter: {
        readonly limit: number;
        readonly search?: string;
        readonly state?: EventState;
        readonly dateFrom?: Date;
        readonly dateTo?: Date;
    }): Promise<EventRow[]> {
        const conditions: string[] = [];
        const values: unknown[] = [];
        let n = 1;

        if (filter.search !== undefined && filter.search.length > 0) {
            const pattern = `%${filter.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
            conditions.push(
                `(topic ILIKE $${n} OR coalesce(start_handler, '') ILIKE $${n} ` +
                    `OR coalesce(prompt, '') ILIKE $${n} OR payload::text ILIKE $${n})`,
            );
            values.push(pattern);
            n++;
        }
        if (filter.state !== undefined) {
            conditions.push(`state = $${n++}`);
            values.push(filter.state);
        }
        if (filter.dateFrom !== undefined) {
            conditions.push(`created_at >= $${n++}`);
            values.push(filter.dateFrom);
        }
        if (filter.dateTo !== undefined) {
            conditions.push(`created_at < $${n++}`);
            values.push(filter.dateTo);
        }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
        values.push(filter.limit);
        const limitParam = `$${n}`;

        const result = await this.connection.getPool().query<RawEventRow>(
            `SELECT * FROM events
             ${where}
             ORDER BY created_at DESC, id DESC
             LIMIT ${limitParam}`,
            values,
        );
        return result.rows.map(mapRow);
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
        prompt: raw.prompt ?? "",
        startHandler: raw.start_handler,
        privileged: raw.privileged,
        outputChatOnFailure: raw.output_chat_on_failure,
        createdAt: raw.created_at,
        updatedAt: raw.updated_at,
    };
}
