-- Baseline privileges. Nobody but the owner may create objects in the
-- public schema, connect to this database or create temporary tables. The
-- runtime role may connect and use the schema; later migrations grant it
-- each table privilege it needs, one by one.

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO school_election_app;

DO $$
BEGIN
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO school_election_app', current_database());
END
$$;
