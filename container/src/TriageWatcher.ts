import type { EventRow, PostgresConnection } from "effective-assistant-shared";
import { EventWatcher } from "./EventWatcher";

/**
 * Triage worker. Claims events in `pending`, runs the (placeholder)
 * triage policy, marks them `done` — or `failed` on error.
 *
 * Real triage will: load subscribed plugins for the event's topic, run
 * their triage functions, and insert any *new* events with state
 * `supervisor-ready` for the supervisor worker to pick up. The input
 * event itself transitions to `done` regardless of how many supervisor
 * jobs were spawned.
 */
export class TriageWatcher {
    private readonly watcher: EventWatcher;

    constructor(connection: PostgresConnection) {
        this.watcher = new EventWatcher({
            connection,
            watchState: "pending",
            claimedState: "triaging",
        });
    }

    /** Run the claim-handle-mark loop until `signal` aborts. */
    async run(signal: AbortSignal): Promise<void> {
        console.error("Triage worker watching state=pending");
        let event: EventRow | null;
        while ((event = await this.watcher.claimNextEvent(signal)) !== null) {
            await this.handle(event);
        }
        console.error("Triage worker stopped");
    }

    /**
     * Process a single claimed (now `triaging`) event.
     *
     * Placeholder policy: spawn one supervisor-ready event per input
     * with a generic prompt, then mark the input event done. Real
     * triage will run plugin functions and decide *whether* to spawn,
     * what topic to spawn, and how to format the prompt.
     */
    private async handle(event: EventRow): Promise<void> {
        try {
            const supervisorPrompt = `Process the following payload: ${JSON.stringify(event.payload)}`;
            const spawned = await this.watcher.addEvent({
                topic: event.topic,
                payload: event.payload,
                state: "supervisor-ready",
                supervisorPrompt,
                causationChain: [event.id],
            });
            console.log(
                `[triage] id=${event.id} topic=${event.topic} → spawned supervisor job id=${spawned.id}`,
            );
            await this.watcher.setState(event.id, "done");
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`Triage failed for id=${event.id}: ${message}`);
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
