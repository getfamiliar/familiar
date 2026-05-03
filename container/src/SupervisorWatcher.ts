import type { EventRow, PostgresConnection } from "effective-assistant-shared";
import { AgentRunner } from "./agent-runner/AgentRunner";
import { EventWatcher } from "./EventWatcher";
import { ModelFactory } from "./models/ModelFactory";
import { ToolsFactory } from "./tools/ToolsFactory";

/**
 * Supervisor worker. Claims events in `supervisor-ready` (spawned by
 * triage), runs the supervisor session through {@link AgentRunner}, marks
 * them `done` — or `failed` on error.
 *
 * For now the loop is minimal: the event's `supervisorPrompt` becomes the
 * user prompt; the model's text response is logged. Subagents, MCP tools,
 * and the approval gate hook in once those pieces exist.
 */
export class SupervisorWatcher {
    private readonly watcher: EventWatcher;
    private readonly agent: AgentRunner;

    constructor(connection: PostgresConnection) {
        this.watcher = new EventWatcher({
            connection,
            watchState: "supervisor-ready",
            claimedState: "supervising",
        });
        this.agent = new AgentRunner({
            model: ModelFactory.build(),
            tools: ToolsFactory.build(),
        });
    }

    /** Run the claim-handle-mark loop until `signal` aborts. */
    async run(signal: AbortSignal): Promise<void> {
        console.error("Supervisor worker watching state=supervisor-ready");
        for (;;) {
            const event = await this.watcher.claimNextEvent(signal);
            if (event === null) {
                break;
            }
            await this.handle(event);
        }
        console.error("Supervisor worker stopped");
    }

    /** Process a single claimed (now `supervising`) event. */
    private async handle(event: EventRow): Promise<void> {
        try {
            const prompt = event.supervisorPrompt ?? "(no prompt set)";
            console.log(`[supervisor] id=${event.id} topic=${event.topic} prompt=${prompt}`);
            const text = await this.agent.run(prompt);
            console.log(`[supervisor] id=${event.id} response=${text}`);
            await this.watcher.setState(event.id, "done");
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`Supervisor failed for id=${event.id}: ${message}`);
            await this.markFailedQuietly(event.id);
        }
    }

    private async markFailedQuietly(id: string): Promise<void> {
        try {
            await this.watcher.setState(id, "failed");
        } catch (err) {
            console.error(
                `Also failed to mark id=${id} failed: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }
}
