import {
    AgentRunBus,
    EventBus,
    type EventRow,
    type Logger,
    type PostgresConnection,
} from "@getfamiliar/shared";

/**
 * Input-event watcher. Claims `pending` events into `running` and
 * inserts a root agentrun for each, pointing at the topic's `index`
 * handler. The event then sits in `running` until its root agentrun
 * settles — {@link AgentRunBus.settle} flips the event to `done` /
 * `failed` to mirror the root's terminal state via
 * `EVENT_TERMINAL_UPDATE_SQL`. Non-root agentruns (`call_handler`
 * children, `schedule_handler` immediate-mode children) settle out of
 * band and do not affect the event's outcome.
 *
 * This watcher does no handler resolution and runs no agent code; it
 * only routes input events to the agentrun queue. Markdown loading and
 * subagent resolution (`schedule_handler`, `call_handler`) live in the
 * {@link AgentrunScheduler}.
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
    private readonly log: Logger;

    constructor(connection: PostgresConnection, log: Logger) {
        this.log = log.child({ component: "event-watcher" });
        this.events = new EventBus(connection, this.log);
        this.agentruns = new AgentRunBus(connection);
    }

    /** Run the claim-and-spawn loop until `signal` aborts. */
    async run(signal: AbortSignal): Promise<void> {
        this.log.info("event watcher watching state=pending");
        for (;;) {
            const event = await this.claimNext(signal);
            if (event === null) {
                break;
            }
            await this.handle(event);
        }
        this.log.info("event watcher stopped");
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
     * handler — `event.startHandler` if the emitter set one, else
     * the default `index`. Topic, priority, and payload are copied
     * so the agentrun is self-contained for handler resolution and
     * execution.
     *
     * On insert failure the event is marked `failed` directly — no
     * agentrun ever existed for it, so the reactive terminal logic has
     * no tree to walk.
     */
    private async handle(event: EventRow): Promise<void> {
        try {
            // Copy the event's prompt onto the agentrun unconditionally
            // so a `psql` inspection of the row shows what triggered it
            // — chat or otherwise. AgentRunner skips the trailing
            // user-message append when chat history is non-empty, so
            // chat events don't end up with the user turn injected
            // twice (once via history, once via row.prompt).
            const root = await this.agentruns.add({
                eventId: event.id,
                topic: event.topic,
                handler: event.startHandler ?? "index",
                priority: event.priority,
                payload: event.payload,
                prompt: event.prompt,
                privileged: event.privileged,
            });
            this.log.info(`event ${event.id} claimed [${event.topic}], root agentrun ${root.id}`);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.log.error(`event ${event.id} handling failed: ${message}`);
            try {
                await this.events.update(event.id, { state: "failed" });
            } catch (markErr) {
                const markMessage = markErr instanceof Error ? markErr.message : String(markErr);
                this.log.error(`failed to mark event ${event.id} failed: ${markMessage}`);
            }
        }
    }
}
