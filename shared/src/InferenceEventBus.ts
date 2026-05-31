import type { InferenceEventRow, InferenceOutcome, NewInferenceEvent } from "./InferenceEvent.js";
import type { PostgresConnection } from "./PostgresConnection.js";
import { SCHEMA_SQL } from "./Schema.js";

interface RawInferenceEventRow {
    id: string;
    provider: string;
    model: string;
    agent_run_id: string | null;
    outcome: string;
    status_code: number | null;
    error_excerpt: string | null;
    occurred_at: Date;
}

/**
 * Domain client for the `inference_events` table — every upstream model
 * HTTP call AgentRunner attempted, classified into success / retryable /
 * fatal. Append-only: there is no update or delete on this table outside
 * the global retention sweep. Mirrors {@link import("./AgentRunBus.js").AgentRunBus}
 * in its constructor + Pool access pattern; does not own connection
 * lifecycle.
 */
export class InferenceEventBus {
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
     * Insert one inference event. Fire-and-forget from AgentRunner; any
     * thrown error is the caller's responsibility to log — we don't want
     * to mask a real model error with an audit-table write error.
     */
    async add(row: NewInferenceEvent): Promise<void> {
        await this.connection.getPool().query(
            `INSERT INTO inference_events
                (provider, model, agent_run_id, outcome, status_code, error_excerpt)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
                row.provider,
                row.model,
                row.agentRunId ?? null,
                row.outcome,
                row.statusCode ?? null,
                row.errorExcerpt ?? null,
            ],
        );
    }

    /**
     * Fetch every inference event with `occurred_at >= since`, optionally
     * filtered to one model id. Ordered by `occurred_at DESC` so the
     * reflection tool's "last successful call" lookup is the first hit.
     */
    async listSince(since: Date, model?: string): Promise<readonly InferenceEventRow[]> {
        const pool = this.connection.getPool();
        const result =
            model === undefined
                ? await pool.query<RawInferenceEventRow>(
                      `SELECT * FROM inference_events
                       WHERE occurred_at >= $1
                       ORDER BY occurred_at DESC`,
                      [since],
                  )
                : await pool.query<RawInferenceEventRow>(
                      `SELECT * FROM inference_events
                       WHERE occurred_at >= $1 AND model = $2
                       ORDER BY occurred_at DESC`,
                      [since, model],
                  );
        return result.rows.map(mapRow);
    }

    /**
     * Delete rows older than `cutoff`. Returns the number of rows
     * removed. Run from the same retention pass that prunes daemon log
     * files so the two retention policies stay aligned with
     * `core.logRetentionDays`.
     */
    async pruneBefore(cutoff: Date): Promise<number> {
        const result = await this.connection
            .getPool()
            .query(`DELETE FROM inference_events WHERE occurred_at < $1`, [cutoff]);
        return result.rowCount ?? 0;
    }
}

function mapRow(raw: RawInferenceEventRow): InferenceEventRow {
    return {
        id: raw.id,
        provider: raw.provider,
        model: raw.model,
        agentRunId: raw.agent_run_id,
        outcome: raw.outcome as InferenceOutcome,
        statusCode: raw.status_code,
        errorExcerpt: raw.error_excerpt,
        occurredAt: raw.occurred_at,
    };
}
