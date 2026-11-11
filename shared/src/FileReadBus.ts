import type { FileReadSummary, FileReadSummaryOptions, NewFileRead } from "./FileRead.js";
import type { PostgresConnection } from "./PostgresConnection.js";

interface RawFileReadSummary {
    path: string;
    reading_runs: string;
    last_read_at: Date;
}

/**
 * Domain client for the `file_reads` table — one row per `fs_read` call on a
 * workspace file, tagged with the reading run and its handler. Append-only;
 * rows go away through {@link pruneBefore} (the host's retention sweep).
 * Does not own the connection lifecycle.
 */
export class FileReadBus {
    private readonly connection: PostgresConnection;

    /**
     * @param connection - The bus-state connection.
     */
    constructor(connection: PostgresConnection) {
        this.connection = connection;
    }

    /**
     * Inserts one read. Fire-and-forget from `fs_read`; a write error must
     * never fault the read itself, so callers catch and log.
     *
     * @param row - The read.
     * @returns Resolves once inserted.
     */
    async add(row: NewFileRead): Promise<void> {
        await this.connection.getPool().query(
            `INSERT INTO file_reads (path, agent_run_id, event_id, handler_path)
             VALUES ($1, $2, $3, $4)`,
            [row.path, row.agentRunId ?? null, row.eventId ?? null, row.handlerPath],
        );
    }

    /**
     * Counts, per file, the distinct agent runs that read it.
     *
     * @param options - Path prefix, time window, handlers to leave out.
     * @returns One entry per file read at least once, most-read first.
     */
    async summarize(options: FileReadSummaryOptions): Promise<readonly FileReadSummary[]> {
        const result = await this.connection.getPool().query<RawFileReadSummary>(
            `SELECT path,
                    count(DISTINCT coalesce(agent_run_id::text, 'read-' || id::text)) AS reading_runs,
                    max(read_at) AS last_read_at
             FROM file_reads
             WHERE starts_with(path, $1)
               AND read_at >= $2
               AND NOT EXISTS (
                   SELECT 1 FROM unnest($3::text[]) AS excluded(prefix)
                   WHERE starts_with(handler_path, excluded.prefix)
               )
             GROUP BY path
             ORDER BY reading_runs DESC, last_read_at DESC, path`,
            [options.pathPrefix, options.since, [...(options.excludeHandlerPrefixes ?? [])]],
        );
        return result.rows.map((row) => ({
            path: row.path,
            readingRuns: Number(row.reading_runs),
            lastReadAt: row.last_read_at,
        }));
    }

    /**
     * Deletes every read older than the cutoff.
     *
     * @param cutoff - Reads before this instant go.
     * @returns How many rows were deleted.
     */
    async pruneBefore(cutoff: Date): Promise<number> {
        const result = await this.connection
            .getPool()
            .query(`DELETE FROM file_reads WHERE read_at < $1`, [cutoff]);
        return result.rowCount ?? 0;
    }
}
