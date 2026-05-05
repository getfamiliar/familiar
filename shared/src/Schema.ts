/**
 * SQL that defines the bus-state schema. Idempotent: every statement is
 * `IF NOT EXISTS` / `CREATE OR REPLACE` / `DROP IF EXISTS`, so it's safe
 * to run on every daemon start without a migrations framework.
 *
 * Two tables:
 *
 * - `events` is the immutable record of "the world said this happened".
 *   One row per external trigger, idempotency-keyed. Events do not
 *   participate in any worker state machine themselves; they are
 *   referenced by `agentruns` rows that do the actual work.
 * - `agentruns` is the assistant's response tree. Each row is one agent
 *   invocation. The container's input-event watcher inserts the root
 *   agentrun for each new event; child agentruns are spawned by the
 *   queue-next tool inside a running handler.
 *
 * Four tables, five NOTIFY channels:
 *
 * - `events_new` — fires on INSERT into `events`. Wakes the container's
 *   input-event watcher.
 * - `events_state` — fires on state UPDATE on `events`. Lets host-side
 *   plugins wait for a specific event to settle.
 * - `agentruns_changed` — fires on INSERT and on state UPDATE on
 *   `agentruns`. Wakes the agentrun watcher.
 * - `stepresults_new` — fires on INSERT into `stepresults`. Lets host-side
 *   subscribers (e.g. `HostContext.events.emit`'s `onStep` callback) tail
 *   per-step audit rows as the agent loop produces them. Payload format
 *   is `<event_id>:<agent_run_id>:<id>` so subscribers can route on
 *   event_id without a JOIN.
 * - `chatmessages_new` — fires on INSERT into `chatmessages`. Lets
 *   host-side channel plugins (cli-chat, telegram, …) stream assistant
 *   replies. Payload format is `<channel_id>:<role>:<id>`; channel is
 *   JOINed from `events.preferred_chat_channel_id` so subscribers can
 *   filter on the prefix without a query roundtrip.
 */

export const EVENTS_NEW_CHANNEL = "events_new";
export const EVENTS_STATE_CHANNEL = "events_state";
export const AGENTRUNS_CHANNEL = "agentruns_changed";
export const STEPRESULTS_NEW_CHANNEL = "stepresults_new";
export const CHATMESSAGES_NEW_CHANNEL = "chatmessages_new";

/**
 * Topic regex used by the events check constraint and by the container
 * runtime when resolving handler files. One word, optionally followed
 * by any number of `:`-prefixed sub-topic words. Examples:
 * `mail`, `chat:cli`, `chat:telegram:group:reaction`.
 *
 * The container resolves a handler for topic `a:b:c` by walking the
 * chain `a/b/c/<basename>.md → a/b/<basename>.md → a/<basename>.md`
 * deepest-first and merging every existing layer (see HandlerFile.load).
 */
export const TOPIC_PATTERN = "^\\w+(:\\w+)*$";

export const SCHEMA_SQL = `
-- Drop legacy single-table artifacts from before the events/agentruns
-- split. Safe no-ops on fresh databases. The current schema reuses the
-- name events_notify_new() for its own NOTIFY function, so we do NOT
-- drop it here (CREATE OR REPLACE FUNCTION below handles the update);
-- dropping would fail anyway once the current events_new_trg exists.
DROP TRIGGER IF EXISTS events_notify_changed_trg ON events;
DROP TRIGGER IF EXISTS events_notify_new_trg ON events;
DROP FUNCTION IF EXISTS events_notify_changed();
DROP INDEX IF EXISTS events_pending_priority_idx;
DROP INDEX IF EXISTS events_state_priority_idx;

CREATE TABLE IF NOT EXISTS events (
  id              bigserial PRIMARY KEY,
  topic           text NOT NULL,
  priority        smallint NOT NULL DEFAULT 50,
  state           text NOT NULL DEFAULT 'pending',
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text UNIQUE,
  privileged      boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT events_topic_format CHECK (topic ~ '${TOPIC_PATTERN}')
);

-- Drop legacy columns from earlier schema generations. Single-instance
-- project; column drops are fine.
ALTER TABLE events DROP COLUMN IF EXISTS supervisor_prompt;
ALTER TABLE events DROP COLUMN IF EXISTS causation_chain;

-- Chat-aware event metadata. \`is_chat\` opts into automatic user-message
-- persistence in EventBus.add; \`preferred_chat_channel_id\` names the
-- channel an assistant reply should reach the user on. The container is
-- channel-blind — both fields are read host-side (for routing) or via
-- JOIN inside the chatmessages NOTIFY trigger.
ALTER TABLE events ADD COLUMN IF NOT EXISTS is_chat boolean NOT NULL DEFAULT false;
ALTER TABLE events ADD COLUMN IF NOT EXISTS preferred_chat_channel_id text;
-- Required for non-chat events (validated at \`EventBus.add\` time and at
-- the type level via \`NewEvent\`'s discriminated union); always null for
-- chat events because the user's text in \`chatmessages\` already serves
-- as the agent-visible "what happened" message. The EventWatcher copies
-- this verbatim into the root \`agentruns.prompt\` so the agent sees the
-- emitter's framing without the EventWatcher having to reach into the
-- payload schema.
ALTER TABLE events ADD COLUMN IF NOT EXISTS prompt text;
-- Privileged events originate from a trusted user-input source (operator
-- at the local terminal via cli-chat, operator on Telegram). The flag
-- propagates verbatim to the root agentrun and to every child agentrun
-- spawned via queue_run, so future system tools can gate risky reads /
-- writes (editing SOUL.md etc.) on whether the run descends from a
-- trusted input. Default false: any plugin that doesn't explicitly opt
-- in produces non-privileged events.
ALTER TABLE events ADD COLUMN IF NOT EXISTS privileged boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS events_state_priority_idx
  ON events (state, priority DESC, id ASC);
CREATE INDEX IF NOT EXISTS events_topic_idx ON events (topic);

CREATE TABLE IF NOT EXISTS agentruns (
  id                 bigserial PRIMARY KEY,
  event_id           bigint NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  parent_agentrun_id bigint REFERENCES agentruns(id) ON DELETE CASCADE,
  topic              text NOT NULL,
  handler            text NOT NULL,
  priority           smallint NOT NULL DEFAULT 50,
  state              text NOT NULL DEFAULT 'pending',
  prompt             text,
  payload            jsonb NOT NULL DEFAULT '{}'::jsonb,
  result             jsonb,
  result_text        text,
  error              text,
  privileged         boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agentruns_topic_format CHECK (topic ~ '${TOPIC_PATTERN}')
);

-- Forward-compat ALTER for databases created before result_text landed.
-- Safe no-op on fresh databases where the column already exists.
ALTER TABLE agentruns ADD COLUMN IF NOT EXISTS result_text text;
-- Inherited from the originating event (root agentrun) or parent
-- agentrun (children spawned via queue_run). See the matching ALTER on
-- the events table for the trust-model rationale.
ALTER TABLE agentruns ADD COLUMN IF NOT EXISTS privileged boolean NOT NULL DEFAULT false;

-- Forward-compat: relax the topic CHECK constraint to allow arbitrarily
-- deep \`a:b:c:…\` topics. CREATE TABLE IF NOT EXISTS above doesn't
-- update existing constraints, so we drop+re-add unconditionally. The
-- DROP IF EXISTS / ADD pair is idempotent.
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_topic_format;
ALTER TABLE events ADD CONSTRAINT events_topic_format CHECK (topic ~ '${TOPIC_PATTERN}');
ALTER TABLE agentruns DROP CONSTRAINT IF EXISTS agentruns_topic_format;
ALTER TABLE agentruns ADD CONSTRAINT agentruns_topic_format CHECK (topic ~ '${TOPIC_PATTERN}');

CREATE INDEX IF NOT EXISTS agentruns_state_priority_idx
  ON agentruns (state, priority DESC, id ASC);
CREATE INDEX IF NOT EXISTS agentruns_event_id_idx ON agentruns (event_id);
CREATE INDEX IF NOT EXISTS agentruns_parent_idx ON agentruns (parent_agentrun_id);

CREATE TABLE IF NOT EXISTS stepresults (
  id              bigserial PRIMARY KEY,
  agent_run_id    bigint NOT NULL REFERENCES agentruns(id) ON DELETE CASCADE,
  event_id        bigint NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  step_number     int    NOT NULL,
  finish_reason   text   NOT NULL,
  result_text     text,
  reasoning_text  text,
  input_tokens    int,
  output_tokens   int,
  total_tokens    int,
  tool_call_count int    NOT NULL DEFAULT 0,
  tool_calls      jsonb  NOT NULL DEFAULT '[]'::jsonb,
  tool_results    jsonb  NOT NULL DEFAULT '[]'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stepresults_step_number_unique UNIQUE (agent_run_id, step_number)
);

CREATE INDEX IF NOT EXISTS stepresults_agent_run_id_idx ON stepresults (agent_run_id);
CREATE INDEX IF NOT EXISTS stepresults_event_id_idx     ON stepresults (event_id);

-- ───────── chatmessages ─────────
--
-- Persistent chat history across all channels. Each row links to the
-- event whose lifecycle the message belongs to:
--   * For role='user': the event the host plugin emitted with isChat=true.
--   * For role='assistant': the event whose agentrun called send_chat.
-- The channel is reachable via JOIN to events.preferred_chat_channel_id;
-- there is intentionally no channel_id column here — channel routing is
-- a host-side concern, the container never names a channel.
--
-- delivered_at is set when ANY listener returns true from its async
-- handler. New subscribers replay all undelivered matching rows on
-- registration so a message produced when nobody was listening is still
-- delivered later.
CREATE TABLE IF NOT EXISTS chatmessages (
  id           bigserial PRIMARY KEY,
  event_id     bigint NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('user','assistant')),
  text_content text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);

CREATE INDEX IF NOT EXISTS chatmessages_event_idx
  ON chatmessages (event_id);
CREATE INDEX IF NOT EXISTS chatmessages_undelivered_idx
  ON chatmessages (created_at) WHERE delivered_at IS NULL;

-- ───────── NOTIFY triggers ─────────

CREATE OR REPLACE FUNCTION events_notify_new() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('${EVENTS_NEW_CHANNEL}', NEW.id::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS events_new_trg ON events;
CREATE TRIGGER events_new_trg
  AFTER INSERT ON events
  FOR EACH ROW EXECUTE FUNCTION events_notify_new();

CREATE OR REPLACE FUNCTION events_notify_state() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('${EVENTS_STATE_CHANNEL}', NEW.id::text || ':' || NEW.state);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS events_state_trg ON events;
CREATE TRIGGER events_state_trg
  AFTER UPDATE OF state ON events
  FOR EACH ROW EXECUTE FUNCTION events_notify_state();

CREATE OR REPLACE FUNCTION agentruns_notify_changed() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('${AGENTRUNS_CHANNEL}', NEW.state);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agentruns_notify_changed_trg ON agentruns;
CREATE TRIGGER agentruns_notify_changed_trg
  AFTER INSERT OR UPDATE OF state ON agentruns
  FOR EACH ROW EXECUTE FUNCTION agentruns_notify_changed();

CREATE OR REPLACE FUNCTION stepresults_notify_new() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify(
    '${STEPRESULTS_NEW_CHANNEL}',
    NEW.event_id::text || ':' || NEW.agent_run_id::text || ':' || NEW.id::text
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS stepresults_new_trg ON stepresults;
CREATE TRIGGER stepresults_new_trg
  AFTER INSERT ON stepresults
  FOR EACH ROW EXECUTE FUNCTION stepresults_notify_new();

-- chatmessages NOTIFY: payload is "<channel_id>:<role>:<id>". Channel
-- comes from the parent event's preferred_chat_channel_id, JOINed at
-- trigger time. Empty channel becomes empty prefix — listeners will
-- filter it out unless they explicitly subscribe to channelId="".
CREATE OR REPLACE FUNCTION chatmessages_notify_new() RETURNS trigger AS $$
DECLARE
  channel text;
BEGIN
  SELECT preferred_chat_channel_id INTO channel FROM events WHERE id = NEW.event_id;
  PERFORM pg_notify(
    '${CHATMESSAGES_NEW_CHANNEL}',
    COALESCE(channel, '') || ':' || NEW.role || ':' || NEW.id::text
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS chatmessages_new_trg ON chatmessages;
CREATE TRIGGER chatmessages_new_trg
  AFTER INSERT ON chatmessages
  FOR EACH ROW EXECUTE FUNCTION chatmessages_notify_new();
`;

/**
 * SQL fragment that recomputes the parent event's terminal state after
 * one of its agentruns settles. Run inside the same transaction as the
 * agentrun's terminal UPDATE.
 *
 * Parameters (in order):
 *   $1 = event_id (bigint, as string)
 *   $2 = id of the just-settled agentrun (bigint, as string) — excluded
 *        from the "is anything still running?" check because its UPDATE
 *        is in the same transaction and may not be visible yet.
 *   $3 = state of the just-settled agentrun ('done' | 'failed')
 *
 * Result: events row flips from `running` to `done` or `failed` once no
 * agentruns for that event remain `pending` or `running`. `failed` wins
 * if any agentrun for the event has failed (including the just-settled
 * one).
 */
export const EVENT_TERMINAL_UPDATE_SQL = `
UPDATE events
SET state = CASE
  WHEN EXISTS (
    SELECT 1 FROM agentruns
    WHERE event_id = $1
      AND state IN ('pending','running')
      AND id <> $2
  ) THEN state
  WHEN $3 = 'failed' OR EXISTS (
    SELECT 1 FROM agentruns
    WHERE event_id = $1 AND state = 'failed'
  ) THEN 'failed'
  ELSE 'done'
END,
    updated_at = now()
WHERE id = $1 AND state = 'running'
`;
