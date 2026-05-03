import {
    AgentRunBus,
    type AgentRunRow,
    type PostgresConnection,
} from "effective-assistant-shared";
import { AgentRunner } from "./agent-runner/AgentRunner";

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

    constructor(connection: PostgresConnection) {
        this.bus = new AgentRunBus(connection);
    }

    /** Run the claim-and-execute loop until `signal` aborts. */
    async run(signal: AbortSignal): Promise<void> {
        console.error("Agentrun watcher watching state=pending");
        for (;;) {
            const row = await this.claimNext(signal);
            if (row === null) {
                break;
            }
            await this.handle(row);
        }
        console.error("Agentrun watcher stopped");
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
     * settle it. Errors from the runner surface as `failed` with the
     * message in `error`; success stores the agent's text in `result`.
     */
    private async handle(row: AgentRunRow): Promise<void> {
        console.log(`[agentrun] id=${row.id} topic=${row.topic} handler=${row.handler}`);
        try {
            const text = await new AgentRunner(row).run();
            await this.bus.settle(row.id, "done", { result: { text } });
            console.log(`[agentrun] id=${row.id} done`);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`Agentrun id=${row.id} failed: ${message}`);
            try {
                await this.bus.settle(row.id, "failed", { error: message });
            } catch (settleErr) {
                console.error(
                    `Also failed to settle agentrun id=${row.id}: ${settleErr instanceof Error ? settleErr.message : String(settleErr)}`,
                );
            }
        }
    }
}
