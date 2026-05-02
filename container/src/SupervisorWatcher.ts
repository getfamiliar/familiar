import type { EventRow, PostgresConnection } from "effective-assistant-shared";
import { EventWatcher } from "./EventWatcher";

/**
 * Supervisor worker. Claims events in `supervisor-ready` (spawned by
 * triage), runs the (placeholder) supervisor session, marks them `done`
 * — or `failed` on error.
 *
 * Real supervisor will: build the prompt from the event's payload,
 * invoke the supervisor model (with subagents and MCP tools as needed),
 * and propose any pending actions through the approval gate.
 */
export class SupervisorWatcher {
    private readonly watcher: EventWatcher;

    constructor(connection: PostgresConnection) {
        this.watcher = new EventWatcher({
            connection,
            watchState: "supervisor-ready",
            claimedState: "supervising",
        });
    }

    /** Run the claim-handle-mark loop until `signal` aborts. */
    async run(signal: AbortSignal): Promise<void> {
        console.error("Supervisor worker watching state=supervisor-ready");
        let event: EventRow | null;
        while ((event = await this.watcher.claimNextEvent(signal)) !== null) {
            await this.handle(event);
        }
        console.error("Supervisor worker stopped");
    }

    /** Process a single claimed (now `supervising`) event. */
    private async handle(event: EventRow): Promise<void> {
        try {
            const prompt = event.supervisorPrompt ?? "(no prompt set)";
            console.log(`[supervisor] id=${event.id} topic=${event.topic} prompt=${prompt}`);
            // Future: invoke supervisor model with the prompt; handle
            // tool calls / approval gate flow.
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
