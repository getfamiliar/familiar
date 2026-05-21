import type {
    CalendarAttachmentMeta,
    CalendarAttendee,
    CalendarEventRow,
    CalendarEventType,
    CalendarImportance,
    CalendarResponseStatus,
    CalendarRow,
    CalendarSensitivity,
    CalendarShowAs,
    CalendarType,
    FindEventsQuery,
    NewCalendarEvent,
    PostgresConnection,
    UpsertCalendarInput,
} from "@getfamiliar/shared";

/**
 * Postgres-backed persistence for the core calendar layer. All writes
 * are idempotent on PK / unique constraint, so polling can re-walk a
 * window without risk of duplicate-key errors.
 *
 * Owned by {@link CalendarService}; do not instantiate directly.
 */
export class CalendarStore {
    private readonly conn: () => Promise<PostgresConnection>;

    constructor(connection: () => Promise<PostgresConnection>) {
        this.conn = connection;
    }

    /**
     * Insert or update one calendar row. Identity is the
     * `(plugin_id, unique_key)` pair — call this idempotently on each
     * poll cycle. Returns the persisted row.
     */
    async upsertCalendar(input: UpsertCalendarInput): Promise<CalendarRow> {
        const conn = await this.conn();
        const pool = conn.getPool();
        const result = await pool.query<CalendarSqlRow>(
            `
            INSERT INTO calendars (plugin_id, unique_key, name, type, owner_name, is_default)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (plugin_id, unique_key) DO UPDATE
              SET name = EXCLUDED.name,
                  type = EXCLUDED.type,
                  owner_name = EXCLUDED.owner_name,
                  is_default = EXCLUDED.is_default
            RETURNING *
            `,
            [
                input.pluginId,
                input.uniqueKey,
                input.name,
                input.type,
                input.ownerName ?? null,
                input.isDefault === true ? 1 : 0,
            ],
        );
        return rowToCalendar(result.rows[0]);
    }

    /**
     * Bump the calendar's `scan_generation` and return the new value.
     * Used by refresh walks to tag every upserted event with the new
     * generation so stale rows can be DELETEd at the end.
     */
    async beginRefresh(calendarId: string): Promise<number> {
        const conn = await this.conn();
        const pool = conn.getPool();
        const result = await pool.query<{ scan_generation: number }>(
            `UPDATE calendars
             SET scan_generation = scan_generation + 1
             WHERE id = $1
             RETURNING scan_generation`,
            [calendarId],
        );
        if (result.rows.length === 0) {
            throw new Error(`calendar ${calendarId} not found`);
        }
        return result.rows[0].scan_generation;
    }

    /**
     * Delete every event for `calendarId` whose `scan_generation` is
     * strictly less than `gen`. Returns the number of removed rows and
     * the removed row data so the service can emit one
     * `calendar:delete:<pluginId>` per pruned row.
     */
    async endRefresh(
        calendarId: string,
        gen: number,
    ): Promise<{ removed: number; rows: readonly CalendarEventRow[] }> {
        const conn = await this.conn();
        const pool = conn.getPool();
        const result = await pool.query<EventSqlRow>(
            `DELETE FROM calendar_events
             WHERE calendar_id = $1 AND scan_generation < $2
             RETURNING *`,
            [calendarId, gen],
        );
        return { removed: result.rowCount ?? 0, rows: result.rows.map(rowToEvent) };
    }

    /**
     * Upsert one event. Returns `{created}` reporting whether the row
     * is new (PK didn't exist before) — used by the service to decide
     * whether to emit `calendar:new`.
     *
     * The `xmax = 0` predicate is the standard postgres trick to
     * detect "this row was inserted by the current ON CONFLICT, not
     * updated": `xmax` is 0 on a fresh insert and non-zero on update.
     */
    async upsertEvent(row: NewCalendarEvent): Promise<{ created: boolean }> {
        const conn = await this.conn();
        const pool = conn.getPool();
        const result = await pool.query<{ created: boolean }>(
            `
            INSERT INTO calendar_events (
                id, calendar_id, series_master_id, type, subject,
                start_dt, end_dt, event_tz, is_all_day, is_cancelled,
                show_as, sensitivity, importance, location,
                is_online_meeting, online_meeting_url,
                organizer_name, organizer_email, response_status,
                attendees_json, body, attachments, scan_generation
            ) VALUES (
                $1, $2, $3, $4, $5,
                $6, $7, $8, $9, $10,
                $11, $12, $13, $14,
                $15, $16,
                $17, $18, $19,
                $20, $21, $22, $23
            )
            ON CONFLICT (id) DO UPDATE SET
                calendar_id        = EXCLUDED.calendar_id,
                series_master_id   = EXCLUDED.series_master_id,
                type               = EXCLUDED.type,
                subject            = EXCLUDED.subject,
                start_dt           = EXCLUDED.start_dt,
                end_dt             = EXCLUDED.end_dt,
                event_tz           = EXCLUDED.event_tz,
                is_all_day         = EXCLUDED.is_all_day,
                is_cancelled       = EXCLUDED.is_cancelled,
                show_as            = EXCLUDED.show_as,
                sensitivity        = EXCLUDED.sensitivity,
                importance         = EXCLUDED.importance,
                location           = EXCLUDED.location,
                is_online_meeting  = EXCLUDED.is_online_meeting,
                online_meeting_url = EXCLUDED.online_meeting_url,
                organizer_name     = EXCLUDED.organizer_name,
                organizer_email    = EXCLUDED.organizer_email,
                response_status    = EXCLUDED.response_status,
                attendees_json     = EXCLUDED.attendees_json,
                body               = EXCLUDED.body,
                attachments        = EXCLUDED.attachments,
                scan_generation    = EXCLUDED.scan_generation,
                updated_at         = now()
            RETURNING (xmax = 0) AS created
            `,
            [
                row.id,
                row.calendarId,
                row.seriesMasterId ?? null,
                row.type,
                row.subject,
                row.startDt,
                row.endDt,
                row.eventTz ?? null,
                row.isAllDay ? 1 : 0,
                row.isCancelled ? 1 : 0,
                row.showAs ?? null,
                row.sensitivity ?? null,
                row.importance ?? null,
                row.location ?? null,
                row.isOnlineMeeting ? 1 : 0,
                row.onlineMeetingUrl ?? null,
                row.organizerName ?? null,
                row.organizerEmail ?? null,
                row.responseStatus ?? null,
                row.attendees ? JSON.stringify(row.attendees) : null,
                row.body ?? null,
                row.attachments ? JSON.stringify(row.attachments) : null,
                row.scanGeneration,
            ],
        );
        return { created: result.rows[0]?.created === true };
    }

    async removeEvent(id: string): Promise<void> {
        const conn = await this.conn();
        const pool = conn.getPool();
        await pool.query(`DELETE FROM calendar_events WHERE id = $1`, [id]);
    }

    async getEvent(id: string): Promise<CalendarEventRow | null> {
        const conn = await this.conn();
        const pool = conn.getPool();
        const result = await pool.query<EventSqlRow>(
            `SELECT * FROM calendar_events WHERE id = $1`,
            [id],
        );
        return result.rows[0] ? rowToEvent(result.rows[0]) : null;
    }

    /**
     * Query events by window / text / calendar. `seriesMaster` rows
     * are excluded by default — `includeMasters: true` re-adds them.
     * Cancelled events are excluded by default.
     */
    async findEvents(q: FindEventsQuery): Promise<readonly CalendarEventRow[]> {
        const conn = await this.conn();
        const pool = conn.getPool();
        const where: string[] = [];
        // biome-ignore lint/suspicious/noExplicitAny: pg parameter binding is heterogeneous.
        const params: any[] = [];
        const push = (clause: string, value: unknown) => {
            params.push(value);
            where.push(clause.replace("?", `$${params.length}`));
        };
        if (q.calendarId !== undefined) {
            push(`calendar_id = ?`, q.calendarId);
        }
        if (q.from !== undefined) {
            push(`end_dt >= ?`, q.from);
        }
        if (q.to !== undefined) {
            push(`start_dt < ?`, q.to);
        }
        if (q.text !== undefined && q.text.length > 0) {
            push(`(subject ILIKE ? OR body ILIKE ?)`, `%${q.text}%`);
            // The push helper assumes one placeholder per call; second
            // OR arm needs its own parameter slot. Re-do it manually.
            params.push(`%${q.text}%`);
            where[where.length - 1] = where[where.length - 1].replace(/\?/, `$${params.length}`);
        }
        if (q.includeMasters !== true) {
            where.push(`type <> 'seriesMaster'`);
        }
        if (q.includeCancelled !== true) {
            where.push(`is_cancelled = 0`);
        }
        const whereClause = where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`;
        const limitClause =
            q.limit !== undefined ? `LIMIT ${Math.max(1, Math.floor(q.limit))}` : "";
        const sql = `SELECT * FROM calendar_events ${whereClause} ORDER BY start_dt ASC ${limitClause}`;
        const result = await pool.query<EventSqlRow>(sql, params);
        return result.rows.map(rowToEvent);
    }

    /**
     * Fetch one calendar row by primary key, or null if it doesn't
     * exist. Used by the service to look up the owning plugin of an
     * event for emit-topic validation.
     */
    async getCalendar(id: string): Promise<CalendarRow | null> {
        const conn = await this.conn();
        const pool = conn.getPool();
        const result = await pool.query<CalendarSqlRow>(`SELECT * FROM calendars WHERE id = $1`, [
            id,
        ]);
        return result.rows[0] ? rowToCalendar(result.rows[0]) : null;
    }

    async listCalendars(filter?: { pluginId?: string }): Promise<readonly CalendarRow[]> {
        const conn = await this.conn();
        const pool = conn.getPool();
        if (filter?.pluginId !== undefined) {
            const result = await pool.query<CalendarSqlRow>(
                `SELECT * FROM calendars WHERE plugin_id = $1 ORDER BY id ASC`,
                [filter.pluginId],
            );
            return result.rows.map(rowToCalendar);
        }
        const result = await pool.query<CalendarSqlRow>(`SELECT * FROM calendars ORDER BY id ASC`);
        return result.rows.map(rowToCalendar);
    }
}

/** Raw shape of a `calendars` row as returned by `pg`. */
interface CalendarSqlRow {
    readonly id: string;
    readonly plugin_id: string;
    readonly unique_key: string;
    readonly name: string;
    readonly type: string;
    readonly owner_name: string | null;
    readonly is_default: number;
    readonly scan_generation: number;
    readonly created_at: Date;
}

/** Raw shape of a `calendar_events` row as returned by `pg`. */
interface EventSqlRow {
    readonly id: string;
    readonly calendar_id: string;
    readonly series_master_id: string | null;
    readonly type: string;
    readonly subject: string | null;
    readonly start_dt: string;
    readonly end_dt: string;
    readonly event_tz: string | null;
    readonly is_all_day: number;
    readonly is_cancelled: number;
    readonly show_as: string | null;
    readonly sensitivity: string | null;
    readonly importance: string | null;
    readonly location: string | null;
    readonly is_online_meeting: number;
    readonly online_meeting_url: string | null;
    readonly organizer_name: string | null;
    readonly organizer_email: string | null;
    readonly response_status: string | null;
    readonly attendees_json: readonly CalendarAttendee[] | null;
    readonly body: string | null;
    readonly attachments: readonly CalendarAttachmentMeta[] | null;
    readonly scan_generation: number;
    readonly created_at: Date;
    readonly updated_at: Date;
}

function rowToCalendar(row: CalendarSqlRow): CalendarRow {
    return {
        id: row.id,
        pluginId: row.plugin_id,
        uniqueKey: row.unique_key,
        name: row.name,
        type: row.type as CalendarType,
        ownerName: row.owner_name,
        isDefault: row.is_default === 1,
        scanGeneration: row.scan_generation,
        createdAt: row.created_at,
    };
}

function rowToEvent(row: EventSqlRow): CalendarEventRow {
    return {
        id: row.id,
        calendarId: row.calendar_id,
        seriesMasterId: row.series_master_id,
        type: row.type as CalendarEventType,
        subject: row.subject,
        startDt: row.start_dt,
        endDt: row.end_dt,
        eventTz: row.event_tz,
        isAllDay: row.is_all_day === 1,
        isCancelled: row.is_cancelled === 1,
        showAs: (row.show_as as CalendarShowAs | null) ?? null,
        sensitivity: (row.sensitivity as CalendarSensitivity | null) ?? null,
        importance: (row.importance as CalendarImportance | null) ?? null,
        location: row.location,
        isOnlineMeeting: row.is_online_meeting === 1,
        onlineMeetingUrl: row.online_meeting_url,
        organizerName: row.organizer_name,
        organizerEmail: row.organizer_email,
        responseStatus: (row.response_status as CalendarResponseStatus | null) ?? null,
        attendees: row.attendees_json,
        body: row.body,
        attachments: row.attachments,
        scanGeneration: row.scan_generation,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}
