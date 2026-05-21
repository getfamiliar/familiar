import type { Logger } from "./logging/Logger.js";
import type { NotificationHandler, PostgresConnection } from "./PostgresConnection.js";
import type { NewScheduledHandler, ScheduledHandlerRow } from "./ScheduledHandler.js";
import { SCHEDULED_HANDLERS_CHANNEL, SCHEMA_SQL } from "./Schema.js";

/** Disposer returned by {@link ScheduledHandlerBus.listen}. */
export type ScheduledHandlerUnsubscribe = () => Promise<void>;

/** Notification operation extracted from a NOTIFY payload. */
export type ScheduledHandlerOp = "u" | "d";

/** Parsed notification handed to {@link ScheduledHandlerBus.listen} subscribers. */
export interface ScheduledHandlerNotification {
    readonly key: string;
    readonly op: ScheduledHandlerOp;
}

/** Raw row shape returned by SELECT. `pg` returns timestamps as `Date`. */
interface RawRow {
    key: string;
    fire_at: Date;
    topic: string;
    handler: string;
    prompt: string | null;
    payload: unknown;
    priority: number;
    privileged: boolean;
    created_at: Date;
}

/**
 * Domain client for the `scheduled_handlers` table — agent-requested
 * one-off wake-ups. Used by both sides of the bus:
 *
 * - Container: the `schedule_handler` / `unschedule_handler` /
 *   `get_scheduled_handlers` tools call {@link upsert} / {@link deleteByKey}
 *   / {@link listInRange}.
 * - Host: the `ScheduledHandlerScheduler` calls {@link listFuture} at
 *   startup, listens via {@link listen} for live changes, and uses
 *   {@link claimAndDeleteForFiring} to consume a row at fire time.
 *
 * All times are stored and returned as UTC ISO-8601 strings; the
 * caller is responsible for projecting into the user's
 * `core.timezone` for agent-facing surfaces.
 */
export class ScheduledHandlerBus {
    private readonly connection: PostgresConnection;
    private readonly log: Logger | undefined;

    constructor(connection: PostgresConnection, log?: Logger) {
        this.connection = connection;
        this.log = log;
    }

    /**
     * Apply the bus-state schema (idempotent). Same SQL bundle as
     * {@link import("./EventBus").EventBus.installSchema}, so calling
     * any of the three install methods is sufficient on daemon start.
     */
    async installSchema(): Promise<void> {
        await this.connection.getPool().query(SCHEMA_SQL);
    }

    /**
     * Insert a scheduled handler or replace the existing row with the
     * same `key`. Returns the persisted row.
     *
     * Atomic UPSERT semantics: if the agent re-schedules a key, the
     * old row is overwritten in one statement so the host scheduler
     * sees exactly one NOTIFY and installs exactly one job.
     *
     * @throws If `topic` does not match `\w+(:\w+)*` (CHECK constraint).
     */
    async upsert(row: NewScheduledHandler): Promise<ScheduledHandlerRow> {
        const result = await this.connection.getPool().query<RawRow>(
            `INSERT INTO scheduled_handlers
                (key, fire_at, topic, handler, prompt, payload, priority, privileged)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
             ON CONFLICT (key) DO UPDATE SET
                fire_at = EXCLUDED.fire_at,
                topic = EXCLUDED.topic,
                handler = EXCLUDED.handler,
                prompt = EXCLUDED.prompt,
                payload = EXCLUDED.payload,
                priority = EXCLUDED.priority,
                privileged = EXCLUDED.privileged
             RETURNING *`,
            [
                row.key,
                row.fireAt,
                row.topic,
                row.handler,
                row.prompt ?? null,
                JSON.stringify(row.payload ?? {}),
                row.priority ?? 50,
                row.privileged ?? false,
            ],
        );
        return mapRow(result.rows[0]);
    }

    /**
     * Remove a row by key. Returns `true` when a row was removed,
     * `false` when no row existed for the key.
     */
    async deleteByKey(key: string): Promise<boolean> {
        const result = await this.connection
            .getPool()
            .query(`DELETE FROM scheduled_handlers WHERE key = $1`, [key]);
        return (result.rowCount ?? 0) > 0;
    }

    /** Fetch a row by key, or `undefined` when missing. */
    async getByKey(key: string): Promise<ScheduledHandlerRow | undefined> {
        const result = await this.connection
            .getPool()
            .query<RawRow>(`SELECT * FROM scheduled_handlers WHERE key = $1`, [key]);
        return result.rows.length > 0 ? mapRow(result.rows[0]) : undefined;
    }

    /**
     * Atomic claim-and-delete for the firing path: DELETE the row by
     * key and return it (or `undefined` if it was already gone — the
     * agent may have unscheduled the key in the window between the
     * Croner trigger and this query).
     */
    async claimAndDeleteForFiring(key: string): Promise<ScheduledHandlerRow | undefined> {
        const result = await this.connection
            .getPool()
            .query<RawRow>(`DELETE FROM scheduled_handlers WHERE key = $1 RETURNING *`, [key]);
        return result.rows.length > 0 ? mapRow(result.rows[0]) : undefined;
    }

    /**
     * List every row whose `fire_at` falls inside `[fromUtc, toUtc)`,
     * ordered by `fire_at ASC`. Range is half-open so a `day` query
     * built from {@link import("./Timezone").dayBoundsInZone} returns
     * exactly the rows belonging to that day in the caller's zone.
     */
    async listInRange(fromUtc: string, toUtc: string): Promise<ScheduledHandlerRow[]> {
        const result = await this.connection.getPool().query<RawRow>(
            `SELECT * FROM scheduled_handlers
             WHERE fire_at >= $1 AND fire_at < $2
             ORDER BY fire_at ASC`,
            [fromUtc, toUtc],
        );
        return result.rows.map(mapRow);
    }

    /**
     * Load every row whose `fire_at` is at or after `nowUtc`. Used by
     * the host scheduler on daemon startup to re-install Croner jobs
     * for every still-future scheduled handler.
     */
    async listFuture(nowUtc: string): Promise<ScheduledHandlerRow[]> {
        const result = await this.connection.getPool().query<RawRow>(
            `SELECT * FROM scheduled_handlers
             WHERE fire_at >= $1
             ORDER BY fire_at ASC`,
            [nowUtc],
        );
        return result.rows.map(mapRow);
    }

    /**
     * Delete every row whose `fire_at` is strictly before `nowUtc`.
     * Returns the number of rows removed. Used by the host scheduler
     * at startup to silently drop missed wake-ups (matches missed-cron
     * behavior).
     */
    async deletePastDue(nowUtc: string): Promise<number> {
        const result = await this.connection
            .getPool()
            .query(`DELETE FROM scheduled_handlers WHERE fire_at < $1`, [nowUtc]);
        return result.rowCount ?? 0;
    }

    /**
     * Subscribe to {@link SCHEDULED_HANDLERS_CHANNEL}. Parses the
     * NOTIFY payload (`<key>:<op>`) and invokes `handler` with the
     * parsed shape. Errors thrown by `handler` are logged and
     * swallowed so one bad subscriber doesn't break others on the
     * same channel.
     *
     * Returns a disposer; calling it unlistens. Idempotent.
     */
    async listen(
        handler: (notification: ScheduledHandlerNotification) => void | Promise<void>,
    ): Promise<ScheduledHandlerUnsubscribe> {
        const wrapper: NotificationHandler = (payload) => {
            this.log?.debug(
                { channel: SCHEDULED_HANDLERS_CHANNEL, payload },
                "NOTIFY scheduled_handlers_changed",
            );
            void this.dispatch(payload, handler);
        };
        await this.connection.listen(SCHEDULED_HANDLERS_CHANNEL, wrapper);

        let disposed = false;
        return async () => {
            if (disposed) {
                return;
            }
            disposed = true;
            await this.connection.unlisten(SCHEDULED_HANDLERS_CHANNEL, wrapper);
        };
    }

    private async dispatch(
        payload: string,
        handler: (notification: ScheduledHandlerNotification) => void | Promise<void>,
    ): Promise<void> {
        const colon = payload.lastIndexOf(":");
        if (colon < 0) {
            this.log?.warn({ payload }, "ScheduledHandlerBus: malformed NOTIFY payload (no colon)");
            return;
        }
        const key = payload.slice(0, colon);
        const op = payload.slice(colon + 1);
        if (op !== "u" && op !== "d") {
            this.log?.warn({ payload, op }, "ScheduledHandlerBus: unknown op in NOTIFY payload");
            return;
        }
        try {
            await handler({ key, op });
        } catch (err) {
            this.log?.error(
                { key, op, err: err instanceof Error ? err.message : String(err) },
                "ScheduledHandlerBus listen handler error",
            );
        }
    }
}

/** Convert a snake_case raw row into the camelCase domain shape. */
function mapRow(raw: RawRow): ScheduledHandlerRow {
    return {
        key: raw.key,
        fireAt: raw.fire_at.toISOString(),
        topic: raw.topic,
        handler: raw.handler,
        prompt: raw.prompt,
        payload: raw.payload,
        priority: raw.priority,
        privileged: raw.privileged,
        createdAt: raw.created_at,
    };
}
