import {
    AgentRunBus,
    EventBus,
    type EventRow,
    type PostgresConnection,
} from "effective-assistant-shared";

/**
 * Input-event watcher. Claims `pending` events into `running` and
 * inserts a root agentrun for each, pointing at the topic's `index`
 * handler. The event then sits in `running` until its agentrun tree
 * settles — {@link AgentRunBus.settle} flips it to `done` / `failed`
 * via the reactive `EVENT_TERMINAL_UPDATE_SQL` once no agentruns for
 * the event remain pending or running.
 *
 * This watcher does no handler resolution and runs no agent code; it
 * only routes input events to the agentrun queue. Markdown loading and
 * `queue_next` resolution live in {@link AgentrunWatcher}.
 *
 * **Crash window** (intentional, fix in a later pass): if the process
 * dies between the event claim and the agentrun insert, the event is
 * stuck in `running` with no agentruns. The reactive terminal logic
 * never fires for it. The insert-failure path below catches the in-
 * process error and marks the event `failed`; a hard process crash
 * between the two writes is not yet covered.
 */
export class EventWatcher {
    private readonly events: EventBus;
    private readonly agentruns: AgentRunBus;

    constructor(connection: PostgresConnection) {
        this.events = new EventBus(connection);
        this.agentruns = new AgentRunBus(connection);
    }

    /** Run the claim-and-spawn loop until `signal` aborts. */
    async run(signal: AbortSignal): Promise<void> {
        console.error("Event watcher watching state=pending");
        for (;;) {
            const event = await this.claimNext(signal);
            if (event === null) {
                break;
            }
            await this.handle(event);
        }
        console.error("Event watcher stopped");
    }

    /**
     * Block until the next pending event is available, atomically claim
     * it (`pending → running`), and return it. Returns `null` when
     * `signal` aborts so the caller's loop can exit cleanly.
     *
     * @throws Errors from the bus that aren't caused by the abort.
     */
    private async claimNext(signal: AbortSignal): Promise<EventRow | null> {
        if (signal.aborted) {
            return null;
        }
        try {
            return await this.events.waitAndClaim("pending", "running", signal);
        } catch (err) {
            if (signal.aborted) {
                return null;
            }
            throw err;
        }
    }

    /**
     * Insert a root agentrun for `event` pointing at the topic's
     * `index` handler. Topic, priority, and payload are copied so the
     * agentrun is self-contained for handler resolution and execution.
     *
     * On insert failure the event is marked `failed` directly — no
     * agentrun ever existed for it, so the reactive terminal logic has
     * no tree to walk.
     */
    private async handle(event: EventRow): Promise<void> {
        try {
            const root = await this.agentruns.add({
                eventId: event.id,
                topic: event.topic,
                handler: "index",
                priority: event.priority,
                payload: event.payload,
            });
            console.log(
                `[event] id=${event.id} topic=${event.topic} → root agentrun id=${root.id}`,
            );
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`Event handling failed for id=${event.id}: ${message}`);
            try {
                await this.events.update(event.id, { state: "failed" });
            } catch (markErr) {
                console.error(
                    `Also failed to mark event id=${event.id} failed: ${markErr instanceof Error ? markErr.message : String(markErr)}`,
                );
            }
        }
    }
}
