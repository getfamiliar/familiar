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
 * Iterator-style consumer of the bus-state events table inside the agent
 * container. Owns a {@link PostgresConnection} and a topic-filtered
 * {@link EventBus}; exposes `nextEvent()` / `markX()` / `close()` so the
 * caller controls the loop and state-transition policy.
 *
 * Sequential by design: there's only one supervisor slot upstream, and
 * the bus does not atomically claim, so callers should not run multiple
 * concurrent `nextEvent()` waits on the same watcher.
 */
export class EventWatcher {
    private readonly connection: PostgresConnection;
    private readonly bus: EventBus;
    private readonly topic: string;

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
     * Wait for and return the next pending event matching this watcher's
     * topic. Resolves to `null` when `signal` aborts, so callers can
     * write `while ((event = await w.nextEvent(signal)) !== null)`.
     *
     * @throws Other errors from the bus surface unchanged.
     */
    async nextEvent(signal?: AbortSignal): Promise<EventRow | null> {
        if (signal?.aborted) {
            return null;
        }
        try {
            return await this.bus.waitForNext({ topics: [this.topic] }, signal);
        } catch (err) {
            if (signal?.aborted) {
                return null;
            }
            throw err;
        }
    }

    /** Transition an event to `processing`. */
    async markProcessing(id: string): Promise<void> {
        await this.bus.update(id, { state: "processing" });
    }

    /** Transition an event to `done`. */
    async markDone(id: string): Promise<void> {
        await this.bus.update(id, { state: "done" });
    }

    /** Transition an event to `failed`. */
    async markFailed(id: string): Promise<void> {
        await this.bus.update(id, { state: "failed" });
    }

    /** Close the underlying postgres connection (pool + listen client). */
    async close(): Promise<void> {
        await this.connection.close();
    }
}
