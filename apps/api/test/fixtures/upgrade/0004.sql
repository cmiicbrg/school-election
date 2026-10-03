-- The election the 0003 audit chain belongs to, as the changes it records
-- left it: created by Maria Huber, who owns it, with a pending invitation
-- for the witness the chain names. So the next migration, which ties every
-- event to its election, meets a populated log and finds its election.
-- Plus a prepared election of the 0002 teacher with the 0002 witness
-- bound, whose address is kept as it was entered.

INSERT INTO app_user (tid, oid, display_name, email) VALUES
  ('6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b', '2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d', 'Maria Huber', 'maria.huber@school.example');

INSERT INTO election (id, title, state) VALUES
  ('0b9e4a52-3c1d-4f7e-9a6b-2d8c5e1f7a30', 'Schulsprecherwahl 2026/27', 'draft'),
  ('5d7e9f10-2a3b-4c5d-8e6f-7a8b9c0d1e2f', 'Klassensprecherwahl 3B', 'prepared');

-- Maria Huber's election: her, and the invitation the chain records.
INSERT INTO election_member (election_id, role, user_id, invited_email)
SELECT '0b9e4a52-3c1d-4f7e-9a6b-2d8c5e1f7a30'::uuid, member.role, app_user.id, member.invited_email
  FROM (VALUES
    ('owner', '2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d', NULL),
    ('witness', NULL, 'witness@school.example')
  ) AS member (role, oid, invited_email)
  LEFT JOIN app_user ON app_user.oid = member.oid::uuid;

-- The 0002 teacher's election, with the 0002 witness bound.
INSERT INTO election_member (election_id, role, user_id, invited_email)
SELECT '5d7e9f10-2a3b-4c5d-8e6f-7a8b9c0d1e2f'::uuid, member.role, app_user.id, member.invited_email
  FROM (VALUES
    ('owner', '1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b', NULL),
    ('witness', '2c3d4e5f-6071-4829-9bac-1d2e3f4a5b6c', 'Witness@Schule.example.org')
  ) AS member (role, oid, invited_email)
  LEFT JOIN app_user ON app_user.oid = member.oid::uuid;
