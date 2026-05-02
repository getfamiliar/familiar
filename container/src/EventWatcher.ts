import {
    EventBus,
    type EventRow,
    POSTGRES_DB,
    POSTGRES_HOST,
    POSTGRES_PORT,
    POSTGRES_USER,
    PostgresConnection,
} from "effective-assistant-shared";

/**
 * Long-running consumer of the bus-state events table inside the agent
 * container. Subscribes to a single topic for the verification scenario:
 * receives an event, prints it, and marks it `processed`. This is the
 * skeleton the future triage worker will hang off of.
 */
export class EventWatcher {
    private readonly connection: PostgresConnection;
    private readonly bus: EventBus;
    private readonly topic: string;
    private readonly abortController = new AbortController();

    constructor(topic: string, password: string) {
        this.topic = topic;
        this.connection = new PostgresConnection({
            host: POSTGRES_HOST,
            port: POSTGRES_PORT,
            user: POSTGRES_USER,
            password,
            database: POSTGRES_DB,
        });
        this.bus = new EventBus(this.connection);
    }

    /**
     * Run the watch loop until {@link requestStop} is called. Each
     * matching event is logged and then transitioned to `processed`.
     */
    async run(): Promise<void> {
        console.error(`Event watcher subscribed to topic "${this.topic}"`);
        while (!this.abortController.signal.aborted) {
            let event: EventRow;
            try {
                event = await this.bus.waitForNext(
                    { topics: [this.topic] },
                    this.abortController.signal,
                );
            } catch (err) {
                if (this.abortController.signal.aborted) {
                    break;
                }
                console.error(
                    `EventWatcher error: ${err instanceof Error ? err.message : String(err)}`,
                );
                await this.sleep(500);
                continue;
            }

            console.log(
                `[event] id=${event.id} topic=${event.topic} payload=${JSON.stringify(event.payload)}`,
            );

            try {
                await this.bus.update(event.id, { state: "processed" });
            } catch (err) {
                console.error(
                    `EventWatcher update failed for id=${event.id}: ${err instanceof Error ? err.message : String(err)}`,
                );
            }
        }
        await this.connection.close();
        console.error("Event watcher stopped");
    }

    /** Signal the loop to stop after the current wait completes. */
    requestStop(): void {
        this.abortController.abort();
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
