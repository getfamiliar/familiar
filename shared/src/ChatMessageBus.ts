import type { ChatFilter, ChatMessage, ChatRole, NewChatMessage } from "./ChatMessage";
import type { NotificationHandler, PostgresConnection } from "./PostgresConnection";
import { CHATMESSAGES_NEW_CHANNEL } from "./Schema";

/** Raw row shape returned by SELECTs against `chatmessages`. */
interface RawChatMessageRow {
    id: string;
    event_id: string;
    role: string;
    text_content: string;
    created_at: Date;
    delivered_at: Date | null;
}

/**
 * Disposer returned by {@link ChatMessageBus.subscribe}. Calling it
 * detaches the underlying NOTIFY handler. Idempotent: calling more than
 * once is safe.
 */
export type ChatUnsubscribe = () => Promise<void>;

/**
 * Async handler invoked for every chat message matching a subscription's
 * filter. Returns `true` once the message is considered delivered to the
 * end user; the bus then sets `delivered_at`. Returning `false` (or
 * throwing) leaves the row undelivered so a later subscriber can pick
 * it up on its replay.
 */
export type ChatHandler = (message: ChatMessage) => Promise<boolean>;

/**
 * Domain client for the `chatmessages` table.
 *
 * Three responsibilities:
 *
 * 1. Persistence of assistant replies (`insertAssistantMessage`). User
 *    messages are persisted by `EventBus.add` directly when the event
 *    has `isChat=true`, so they don't have a public method here.
 * 2. History retrieval for the agent (`fetchHistoryForEvent`). Returns
 *    every message on the same channel as the given event, oldest
 *    first. The container's `ChatManager` wraps this for the LLM.
 * 3. At-least-once channel delivery (`subscribe`). New subscribers
 *    replay all undelivered matching rows on registration; live rows
 *    arrive via the `chatmessages_new` NOTIFY channel. A handler
 *    returning `true` marks the row delivered; multiple matching
 *    listeners is fine — the UPDATE is idempotent.
 *
 * The bus has no notion of channel-binding: callers pass `eventId` or
 * the full filter on each call. Channel routing happens via JOIN to
 * `events.preferred_chat_channel_id`, NOT a denormalized column on
 * `chatmessages`.
 */
export class ChatMessageBus {
    private readonly connection: PostgresConnection;

    constructor(connection: PostgresConnection) {
        this.connection = connection;
    }

    /**
     * Insert one assistant reply. Returns the persisted row. Used by
     * the container's `send_chat` tool via `ChatManager`.
     */
    async insertAssistantMessage(eventId: string, textContent: string): Promise<ChatMessage> {
        return this.insert({ eventId, role: "assistant", textContent });
    }

    /**
     * Insert a row of any role. The atomic-with-event INSERT path used
     * by `EventBus.add` for user messages bypasses this method (it
     * issues the INSERT inside its own transaction); this is provided
     * for tests and for callers that already hold their own
     * transaction.
     */
    async insert(input: NewChatMessage): Promise<ChatMessage> {
        const result = await this.connection.getPool().query<RawChatMessageRow>(
            `INSERT INTO chatmessages (event_id, role, text_content)
             VALUES ($1, $2, $3)
             RETURNING *`,
            [input.eventId, input.role, input.textContent],
        );
        return mapRow(result.rows[0]);
    }

    /** Fetch one row by id. Returns `undefined` if not found. */
    async getById(id: string): Promise<ChatMessage | undefined> {
        const result = await this.connection
            .getPool()
            .query<RawChatMessageRow>(`SELECT * FROM chatmessages WHERE id = $1`, [id]);
        return result.rows.length > 0 ? mapRow(result.rows[0]) : undefined;
    }

    /**
     * Return every chat message on the same channel as the given event,
     * oldest first. The channel is resolved via the join
     *   `chatmessages.event_id → events.preferred_chat_channel_id`,
     * which lets the container request "the conversation this agentrun
     * is part of" without ever naming a channel itself.
     *
     * If the parent event has no `preferred_chat_channel_id`, only
     * messages tied to that exact event are returned (no cross-event
     * thread to attach to).
     */
    async fetchHistoryForEvent(eventId: string): Promise<ChatMessage[]> {
        const result = await this.connection.getPool().query<RawChatMessageRow>(
            `WITH anchor AS (
               SELECT preferred_chat_channel_id AS channel
               FROM events WHERE id = $1
             )
             SELECT cm.*
             FROM chatmessages cm
             JOIN events e ON e.id = cm.event_id
             CROSS JOIN anchor
             WHERE (
               anchor.channel IS NOT NULL
                 AND e.preferred_chat_channel_id = anchor.channel
             ) OR (
               anchor.channel IS NULL
                 AND cm.event_id = $1
             )
             ORDER BY cm.created_at ASC, cm.id ASC`,
            [eventId],
        );
        return result.rows.map(mapRow);
    }

    /**
     * Subscribe to chat messages matching `filter`. Returns an
     * unsubscribe function.
     *
     * Delivery semantics:
     *
     * - LISTEN is attached BEFORE the replay SELECT, so any row inserted
     *   between SELECT and attach won't be missed. NOTIFY-driven
     *   delivery is still gated by `delivered_at IS NULL`, so the same
     *   row is never delivered twice via this subscription.
     * - The replay SELECT returns every undelivered matching row in
     *   `created_at` order; each is awaited through the handler.
     * - When the handler returns `true`, the bus runs
     *   `UPDATE chatmessages SET delivered_at = now() WHERE id = $1
     *    AND delivered_at IS NULL` — a no-op if a concurrent subscriber
     *   has already marked it.
     * - Handler errors are caught and logged so one bad subscriber
     *   doesn't break others.
     *
     * Multiple matching subscribers will each see the row; the first
     * to return `true` "wins" the delivery write. This is idempotent
     * and matches the at-least-once contract: handlers must tolerate
     * being called for an already-displayed message.
     */
    async subscribe(filter: ChatFilter, handler: ChatHandler): Promise<ChatUnsubscribe> {
        const seenLive = new Set<string>();

        const dispatch = async (message: ChatMessage): Promise<void> => {
            if (!matchesFilter(message, filter)) {
                return;
            }
            if (message.deliveredAt !== null) {
                return;
            }
            try {
                const ok = await handler(message);
                if (ok) {
                    await this.markDelivered(message.id);
                }
            } catch (err) {
                console.error(
                    `ChatMessageBus subscribe handler error for id=${message.id}: ${err instanceof Error ? err.message : String(err)}`,
                );
            }
        };

        const listenHandler: NotificationHandler = (payload) => {
            void this.dispatchNotification(payload, filter, seenLive, dispatch);
        };

        await this.connection.listen(CHATMESSAGES_NEW_CHANNEL, listenHandler);

        try {
            const undelivered = await this.fetchUndelivered(filter);
            for (const row of undelivered) {
                seenLive.add(row.id);
                await dispatch(row);
            }
        } catch (err) {
            await this.connection.unlisten(CHATMESSAGES_NEW_CHANNEL, listenHandler);
            throw err;
        }

        let disposed = false;
        return async () => {
            if (disposed) {
                return;
            }
            disposed = true;
            await this.connection.unlisten(CHATMESSAGES_NEW_CHANNEL, listenHandler);
        };
    }

    /**
     * Parse a NOTIFY payload, prefilter on the prefix, fetch the row,
     * and hand it to the dispatcher. The `seenLive` set deduplicates
     * against the replay SELECT so a row picked up by both paths is
     * delivered exactly once per subscription.
     */
    private async dispatchNotification(
        payload: string,
        filter: ChatFilter,
        seenLive: Set<string>,
        dispatch: (m: ChatMessage) => Promise<void>,
    ): Promise<void> {
        const parsed = parseNotifyPayload(payload);
        if (!parsed) {
            return;
        }
        if (filter.channelId !== undefined && parsed.channelId !== filter.channelId) {
            return;
        }
        if (filter.role !== undefined && parsed.role !== filter.role) {
            return;
        }
        if (seenLive.has(parsed.id)) {
            return;
        }
        seenLive.add(parsed.id);
        try {
            const row = await this.getById(parsed.id);
            if (!row) {
                return;
            }
            await dispatch(row);
        } catch (err) {
            console.error(
                `ChatMessageBus notification dispatch error for id=${parsed.id}: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }

    /**
     * SELECT all undelivered rows that match `filter`, oldest first.
     * Channel filter joins to `events.preferred_chat_channel_id`.
     */
    private async fetchUndelivered(filter: ChatFilter): Promise<ChatMessage[]> {
        const conditions: string[] = ["cm.delivered_at IS NULL"];
        const values: unknown[] = [];
        let n = 1;

        if (filter.channelId !== undefined) {
            conditions.push(`e.preferred_chat_channel_id = $${n++}`);
            values.push(filter.channelId);
        }
        if (filter.role !== undefined) {
            conditions.push(`cm.role = $${n++}`);
            values.push(filter.role);
        }

        const sql = `SELECT cm.*
                     FROM chatmessages cm
                     JOIN events e ON e.id = cm.event_id
                     WHERE ${conditions.join(" AND ")}
                     ORDER BY cm.created_at ASC, cm.id ASC`;

        const result = await this.connection.getPool().query<RawChatMessageRow>(sql, values);
        return result.rows.map(mapRow);
    }

    /** Conditional UPDATE to set delivered_at; no-op if already set. */
    private async markDelivered(id: string): Promise<void> {
        await this.connection.getPool().query(
            `UPDATE chatmessages SET delivered_at = now()
                 WHERE id = $1 AND delivered_at IS NULL`,
            [id],
        );
    }
}

/** Convert a snake_case raw row into the camelCase {@link ChatMessage}. */
function mapRow(raw: RawChatMessageRow): ChatMessage {
    return {
        id: raw.id,
        eventId: raw.event_id,
        role: raw.role as ChatRole,
        textContent: raw.text_content,
        createdAt: raw.created_at,
        deliveredAt: raw.delivered_at,
    };
}

/**
 * Parse the `<channel_id>:<role>:<id>` NOTIFY payload. Returns
 * `undefined` if the shape is unexpected. The channel id may be empty
 * (when the parent event had no `preferred_chat_channel_id`); we keep
 * it as the empty string in that case.
 */
function parseNotifyPayload(
    payload: string,
): { channelId: string; role: ChatRole; id: string } | undefined {
    const firstColon = payload.indexOf(":");
    if (firstColon < 0) {
        return undefined;
    }
    const lastColon = payload.lastIndexOf(":");
    if (lastColon === firstColon) {
        return undefined;
    }
    const channelId = payload.slice(0, firstColon);
    const role = payload.slice(firstColon + 1, lastColon);
    const id = payload.slice(lastColon + 1);
    if (role !== "user" && role !== "assistant") {
        return undefined;
    }
    return { channelId, role, id };
}

function matchesFilter(message: ChatMessage, filter: ChatFilter): boolean {
    if (filter.role !== undefined && message.role !== filter.role) {
        return false;
    }
    return true;
}
