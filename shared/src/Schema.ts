/**
 * SQL that defines the bus-state schema. Idempotent: every statement is
 * `IF NOT EXISTS` / `CREATE OR REPLACE`, so it's safe to run on every
 * daemon start without a migrations framework.
 *
 * The trigger turns every INSERT into a postgres NOTIFY on the
 * {@link EVENTS_NOTIFY_CHANNEL} channel so consumers can sleep on
 * `LISTEN events_new` instead of polling.
 */
export const EVENTS_NOTIFY_CHANNEL = "events_new";

export const EVENTS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS events (
  id              bigserial PRIMARY KEY,
  topic           text NOT NULL,
  priority        smallint NOT NULL DEFAULT 50,
  state           text NOT NULL DEFAULT 'pending',
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text UNIQUE,
  causation_chain bigint[] NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS events_pending_priority_idx
  ON events (priority DESC, id ASC)
  WHERE state = 'pending';

CREATE INDEX IF NOT EXISTS events_topic_idx ON events (topic);

CREATE OR REPLACE FUNCTION events_notify_new() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('${EVENTS_NOTIFY_CHANNEL}', NEW.id::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS events_notify_new_trg ON events;
CREATE TRIGGER events_notify_new_trg
  AFTER INSERT ON events
  FOR EACH ROW EXECUTE FUNCTION events_notify_new();
`;
