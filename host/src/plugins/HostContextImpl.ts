import {
    type ChatFilter,
    type ChatHandler,
    ChatMessageBus,
    type ChatUnsubscribe,
    EVENTS_STATE_CHANNEL,
    EventBus,
    type HostContext,
    type Logger,
    type NewEvent,
    type NotificationHandler,
    type PostgresConnection,
    StepResultBus,
    type StepResultRow,
    type StepResultUnsubscribe,
} from "effective-assistant-shared";

/**
 * Dependencies a {@link HostContextImpl} needs from its owner. The
 * owner (typically {@link PluginHost}) owns the postgres connection's
 * lifecycle; the context only borrows it.
 */
export interface HostContextImplDeps {
    /** Open (or return the already-open) shared postgres connection. */
    ensureConnection(): Promise<PostgresConnection>;
    /**
     * Default chat channel id, stamped onto events whose emitter did
     * not specify a `preferredChatChannelId`. Resolved lazily so
     * commands that never touch chat don't trigger env validation.
     */
    defaultChatChannelId(): string;
    /**
     * Per-plugin logger used by `ctx.log(...)`. The owner is expected
     * to scope this to the plugin (e.g. via `Logger.child`) before
     * handing it off so records carry a stable component tag.
     */
    log: Logger;
}

/**
 * Concrete {@link HostContext} used by the host process.
 *
 * Lives in its own class so {@link PluginHost} stays focused on
 * plugin-lifecycle concerns and so the contract — what plugins are
 * allowed to do — has a single, easily-testable home. New ctx
 * capabilities (scheduling, approval, completion-waits beyond emit)
 * land on this class as they are designed.
 *
 * Plugins must reach host capabilities only through `HostContext`;
 * see `feedback_plugin_ctx_only` in memory.
 */
export class HostContextImpl implements HostContext {
    private readonly deps: HostContextImplDeps;

    constructor(deps: HostContextImplDeps) {
        this.deps = deps;
    }

    readonly events = {
        emit: (
            event: NewEvent,
            onStep?: (step: StepResultRow) => void | Promise<void>,
            onEventInserted?: (eventId: string) => void,
        ): Promise<string> => this.emitAndAwait(event, onStep, onEventInserted),
    };

    readonly chat = {
        subscribe: (filter: ChatFilter, handler: ChatHandler): Promise<ChatUnsubscribe> =>
            this.subscribeChat(filter, handler),
    };

    log(message: string): void {
        this.deps.log.info(message);
    }

    /**
     * Open a {@link ChatMessageBus} subscription for the shared host
     * connection and return its unsubscribe disposer. The bus replays
     * undelivered matching messages on registration, so a plugin that
     * comes online after an assistant message was produced still sees
     * the message and can mark it delivered.
     */
    private async subscribeChat(
        filter: ChatFilter,
        handler: ChatHandler,
    ): Promise<ChatUnsubscribe> {
        const conn = await this.deps.ensureConnection();
        const bus = new ChatMessageBus(conn);
        return bus.subscribe(filter, handler);
    }

    /**
     * Insert the event, then block until the row reaches `done` or
     * `failed`. Returns the last-settled agentrun's `result_text` on
     * success; throws on failure.
     *
     * The listener is installed *before* the INSERT to close the race
     * where the agent could process the event between the insert
     * returning and us subscribing. After insert, a one-shot SELECT
     * covers the (rarer) race where the event terminated before we
     * even saw the NOTIFY.
     *
     * When `onStep` is provided, a second LISTEN on
     * `stepresults_new` is installed (also before the INSERT) and the
     * callback is invoked for every step row whose `event_id`
     * matches. Errors thrown inside `onStep` are caught and logged so
     * a buggy subscriber can't break the emit. When `onStep` is
     * omitted, no step listener is registered.
     */
    private async emitAndAwait(
        event: NewEvent,
        onStep?: (step: StepResultRow) => void | Promise<void>,
        onEventInserted?: (eventId: string) => void,
    ): Promise<string> {
        const conn = await this.deps.ensureConnection();
        const bus = new EventBus(conn);

        let waitedFor: string | undefined;
        let terminalState: "done" | "failed" | undefined;
        const wakers: Array<() => void> = [];
        const handler: NotificationHandler = (payload) => {
            const colon = payload.indexOf(":");
            if (colon < 0) {
                return;
            }
            const id = payload.slice(0, colon);
            const state = payload.slice(colon + 1);
            if (id !== waitedFor) {
                return;
            }
            if (state !== "done" && state !== "failed") {
                return;
            }
            terminalState = state;
            for (const wake of wakers.splice(0)) {
                wake();
            }
        };

        await conn.listen(EVENTS_STATE_CHANNEL, handler);
        let stepUnsubscribe: StepResultUnsubscribe | undefined;
        if (onStep) {
            const stepBus = new StepResultBus(conn);
            stepUnsubscribe = await stepBus.listen(async (step) => {
                if (step.eventId !== waitedFor) {
                    return;
                }
                try {
                    await onStep(step);
                } catch (err) {
                    this.deps.log.error(
                        {
                            stepId: step.id,
                            err: err instanceof Error ? err.message : String(err),
                        },
                        "events.emit onStep callback error",
                    );
                }
            });
        }
        try {
            const stamped: NewEvent =
                event.preferredChatChannelId === undefined
                    ? { ...event, preferredChatChannelId: this.deps.defaultChatChannelId() }
                    : event;
            const row = await bus.add(stamped);
            waitedFor = row.id;
            if (onEventInserted) {
                try {
                    onEventInserted(row.id);
                } catch (err) {
                    this.deps.log.error(
                        {
                            eventId: row.id,
                            err: err instanceof Error ? err.message : String(err),
                        },
                        "events.emit onEventInserted callback error",
                    );
                }
            }

            // Close the early-settle race: NOTIFY may have fired
            // between the INSERT and our setting `waitedFor`.
            const current = await fetchEventState(conn, row.id);
            if (current === "done" || current === "failed") {
                terminalState = current;
            }

            while (!terminalState) {
                await new Promise<void>((resolve) => {
                    wakers.push(resolve);
                });
            }

            if (terminalState === "failed") {
                const err = await fetchFailureError(conn, row.id);
                throw new Error(
                    `Event ${row.id} (${event.topic}) failed: ${err ?? "(no error message)"}`,
                );
            }
            return (await fetchFinalResultText(conn, row.id)) ?? "";
        } finally {
            if (stepUnsubscribe) {
                await stepUnsubscribe();
            }
            await conn.unlisten(EVENTS_STATE_CHANNEL, handler);
        }
    }
}

/**
 * Read the current `state` of an `events` row by id. Returns
 * `"unknown"` if the row vanished (shouldn't happen in normal flow).
 */
async function fetchEventState(conn: PostgresConnection, id: string): Promise<string> {
    const result = await conn
        .getPool()
        .query<{ state: string }>(`SELECT state FROM events WHERE id = $1`, [id]);
    return result.rows[0]?.state ?? "unknown";
}

/**
 * Fetch the most-recently-updated agentrun's `result_text` for an
 * event. Defines "the final agentrun" as whichever row's terminal
 * write triggered the event terminal recompute — i.e. the latest
 * `updated_at`. Returns `null` if the agentrun left it unset.
 */
async function fetchFinalResultText(
    conn: PostgresConnection,
    eventId: string,
): Promise<string | null> {
    const result = await conn.getPool().query<{ result_text: string | null }>(
        `SELECT result_text FROM agentruns
         WHERE event_id = $1
         ORDER BY updated_at DESC
         LIMIT 1`,
        [eventId],
    );
    return result.rows[0]?.result_text ?? null;
}

/**
 * Fetch the error message of the most-recently-updated `failed`
 * agentrun for an event. Returns `null` if no failed agentrun is
 * found (shouldn't happen if the event is in `failed`).
 */
async function fetchFailureError(
    conn: PostgresConnection,
    eventId: string,
): Promise<string | null> {
    const result = await conn.getPool().query<{ error: string | null }>(
        `SELECT error FROM agentruns
         WHERE event_id = $1 AND state = 'failed'
         ORDER BY updated_at DESC
         LIMIT 1`,
        [eventId],
    );
    return result.rows[0]?.error ?? null;
}
