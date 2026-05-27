import type { Logger, PostgresConnection } from "@getfamiliar/shared";

/**
 * Outcome of a {@link AgentrunRecovery.recover} call.
 */
export interface RecoveryOutcome {
    readonly failedAgentruns: number;
    readonly rependedEvents: number;
}

/**
 * Startup sweep that unwinds bus-state left behind by a previous
 * daemon. Owned by the container — `AgentrunScheduler.start()` calls
 * this once before its first scheduling pass.
 *
 * Two SQL writes:
 *
 * 1. Fail every agentrun in `running` or `waiting`. The in-memory
 *    runner is gone after a restart and the Vercel AI SDK's
 *    `agent.generate` state is not resurrectable; the only correct
 *    move is to mark the row failed so its subtree unwinds.
 *
 * 2. Re-pend every event still in `running` so the input-event
 *    watcher takes a fresh pass and creates a new root agentrun.
 *    Old (failed) agentruns stay in the table for audit; reports
 *    will show both trees rooted in the same event.
 *
 * Each call is independent — running the recovery twice in a row is
 * harmless because the second run finds nothing to sweep. The helper
 * is intentionally narrow: just SQL + logging. The Scheduler
 * orchestrates `when` to call it.
 */
export class AgentrunRecovery {
    private static readonly RECOVERY_ERROR_TEXT =
        "daemon restarted while this agentrun was running or waiting";

    constructor(
        private readonly connection: PostgresConnection,
        private readonly log: Logger,
    ) {}

    async recover(): Promise<RecoveryOutcome> {
        const pool = this.connection.getPool();

        const agentrunResult = await pool.query(
            `UPDATE agentruns
             SET state = 'failed',
                 error = COALESCE(error, $1),
                 updated_at = now()
             WHERE state IN ('running','waiting')`,
            [AgentrunRecovery.RECOVERY_ERROR_TEXT],
        );
        const failedAgentruns = agentrunResult.rowCount ?? 0;

        const eventResult = await pool.query(
            `UPDATE events
             SET state = 'pending', updated_at = now()
             WHERE state = 'running'`,
        );
        const rependedEvents = eventResult.rowCount ?? 0;

        if (failedAgentruns > 0 || rependedEvents > 0) {
            this.log.warn(
                { failedAgentruns, rependedEvents },
                `agentrun recovery: re-pended ${rependedEvents} stale event(s) and terminated ` +
                    `${failedAgentruns} hung agentrun(s) from a previous daemon`,
            );
        }

        return { failedAgentruns, rependedEvents };
    }
}
