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
 * Three NOTIFY channels:
 *
 * - `events_new` — fires on INSERT into `events`. Wakes the container's
 *   input-event watcher.
 * - `events_state` — fires on state UPDATE on `events`. Lets host-side
 *   plugins wait for a specific event to settle.
 * - `agentruns_changed` — fires on INSERT and on state UPDATE on
 *   `agentruns`. Wakes the agentrun watcher.
 */

export const EVENTS_NEW_CHANNEL = "events_new";
export const EVENTS_STATE_CHANNEL = "events_state";
export const AGENTRUNS_CHANNEL = "agentruns_changed";

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
  error              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agentruns_topic_format CHECK (topic ~ '${TOPIC_PATTERN}')
);

CREATE INDEX IF NOT EXISTS agentruns_state_priority_idx
  ON agentruns (state, priority DESC, id ASC);
CREATE INDEX IF NOT EXISTS agentruns_event_id_idx ON agentruns (event_id);
CREATE INDEX IF NOT EXISTS agentruns_parent_idx ON agentruns (parent_agentrun_id);

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
