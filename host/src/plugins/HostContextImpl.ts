import {
    EventBus,
    EVENTS_STATE_CHANNEL,
    type HostContext,
    type NewEvent,
    type NotificationHandler,
    type PostgresConnection,
} from "effective-assistant-shared";

/**
 * Dependencies a {@link HostContextImpl} needs from its owner. The
 * owner (typically {@link PluginHost}) owns the postgres connection's
 * lifecycle; the context only borrows it.
 */
export interface HostContextImplDeps {
    /** Open (or return the already-open) shared postgres connection. */
    ensureConnection(): Promise<PostgresConnection>;
    /** Sink for `ctx.log(...)` calls from plugin code. */
    log(message: string): void;
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
        emit: (event: NewEvent): Promise<string> => this.emitAndAwait(event),
    };

    log(message: string): void {
        this.deps.log(message);
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
     */
    private async emitAndAwait(event: NewEvent): Promise<string> {
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
        try {
            const row = await bus.add(event);
            waitedFor = row.id;

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
