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
 * Three tables, four NOTIFY channels:
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
 */

export const EVENTS_NEW_CHANNEL = "events_new";
export const EVENTS_STATE_CHANNEL = "events_state";
export const AGENTRUNS_CHANNEL = "agentruns_changed";
export const STEPRESULTS_NEW_CHANNEL = "stepresults_new";

/**
 * Topic regex used by the events check constraint and by the container
 * runtime when resolving handler files. One word, optionally followed by
 * `:` and a sub-topic word.
 */
export const TOPIC_PATTERN = "^\\w+(:\\w+)?$";

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
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT events_topic_format CHECK (topic ~ '${TOPIC_PATTERN}')
);

-- Drop legacy columns from earlier schema generations. Single-instance
-- project; column drops are fine.
ALTER TABLE events DROP COLUMN IF EXISTS supervisor_prompt;
ALTER TABLE events DROP COLUMN IF EXISTS causation_chain;

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
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agentruns_topic_format CHECK (topic ~ '${TOPIC_PATTERN}')
);

-- Forward-compat ALTER for databases created before result_text landed.
-- Safe no-op on fresh databases where the column already exists.
ALTER TABLE agentruns ADD COLUMN IF NOT EXISTS result_text text;

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
