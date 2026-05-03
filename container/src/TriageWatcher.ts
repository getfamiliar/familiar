import type { EventRow, PostgresConnection } from "effective-assistant-shared";
import { EventWatcher } from "./EventWatcher";

/**
 * Placeholder input-event watcher. Claims `pending` events into
 * `running` and marks them `done`.
 *
 * This file is a temporary stub kept so the container compiles after
 * the events/agentruns split. The real input-event watcher (which
 * spawns a root agentrun per event and lets the agentrun lifecycle
 * drive the event terminal state) lands in the next plan.
 */
export class TriageWatcher {
    private readonly watcher: EventWatcher;

    constructor(connection: PostgresConnection) {
        this.watcher = new EventWatcher({
            connection,
            watchState: "pending",
            claimedState: "running",
        });
    }

    /** Claim-and-finish loop until `signal` aborts. */
    async run(signal: AbortSignal): Promise<void> {
        console.error("Input-event watcher (stub) watching state=pending");
        for (;;) {
            const event = await this.watcher.claimNextEvent(signal);
            if (event === null) {
                break;
            }
            await this.handle(event);
        }
        console.error("Input-event watcher stopped");
    }

    private async handle(event: EventRow): Promise<void> {
        try {
            console.log(`[input-event] id=${event.id} topic=${event.topic} (stub: marking done)`);
            await this.watcher.setState(event.id, "done");
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`Input-event handling failed for id=${event.id}: ${message}`);
            try {
                await this.watcher.setState(event.id, "failed");
            } catch (markErr) {
                console.error(
                    `Also failed to mark id=${event.id} failed: ${markErr instanceof Error ? markErr.message : String(markErr)}`,
                );
            }
        }
    }
}
