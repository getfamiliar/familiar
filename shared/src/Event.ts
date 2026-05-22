/**
 * Lifecycle states for an `events` row.
 *
 * Events are the immutable record of "the world said this happened".
 * They no longer participate in any worker state machine themselves —
 * the actual work runs in `agentruns` rows that reference the event.
 *
 * Transitions:
 *
 * - `pending`: row inserted by a host plugin via {@link EventBus.add}.
 * - `running`: the container's input-event watcher has spawned the root
 *   agentrun for this event.
 * - `done` / `failed`: set reactively when the last `pending` /
 *   `running` agentrun for this event settles. `failed` wins if any
 *   agentrun for the event has failed.
 */
export type EventState = "pending" | "running" | "done" | "failed";

/**
 * Standard priority tiers for events. Higher = processed first.
 * Producers should pick one of these rather than passing a bare number,
 * unless they have a specific reason. The SQL default for `events.priority`
 * is 50, matching `EVENT_PRIORITY.ASYNC`.
 */
export const EVENT_PRIORITY = {
    /** Direct user chat (telegram, cli-chat). Preempts async work. */
    CHAT: 100,
    /** Asynchronous external input — mail, group chat. Matches the SQL default. */
    ASYNC: 50,
    /** Cron-driven background work. Yields to chat and async. */
    BACKGROUND: 10,
} as const;

/**
 * Shape of a row in the `events` table after JSON-decoding from postgres.
 * The numeric `id` is kept as a string because postgres `bigint` exceeds
 * JavaScript's safe integer range.
 */
export interface EventRow {
    /**
     * Database primary key. `bigserial` is returned as a string because
     * postgres `bigint` exceeds JavaScript's safe integer range.
     */
    readonly id: string;
    /**
     * Event topic, matching `\w+(:\w+)*` (e.g. `mail`, `chat:whatsapp`,
     * `chat:telegram:group:reaction`). Each `:`-separated segment maps
     * to a folder when the container resolves the handler markdown.
     */
    readonly topic: string;
    /**
     * Higher = processed first within a queue. FIFO within priority.
     * Default 50. Inherited by all agentruns spawned for this event.
     */
    readonly priority: number;
    /** Lifecycle state — see {@link EventState}. */
    readonly state: EventState;
    /**
     * Event-specific data; arbitrary JSON. Schema is owned by the
     * producing plugin / topic, not by the bus.
     */
    readonly payload: unknown;
    /**
     * Globally unique key for dedup. `null` when the producer didn't
     * supply one (then no dedup happens).
     */
    readonly idempotencyKey: string | null;
    /**
     * Whether this event is a chat message from the user. When `true`,
     * `EventBus.add` mirrors `prompt` into `chatmessages` (role
     * `'user'`) in the same transaction as the event INSERT, so the
     * agent picks the message up via chat history rather than via the
     * agentrun's `prompt` field.
     */
    readonly isChat: boolean;
    /**
     * Channel the assistant should reply on (e.g. `"cli"`, `"telegram"`).
     * Stamped host-side at emit time, falling back to
     * `DEFAULT_CHAT_CHANNEL_ID`. The container never reads this field;
     * routing happens via JOIN in the chatmessages trigger and in
     * `ChatMessageBus`. May be `null` for non-chat events whose source
     * plugin didn't set a default routing target.
     */
    readonly preferredChatChannelId: string | null;
    /**
     * The event's primary user-visible text, written by the emitter.
     * Always populated:
     *
     * - For chat events (`isChat=true`): the user's chat message. Also
     *   mirrored into `chatmessages.text_content` (role `'user'`) by
     *   `EventBus.add`, which is the channel the AgentRunner consumes.
     * - For non-chat events: a first-person framing of what happened
     *   ("A new mail from Anna arrived: …"). The EventWatcher copies
     *   it into the root agentrun's `prompt` so the AgentRunner can
     *   append it as the trailing user message.
     */
    readonly prompt: string;
    /**
     * Override for the root agentrun's handler. `null` means the
     * input-event watcher uses `'index'` (i.e. resolves
     * `<topic>/index.md`). Set by the emitter via
     * {@link NewEvent.startHandler}; never mutated after insert.
     */
    readonly startHandler: string | null;
    /**
     * `true` when this event was emitted by a trusted user-input source
     * (the operator at the local terminal via cli-chat, the operator on
     * Telegram). Stamped at emit time, never mutated. Propagated verbatim
     * to the root agentrun and to every child agentrun spawned via
     * `queue_handler` / `call_handler`, so future system tools can gate
     * risky reads / writes
     * (editing SOUL.md, etc.) on whether the run descends from a trusted
     * input. `false` for everything else (mail, webhooks, cron-driven
     * workflows).
     */
    readonly privileged: boolean;
    /**
     * When `true` and the event terminates in `failed`, the host writes
     * a `role='assistant'` chatmessage `"Something went wrong processing
     * the chat message: <error>"` to this event before signalling settle.
     * Lets chat plugins surface failures through the ordinary chat
     * subscription path without each needing its own catch-block
     * rendering. No-op on `done`.
     */
    readonly outputChatOnFailure: boolean;
    /** Insert timestamp — postgres `now()` at INSERT. */
    readonly createdAt: Date;
    /** Last `update()` timestamp — bumped to `now()` on every update. */
    readonly updatedAt: Date;
}

/**
 * One auxiliary file to attach to an event at emit time. The host writes
 * each file under `<scratchDir>/<eventId>/<name>` inside the same
 * transaction that inserts the event row, so the container watcher only
 * ever observes events whose files are already on disk at
 * `/scratch/<event-id>/<name>` inside both the agent and every MCP
 * container.
 *
 * Two arms:
 * - `contents` — Buffer the host writes directly. Use when bytes are
 *   already in memory (e.g. just decoded from a base64 MCP response).
 * - `sourcePath` — absolute host path to a file the plugin has already
 *   written to disk. The host **moves** the file into the scratch dir
 *   (`fs.rename`, falling back to copy+unlink across filesystems); the
 *   plugin gives up ownership. Use for large files the plugin doesn't
 *   want to re-buffer in memory.
 *
 * `name` is a basename. Path separators and `..` segments are rejected
 * at emit; on collision within the same emit, the second file overwrites
 * the first (caller's responsibility to keep names unique).
 */
export type EventFile =
    | { readonly name: string; readonly contents: Buffer }
    | { readonly name: string; readonly sourcePath: string };

/**
 * Input shape for {@link EventBus.add}.
 *
 * `prompt` carries the event's primary user-visible text — for chat
 * events it's the user's message; for everything else it's a
 * first-person framing of what happened ("A new mail from Anna
 * arrived: …"). `EventBus.add` validates that the value is non-empty
 * after trimming, so plugins that bypass the type system still surface
 * the bug at emit time instead of leaving the AgentRunner with an
 * empty messages array.
 *
 * `payload` is optional structured supplementary data (Telegram
 * `update_id`, WhatsApp `group_jid`, etc.) — it never carries the
 * agent-visible text directly any more.
 *
 * `isChat` is just a flag. When `true`, `EventBus.add` mirrors
 * `prompt` into the `chatmessages` table so the AgentRunner picks the
 * message up via chat history; the agentrun's own `prompt` field
 * stays null for chat events to avoid double-counting the trailing
 * turn. The flag does not change the input shape — both arms have
 * identical fields — so this stays a single interface rather than a
 * discriminated union.
 */
export interface NewEvent {
    readonly topic: string;
    /**
     * Primary user-visible text. Required, non-empty after trimming.
     * See {@link NewEvent} for how it's persisted on each arm.
     */
    readonly prompt: string;
    /** Optional structured supplementary data; arbitrary JSON. */
    readonly payload?: unknown;
    /** Higher = processed first; default 50. */
    readonly priority?: number;
    /** Initial state; default `"pending"`. */
    readonly state?: EventState;
    /** Globally unique key for dedup; null = no dedup. */
    readonly idempotencyKey?: string;
    /**
     * Whether this event is a chat message from the user. Default
     * `false`. See {@link NewEvent} for the persistence consequences.
     */
    readonly isChat?: boolean;
    /**
     * Channel id the assistant should reply on. Plugins typically set
     * this to their own channel name (e.g. `"cli"`). When omitted, the
     * host's `HostContextImpl.emit` stamps `DEFAULT_CHAT_CHANNEL_ID`.
     *
     * If the producer is not a chat plugin, this should be `null` or omitted.
     */
    readonly preferredChatChannelId?: string | null;
    /**
     * Whether this event originates from a trusted user-input source.
     * Default `false` — the SQL column default covers omission. See
     * {@link EventRow.privileged} for the trust-model rationale.
     */
    readonly privileged?: boolean;
    /**
     * When `true` and the event terminates in `failed`, the host writes
     * a `role='assistant'` chatmessage carrying the failure text to this
     * event before `handle.settled` rejects. Default `false` — the SQL
     * column default covers omission. Chat plugins (cli-chat, telegram)
     * set this to `true` so users see failures through the same chat
     * subscription path that delivers normal replies. See
     * {@link EventRow.outputChatOnFailure}.
     */
    readonly outputChatOnFailure?: boolean;
    /**
     * When set, EventBus.add inserts a `role='user'` chatmessage with
     * this text in the same transaction as the event INSERT.
     *
     * Atomicity matters: a post-emit chatmessages INSERT acquires an
     * FK row-lock on the events row that conflicts with the input-event
     * watcher's `FOR UPDATE SKIP LOCKED` claim. If the watcher races
     * the chatmessage write, `SKIP LOCKED` skips the row and — because
     * the events_new NOTIFY has already been consumed — the event sits
     * pending forever. Doing the chatmessage INSERT inside the same
     * transaction closes the window: the FK lock is released before
     * NOTIFY events_new fires post-commit.
     *
     * Use this for plugin emitters that want a chatmessage text
     * different from `prompt` (e.g. cli-chat persists the slash-
     * prefixed `/topic/handler …` line while the handler sees only
     * the trailing prompt text). When unset and `isChat: true`, the
     * existing path inserts `prompt` itself.
     */
    readonly userChatMessage?: string;
    /**
     * Override which handler markdown the root agentrun runs. When
     * omitted, the input-event watcher uses `'index'` (i.e. resolves
     * `<topic>/index.md`). Useful when an emitter wants to skip the
     * triage `index.md` and invoke a specific handler directly.
     *
     * Pass the basename without `.md` (e.g. `'analyze'` resolves to
     * `<topic>/analyze.md`). The agentrun fails loud at handler-load
     * time if no such file exists — there is no shape validation
     * here, mirroring how `topic` is only regex-checked, not
     * existence-checked, at emit time.
     */
    readonly startHandler?: string;
    /**
     * Auxiliary files to stage at `/scratch/<event-id>/<name>` for this
     * event. Visible to the agent and to every MCP container under the
     * same absolute path. Staging happens atomically with the event
     * INSERT (inside the same transaction), so the container watcher
     * never sees an event whose files aren't yet on disk. See {@link
     * EventFile} for the two payload shapes.
     */
    readonly files?: readonly EventFile[];
}

/** Patch shape for {@link EventBus.update}. */
export interface EventPatch {
    readonly state?: EventState;
    readonly payload?: unknown;
    readonly priority?: number;
    readonly preferredChatChannelId?: string | null;
}

/** Filter for {@link EventBus.waitForNext}. */
export interface EventFilter {
    /** If set, only events whose topic is in this list will match. */
    readonly topics?: readonly string[];
    /** If set, only events in one of these states match (default `["pending"]`). */
    readonly states?: readonly EventState[];
}
