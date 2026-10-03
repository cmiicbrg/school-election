-- Teachers and student witnesses who have signed in with Entra ID. Voters
-- never appear here: they have no account, only an anonymous key.
--
-- A person is the pair (tid, oid), the directory and the object id within
-- it, which Entra never reuses. Not the e-mail address or UPN: those can be
-- renamed or handed to someone else. The upn is kept only to match an
-- invitation sent to a school address to the person who signs in with it,
-- and is null when the ID token does not carry the optional upn claim.
--
-- Random (version 4) ids: a time-ordered id would record when each person
-- first signed in.

CREATE TABLE app_user (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tid uuid NOT NULL,
  oid uuid NOT NULL,
  display_name text NOT NULL,
  upn text,
  CONSTRAINT app_user_identity UNIQUE (tid, oid)
);

-- Sign-in inserts a person or refreshes their name and upn. The identity
-- itself cannot be rewritten, and nobody is deleted by the server.
GRANT SELECT, INSERT ON app_user TO school_election_app;
GRANT UPDATE (display_name, upn) ON app_user TO school_election_app;
