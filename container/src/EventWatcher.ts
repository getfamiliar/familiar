import {
    EventBus,
    type EventRow,
    type EventState,
    type NewEvent,
    type PostgresConnection,
} from "effective-assistant-shared";

/** Configuration for an {@link EventWatcher}. */
export interface EventWatcherConfig {
    /** Open postgres connection used for queries and the LISTEN client. Caller owns its lifecycle. */
    readonly connection: PostgresConnection;
    /** State this watcher claims events from (e.g. `"pending"` for triage). */
    readonly watchState: EventState;
    /** State the claimed event is transitioned into (e.g. `"triaging"`). */
    readonly claimedState: EventState;
}

/**
 * Iterator-style consumer of the bus-state events table inside the agent
 * container. Subscribes to a single {@link EventState}; each
 * {@link claimNextEvent} call atomically transitions the next matching
 * row to {@link EventWatcherConfig.claimedState} and returns it.
 *
 * Race-safe across multiple concurrent watcher processes — the claim is
 * a single `UPDATE ... FOR UPDATE SKIP LOCKED` round-trip in
 * {@link EventBus.claim}.
 *
 * One watcher per process (or per logical worker) is the intended
 * pattern. Two `claimNextEvent()` calls on the same watcher should not
 * run concurrently.
 *
 * The connection is *not* owned by the watcher; the caller (typically
 * the container entry point) builds and closes it.
 */
export class EventWatcher {
    private readonly bus: EventBus;
    private readonly watchState: EventState;
    private readonly claimedState: EventState;

    constructor(config: EventWatcherConfig) {
        this.bus = new EventBus(config.connection);
        this.watchState = config.watchState;
        this.claimedState = config.claimedState;
    }

    /**
     * Wait for and atomically claim the next event in `watchState`,
     * transitioning it to `claimedState`. Returns `null` when `signal`
     * aborts so callers can write
     * `while ((event = await w.claimNextEvent(signal)) !== null)`.
     *
     * @throws Other errors from the bus surface unchanged.
     */
    async claimNextEvent(signal?: AbortSignal): Promise<EventRow | null> {
        if (signal?.aborted) {
            return null;
        }
        try {
            return await this.bus.waitAndClaim(this.watchState, this.claimedState, signal);
        } catch (err) {
            if (signal?.aborted) {
                return null;
            }
            throw err;
        }
    }

    /** Transition an event to a new state (typically `done` or `failed`). */
    async setState(id: string, state: EventState): Promise<void> {
        await this.bus.update(id, { state });
    }

    /**
     * Insert a new event. Convenience for workers that spawn follow-up
     * events (e.g. triage spawning `supervisor-ready` jobs).
     */
    async addEvent(newEvent: NewEvent): Promise<EventRow> {
        return this.bus.add(newEvent);
    }
}
