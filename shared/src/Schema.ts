/**
 * SQL that defines the bus-state schema. Idempotent: every statement is
 * `IF NOT EXISTS` / `CREATE OR REPLACE` / `DROP IF EXISTS`, so it's safe
 * to run on every daemon start without a migrations framework.
 *
 * The trigger fires `pg_notify(EVENTS_NOTIFY_CHANNEL, NEW.state)` on
 * INSERT and on every state change, so consumers can sleep on
 * `LISTEN events_changed` instead of polling. The payload is the new
 * state — listeners use it to wake only the watchers that care.
 */
export const EVENTS_NOTIFY_CHANNEL = "events_changed";

export const EVENTS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS events (
  id                bigserial PRIMARY KEY,
  topic             text NOT NULL,
  priority          smallint NOT NULL DEFAULT 50,
  state             text NOT NULL DEFAULT 'pending',
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
  supervisor_prompt text,
  idempotency_key   text UNIQUE,
  causation_chain   bigint[] NOT NULL DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- For pre-existing tables that were created before supervisor_prompt
-- was a column.
ALTER TABLE events ADD COLUMN IF NOT EXISTS supervisor_prompt text;

-- Generic (state, priority DESC, id ASC) index serves every worker that
-- claims by state. Drop the old pending-only partial index if present.
DROP INDEX IF EXISTS events_pending_priority_idx;
CREATE INDEX IF NOT EXISTS events_state_priority_idx
  ON events (state, priority DESC, id ASC);

CREATE INDEX IF NOT EXISTS events_topic_idx ON events (topic);

CREATE OR REPLACE FUNCTION events_notify_changed() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('${EVENTS_NOTIFY_CHANNEL}', NEW.state);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop the previous-generation trigger + function (renamed during the
-- claim/state-machine refactor).
DROP TRIGGER IF EXISTS events_notify_new_trg ON events;
DROP FUNCTION IF EXISTS events_notify_new();

DROP TRIGGER IF EXISTS events_notify_changed_trg ON events;
CREATE TRIGGER events_notify_changed_trg
  AFTER INSERT OR UPDATE OF state ON events
  FOR EACH ROW EXECUTE FUNCTION events_notify_changed();
`;
