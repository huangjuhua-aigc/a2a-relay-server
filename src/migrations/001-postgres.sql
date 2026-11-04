CREATE SCHEMA IF NOT EXISTS a2a_relay;
CREATE TABLE IF NOT EXISTS a2a_relay.schema_migrations (version INTEGER PRIMARY KEY);
CREATE TABLE IF NOT EXISTS a2a_relay.agents (
  registration_id TEXT PRIMARY KEY,
  publication_id TEXT UNIQUE NOT NULL,
  device_id TEXT UNIQUE NOT NULL,
  token_hash TEXT UNIQUE NOT NULL CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  display_name TEXT NOT NULL,
  enabled SMALLINT NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision BETWEEN 0 AND 9007199254740991),
  operation_id TEXT,
  blocked SMALLINT NOT NULL DEFAULT 0 CHECK (blocked IN (0,1)),
  generation BIGINT NOT NULL DEFAULT 0 CHECK (generation BETWEEN 0 AND 9007199254740991),
  expires_at BIGINT,
  created_at BIGINT NOT NULL,
  contact_id TEXT UNIQUE NOT NULL CHECK (contact_id ~ '^13[89][0-9]{8}$')
);
CREATE TABLE IF NOT EXISTS a2a_relay.contact_number_sequence (
  id INTEGER PRIMARY KEY CHECK (id=1),
  next BIGINT NOT NULL CHECK (next BETWEEN 13800000000 AND 14000000000)
);
INSERT INTO a2a_relay.contact_number_sequence VALUES (1,13800000000) ON CONFLICT (id) DO NOTHING;
CREATE OR REPLACE FUNCTION a2a_relay.protect_contact_id() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.contact_id IS DISTINCT FROM OLD.contact_id THEN
    RAISE EXCEPTION 'contactId immutable';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS agents_contact_immutable ON a2a_relay.agents;
CREATE TRIGGER agents_contact_immutable BEFORE UPDATE OF contact_id ON a2a_relay.agents
  FOR EACH ROW EXECUTE FUNCTION a2a_relay.protect_contact_id();
INSERT INTO a2a_relay.schema_migrations VALUES (1) ON CONFLICT DO NOTHING;
