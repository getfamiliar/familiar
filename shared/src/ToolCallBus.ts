import type { PostgresConnection } from "./PostgresConnection.js";
import { SCHEMA_SQL } from "./Schema.js";
import type { NewToolCall, ToolUsageCount } from "./ToolCall.js";

interface RawToolUsageCount {
    tool_name: string;
    count: string;
}

/**
 * Domain client for the `tool_calls` table — one row per tool
 * invocation an agentrun attempted, tagged with the resolved handler
 * path and whether the call threw. Append-only: there is no update or
 * delete outside the global retention sweep. Mirrors
 * {@link import("./InferenceEventBus.js").InferenceEventBus} in its
 * constructor + Pool access pattern; does not own connection lifecycle.
 *
 * Feeds the heuristic tool-preloader: {@link topToolsForHandler} ranks
 * the tools a handler has successfully used across its recent non-error
 * runs so those tools can be loaded up front on the next run.
 */
export class ToolCallBus {
    private readonly connection: PostgresConnection;

    constructor(connection: PostgresConnection) {
        this.connection = connection;
    }

    /**
     * Apply the bus-state schema (idempotent). Same SQL bundle every
     * other bus client installs; calling any one is sufficient on
     * daemon start.
     */
    async installSchema(): Promise<void> {
        await this.connection.getPool().query(SCHEMA_SQL);
    }

    /**
     * Insert one tool-call record. Fire-and-forget from the tool
     * wrapper; any thrown error is the caller's responsibility to log —
     * an audit-table write error must never mask (or fault) the real
     * tool result.
     */
    async add(row: NewToolCall): Promise<void> {
        await this.connection.getPool().query(
            `INSERT INTO tool_calls
                (agent_run_id, handler_path, tool_name, successful)
             VALUES ($1, $2, $3, $4)`,
            [row.agentRunId ?? null, row.handlerPath, row.toolName, row.successful],
        );
    }

    /**
     * Rank the tools this handler has successfully called across its
     * most recent `runWindow` **non-error** agentruns (terminal state
     * `done`), most-used first.
     *
     * The window is over distinct agentruns, not individual calls: we
     * take the newest `runWindow` done runs for `handlerPath`, then
     * count successful calls within them grouped by tool name. A tool
     * that failed every time contributes nothing; a tool used across
     * many runs ranks above one used heavily in a single run only if it
     * has more successful calls overall.
     *
     * @param handlerPath Resolved handler markdown path the runs belong to.
     * @param runWindow How many recent done runs to consider.
     * @returns Tool usage counts, descending by count.
     */
    async topToolsForHandler(
        handlerPath: string,
        runWindow: number,
    ): Promise<readonly ToolUsageCount[]> {
        const result = await this.connection.getPool().query<RawToolUsageCount>(
            `WITH recent_runs AS (
                SELECT tc.agent_run_id
                FROM tool_calls tc
                JOIN agentruns a ON a.id = tc.agent_run_id
                WHERE tc.handler_path = $1 AND a.state = 'done'
                GROUP BY tc.agent_run_id
                ORDER BY tc.agent_run_id DESC
                LIMIT $2
            )
            SELECT tc.tool_name, COUNT(*) AS count
            FROM tool_calls tc
            WHERE tc.handler_path = $1
              AND tc.successful = true
              AND tc.agent_run_id IN (SELECT agent_run_id FROM recent_runs)
            GROUP BY tc.tool_name
            ORDER BY count DESC`,
            [handlerPath, runWindow],
        );
        return result.rows.map((raw) => ({
            toolName: raw.tool_name,
            count: Number(raw.count),
        }));
    }

    /**
     * Delete rows older than `cutoff`. Returns the number of rows
     * removed. Run from the same retention pass that prunes daemon log
     * files and `inference_events` so the retention policies stay
     * aligned with `core.logRetentionDays`.
     */
    async pruneBefore(cutoff: Date): Promise<number> {
        const result = await this.connection
            .getPool()
            .query(`DELETE FROM tool_calls WHERE created_at < $1`, [cutoff]);
        return result.rowCount ?? 0;
    }

    /**
     * Keep only the newest `keepPerHandler` rows for each distinct
     * `handler_path`, deleting the rest. Returns the number of rows
     * removed. Bounds the table per handler: the heuristic only ever
     * reads a small recent window, so older history is pure storage
     * waste. Run from a periodic GC.
     *
     * @param keepPerHandler Rows retained per handler_path (newest first).
     */
    async pruneKeepingPerHandler(keepPerHandler: number): Promise<number> {
        const result = await this.connection.getPool().query(
            `DELETE FROM tool_calls
             WHERE id IN (
                 SELECT id FROM (
                     SELECT id, row_number() OVER (
                         PARTITION BY handler_path ORDER BY id DESC
                     ) AS rn
                     FROM tool_calls
                 ) ranked
                 WHERE ranked.rn > $1
             )`,
            [keepPerHandler],
        );
        return result.rowCount ?? 0;
    }
}
