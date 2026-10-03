-- Teachers and student witnesses who have signed in with Entra ID. Voters
-- never appear here: they have no account, only an anonymous key.
--
-- A person is the pair (tid, oid), the directory and the object id within
-- it, which Entra never reuses. Not the e-mail address: it can be renamed or
-- handed to someone else. The email is the token's email claim, or its
-- preferred_username without one (the school address of a school account),
-- and null without either. It is kept only to match an invitation sent to
-- a school address to the person who signs in with it.
--
-- Random (version 4) ids: a time-ordered id would record when each person
-- first signed in.

CREATE TABLE app_user (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tid uuid NOT NULL,
  oid uuid NOT NULL,
  display_name text NOT NULL,
  email text,
  CONSTRAINT app_user_identity UNIQUE (tid, oid)
);

-- Sign-in inserts a person or refreshes their name and email. The identity
-- itself cannot be rewritten, and nobody is deleted by the server.
GRANT SELECT, INSERT ON app_user TO school_election_app;
GRANT UPDATE (display_name, email) ON app_user TO school_election_app;
