import {
    AgentRunBus,
    type AgentRunRow,
    type Logger,
    type PostgresConnection,
} from "effective-assistant-shared";
import { AgentRunner, POSTPONED } from "./agent-runner/AgentRunner.js";
import { formatInferenceError } from "./agent-runner/formatInferenceError.js";
import type { McpClientPool } from "./mcp/McpClientPool.js";

/**
 * Agentrun watcher. Claims `pending` agentruns into `running`, runs
 * each one through a fresh {@link AgentRunner}, and settles them
 * (`done` / `failed`) via {@link AgentRunBus.settle} — which also
 * recomputes the parent event's terminal state in the same transaction.
 *
 * One agentrun runs at a time: the loop awaits the agent before
 * claiming the next row. That matches the single supervisor slot on
 * Featherless. Per-model parallelism is a deferred open question.
 *
 * The watcher itself owns no agent state: it constructs a new
 * `AgentRunner` per claimed row, which reads its handler markdown and
 * builds its own `ToolLoopAgent`.
 */
export class AgentrunWatcher {
    private readonly bus: AgentRunBus;
    private readonly connection: PostgresConnection;
    private readonly log: Logger;
    private readonly mcpPool: McpClientPool;

    constructor(connection: PostgresConnection, log: Logger, mcpPool: McpClientPool) {
        this.log = log.child({ component: "agentrun-watcher" });
        this.bus = new AgentRunBus(connection, this.log);
        this.connection = connection;
        this.mcpPool = mcpPool;
    }

    /** Run the claim-and-execute loop until `signal` aborts. */
    async run(signal: AbortSignal): Promise<void> {
        this.log.info("agentrun watcher watching state=pending");
        for (;;) {
            const row = await this.claimNext(signal);
            if (row === null) {
                break;
            }
            await this.handle(row, signal);
        }
        this.log.info("agentrun watcher stopped");
    }

    /**
     * Block until the next pending agentrun is available, atomically
     * claim it (`pending → running`), and return it. Returns `null`
     * when `signal` aborts so the caller's loop can exit cleanly.
     *
     * @throws Errors from the bus that aren't caused by the abort.
     */
    private async claimNext(signal: AbortSignal): Promise<AgentRunRow | null> {
        if (signal.aborted) {
            return null;
        }
        try {
            return await this.bus.waitAndClaim("pending", "running", signal);
        } catch (err) {
            if (signal.aborted) {
                return null;
            }
            throw err;
        }
    }

    /**
     * Run a fresh {@link AgentRunner} against the claimed row and
     * settle it. The shutdown signal is threaded into the agent loop
     * so an in-flight model call is interrupted on container stop.
     * Errors from the runner surface as `failed` with the message in
     * `error`; success stores the agent's text in `result_text`.
     */
    private async handle(row: AgentRunRow, signal: AbortSignal): Promise<void> {
        const start = Date.now();
        const parentSuffix = row.parentAgentrunId ? ` (parent=${row.parentAgentrunId})` : "";
        this.log.info(`agentrun ${row.id} started [${row.topic}/${row.handler}]${parentSuffix}`);
        try {
            const runnerLog = this.log.child({
                component: "agent-runner",
                agentrunId: row.id,
                topic: row.topic,
                handler: row.handler,
            });
            const outcome = await new AgentRunner(
                row,
                this.connection,
                runnerLog,
                this.mcpPool,
            ).run(signal);
            if (outcome === POSTPONED) {
                // AgentRunner already wrote the row back to `pending`
                // with a future `not_before` and the latest error;
                // nothing left for the watcher to settle. The next
                // claim-loop tick frees the slot for other rows.
                this.log.info(`agentrun ${row.id} postponed in ${Date.now() - start}ms`);
                return;
            }
            await this.bus.settle(row.id, "done", { resultText: outcome });
            this.log.info(`agentrun ${row.id} done in ${Date.now() - start}ms`);
        } catch (err) {
            const message = formatInferenceError(err);
            this.log.error(`agentrun ${row.id} failed in ${Date.now() - start}ms: ${message}`);
            try {
                await this.bus.settle(row.id, "failed", { error: message });
            } catch (settleErr) {
                const settleMessage =
                    settleErr instanceof Error ? settleErr.message : String(settleErr);
                this.log.error(`failed to settle agentrun ${row.id}: ${settleMessage}`);
            }
        }
    }
}
