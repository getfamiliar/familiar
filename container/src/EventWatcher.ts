import {
    AgentRunBus,
    EventBus,
    type EventRow,
    type Logger,
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
     * `index` handler. Topic, priority, and payload are copied so the
     * agentrun is self-contained for handler resolution and execution.
     *
     * On insert failure the event is marked `failed` directly — no
     * agentrun ever existed for it, so the reactive terminal logic has
     * no tree to walk.
     */
    private async handle(event: EventRow): Promise<void> {
        try {
            // Only forward `prompt` for non-chat events. For chat
            // events the same text was mirrored into `chatmessages` at
            // emit time, and the AgentRunner consumes it via chat
            // history; setting `agentrun.prompt` too would duplicate
            // the trailing user turn.
            const promptForAgentrun = event.isChat ? null : event.prompt;
            const root = await this.agentruns.add({
                eventId: event.id,
                topic: event.topic,
                handler: "index",
                priority: event.priority,
                payload: event.payload,
                prompt: promptForAgentrun,
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
