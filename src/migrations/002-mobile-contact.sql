ALTER TABLE a2a_relay.agents DROP CONSTRAINT agents_contact_id_check;
ALTER TABLE a2a_relay.agents ADD CONSTRAINT agents_contact_id_check CHECK (contact_id ~ '^1[3-9][0-9]{9}$');
INSERT INTO a2a_relay.schema_migrations VALUES (2);
