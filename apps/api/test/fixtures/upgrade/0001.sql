-- What every migration after the baseline meets: populated tables, made
-- the way the API makes them. Loaded as the owner on the baseline by
-- test/db/upgrade.test.ts, which then applies every later migration on
-- top and checks that the audit chain still verifies.
--
-- Two elections: Maria Huber's draft Schulsprecherwahl, whose audit chain
-- is the known-answer chain of test/db/audit-chain.test.ts (so its hashes
-- must still verify after every migration), and the Klassensprecherwahl
-- 3B of the fixture teacher, which ran to the end: prepared, voted, sealed
-- and counted, a lot recorded, and finalized as it stood. The ids, each
-- named once, in a table of this session:

CREATE TEMP TABLE fixture AS SELECT
  '0b9e4a52-3c1d-4f7e-9a6b-2d8c5e1f7a30'::uuid AS schulsprecherwahl,
  '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'::uuid AS schulsprecher,
  '8b2c3d4e-5f60-4b7c-9d8e-0f1a2b3c4d5e'::uuid AS class_1a,
  '9c3d4e5f-6071-4c8d-8e9f-1a2b3c4d5e6f'::uuid AS class_2b,
  '5d7e9f10-2a3b-4c5d-8e6f-7a8b9c0d1e2f'::uuid AS klassensprecherwahl,
  'a4d5e6f7-0819-4a2b-8c3d-4e5f6a7b8c9d'::uuid AS klassensprecher,
  'b5e6f708-192a-4b3c-9d4e-5f6a7b8c9d0e'::uuid AS class_3b,
  'c6f7a819-2a3b-4c4d-9e5f-6a7b8c9d0e1f'::uuid AS round_3b,
  'd7a8b920-3b4c-4d5e-8f6a-7b8c9d0e1f2a'::uuid AS box_3b,
  'e8b9c031-4c5d-4e6f-9a7b-8c9d0e1f2a3b'::uuid AS huber,
  'f9c0d142-5d6e-4f70-8b8c-9d0e1f2a3b4c'::uuid AS anna,
  '0ad1e253-6e7f-4081-9c9d-0e1f2a3b4c5d'::uuid AS paul;

-- Three signed-in people: Maria Huber, a teacher whose token carried an
-- address, and a witness whose did not.
INSERT INTO app_user (tid, oid, display_name, email) VALUES
  ('6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b', '2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d', 'Maria Huber', 'maria.huber@school.example'),
  ('8f6c1a2e-0b7d-4c3e-9a51-2d4e6f708192', '1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b', 'Fixture Teacher', 'teacher@schule.example.org'),
  ('8f6c1a2e-0b7d-4c3e-9a51-2d4e6f708192', '2c3d4e5f-6071-4829-9bac-1d2e3f4a5b6c', 'Fixture Witness', NULL);

-- Maria Huber's draft: created by her, who owns it, with a pending
-- invitation for a witness.
INSERT INTO election (id, title, state)
SELECT schulsprecherwahl, 'Schulsprecherwahl 2026/27', 'draft' FROM fixture;

INSERT INTO election_member (election_id, role, user_id, invited_email)
SELECT f.schulsprecherwahl, member.role, app_user.id, member.invited_email
  FROM fixture f, (VALUES
    ('owner', '2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d', NULL),
    ('witness', NULL, 'witness@school.example')
  ) AS member (role, oid, invited_email)
  LEFT JOIN app_user ON app_user.oid = member.oid::uuid;

-- The two changes above, as the chain records them: a genuine two-event
-- chain, the known-answer records of test/db/audit-chain.test.ts. The
-- second event names the first by the seq the database gave it.
WITH first AS (
  INSERT INTO audit_event (election_id, at, actor_tid, actor_oid, actor_name, action, metadata, prev_seq, prev_hash, hash) VALUES
    ('0b9e4a52-3c1d-4f7e-9a6b-2d8c5e1f7a30', '2026-10-05T07:45:12.345Z',
     '6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b', '2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d', 'Maria Huber',
     'election.created', '{"title": "Schulsprecherwahl 2026/27"}',
     NULL, NULL, 'b6022b1fc84736cd665f1d8fec5926ca1d82bfcb1c9e51896c5350a3d34fe2cc')
  RETURNING seq, hash
)
INSERT INTO audit_event (election_id, at, actor_tid, actor_oid, actor_name, action, metadata, prev_seq, prev_hash, hash)
SELECT '0b9e4a52-3c1d-4f7e-9a6b-2d8c5e1f7a30', '2026-10-05T07:46:03.001Z',
       '6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b', '2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d', 'Maria Huber',
       'member.invited', '{"email": "witness@school.example", "role": "witness"}',
       first.seq, first.hash, '7827d380b44d772cbfee0ecf7bb7189ab5d24c5255a70752db1489e0aa166ed6'
  FROM first;

-- Its configuration: a Schulsprecherwahl with two candidates, one with a
-- picture (an 8 × 8 WebP), and two classes that vote in it.
INSERT INTO contest (id, election_id, title, ruleset_id)
SELECT schulsprecher, schulsprecherwahl, 'Schulsprecher/in', 'at-school-speaker-v1' FROM fixture;

INSERT INTO candidate (election_id, contest_id, surname, given_name, picture, picture_sha256)
SELECT f.schulsprecherwahl, f.schulsprecher, c.surname, c.given_name, c.picture, c.picture_sha256
  FROM fixture f, (VALUES
    ('Özdemir', 'Elif',
     '\x524946463800000057454250565038202c000000d001009d012a0800080001402225a00274ba01f80003b000fef1dc8ffcf4cd7983fc9cffe4172c2eb6940000'::bytea,
     '2f84977c6731a3c9967ba9664b3e50091520a8c0403d57ee0673d496bb164295'),
    ('Berger', 'Jonas', NULL, NULL)
  ) AS c (surname, given_name, picture, picture_sha256);

INSERT INTO voter_group (id, election_id, name)
SELECT g.id, f.schulsprecherwahl, g.name
  FROM fixture f, LATERAL (VALUES (f.class_1a, '1A'), (f.class_2b, '2B')) AS g (id, name);

INSERT INTO voter_group_contest (election_id, voter_group_id, contest_id)
SELECT g.election_id, g.id, f.schulsprecher
  FROM fixture f JOIN voter_group g ON g.election_id = f.schulsprecherwahl;

-- The Klassensprecherwahl 3B of the fixture teacher, with the witness
-- bound, whose address is kept as it was entered: prepared, with its
-- contest, three candidates, its class, its regular round and the ballot
-- box.
INSERT INTO election (id, title, state)
SELECT klassensprecherwahl, 'Klassensprecherwahl 3B', 'prepared' FROM fixture;

INSERT INTO election_member (election_id, role, user_id, invited_email)
SELECT f.klassensprecherwahl, member.role, app_user.id, member.invited_email
  FROM fixture f, (VALUES
    ('owner', '1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b', NULL),
    ('witness', '2c3d4e5f-6071-4829-9bac-1d2e3f4a5b6c', 'Witness@Schule.example.org')
  ) AS member (role, oid, invited_email)
  LEFT JOIN app_user ON app_user.oid = member.oid::uuid;

INSERT INTO contest (id, election_id, title, ruleset_id)
SELECT klassensprecher, klassensprecherwahl, 'Klassensprecher/in 3B', 'at-representative-v1' FROM fixture;

INSERT INTO candidate (id, election_id, contest_id, surname, given_name)
SELECT c.id, f.klassensprecherwahl, f.klassensprecher, c.surname, c.given_name
  FROM fixture f, LATERAL (VALUES (f.huber, 'Huber', 'Lena'), (f.paul, 'Wagner', 'Paul'), (f.anna, 'Wagner', 'Anna')) AS c (id, surname, given_name);

INSERT INTO voter_group (id, election_id, name)
SELECT class_3b, klassensprecherwahl, '3B' FROM fixture;

INSERT INTO voter_group_contest (election_id, voter_group_id, contest_id)
SELECT klassensprecherwahl, class_3b, klassensprecher FROM fixture;

INSERT INTO round (id, election_id, kind)
SELECT round_3b, klassensprecherwahl, 'regular' FROM fixture;

INSERT INTO round_contest (id, election_id, round_id, contest_id)
SELECT box_3b, klassensprecherwahl, round_3b, klassensprecher FROM fixture;

-- Its keys: a regular batch of two keys entitled to the class's ballot
-- box, a runoff batch of one key without entitlements, and a replaced
-- regular batch, void.
CREATE TEMP TABLE batches (id uuid, round_kind text, keys text[], replaced boolean);
INSERT INTO batches VALUES
  ('59250cc6-5a3d-4db1-b1d6-dfd9046ea604', 'regular', '{CMWSBGY34M98W2PPYQYS,5189GEVBT1ATEQHP58P8}', false),
  ('838e5148-2d60-4d40-a761-cd299bcb036d', 'runoff', '{E4ZTX1WDG97J3M9BCY06}', false),
  ('3b59fece-a520-4582-a440-21b94724f31e', 'regular', '{S4TGSVC3Z92J800H07HT}', true);

INSERT INTO credential_batch (id, election_id, voter_group_id, round_kind)
SELECT b.id, f.klassensprecherwahl, f.class_3b, b.round_kind FROM fixture f, batches b;

INSERT INTO credential (election_id, batch_id, key)
SELECT f.klassensprecherwahl, b.id, k.key FROM fixture f, batches b, unnest(b.keys) AS k (key);

-- Each regular key is entitled to the ballot box; the runoff round does
-- not exist, so its key gets nothing.
INSERT INTO credential_entitlement (election_id, credential_id, round_contest_id)
SELECT c.election_id, c.id, f.box_3b
  FROM fixture f JOIN batches b ON b.round_kind = 'regular' JOIN credential c ON c.batch_id = b.id;

UPDATE credential_batch cb SET state = 'void' FROM batches b WHERE cb.id = b.id AND b.replaced;

-- The election active and the round open; both keys of the issued batch
-- use their entitlement up and stage a ballot, one putting Lena Huber
-- first and Paul Wagner second, the other the other way round, through
-- the triggers as the application's votes do.
UPDATE election SET state = 'active' FROM fixture f WHERE election.id = f.klassensprecherwahl;
UPDATE round SET state = 'open' FROM fixture f WHERE round.id = f.round_3b;

UPDATE credential_entitlement e SET consumed = true
  FROM credential c JOIN credential_batch b ON b.id = c.batch_id AND b.state = 'issued'
 WHERE e.credential_id = c.id AND c.key IN ('CMWSBGY34M98W2PPYQYS', '5189GEVBT1ATEQHP58P8');

INSERT INTO ballot_box (election_id, round_contest_id, kind, ranking)
SELECT f.klassensprecherwahl, f.box_3b, 'ranking', v.ranking
  FROM fixture f CROSS JOIN LATERAL (VALUES (ARRAY[f.huber, f.paul]), (ARRAY[f.paul, f.huber])) AS v (ranking);

-- The seal, in replica mode with the triggers off: the owner's direct
-- statements are bound by them, and so is a function the owner calls
-- itself, while the application calls the seal as the runtime role, which
-- the triggers exempt.
BEGIN;
SET LOCAL session_replication_role = replica;
SELECT seal_round(f.round_3b) FROM fixture f;
COMMIT;

-- The result, as the API stores it when the round closes (lib/tally.ts):
-- one snapshot for the one box, with the two ballots; the result and the
-- outcome are what the count gives for them, the digest is taken over the
-- count's own canonical input.
INSERT INTO result_snapshot (election_id, round_contest_id, input_sha256, tally_version, app_version, git_sha, result, outcome)
SELECT f.klassensprecherwahl, f.box_3b,
       encode(sha256(convert_to($input${"ballots":[{"kind":"ranking","ranking":["e8b9c031-4c5d-4e6f-9a7b-8c9d0e1f2a3b","0ad1e253-6e7f-4081-9c9d-0e1f2a3b4c5d"]},{"kind":"ranking","ranking":["0ad1e253-6e7f-4081-9c9d-0e1f2a3b4c5d","e8b9c031-4c5d-4e6f-9a7b-8c9d0e1f2a3b"]}],"contest":{"candidateIds":["e8b9c031-4c5d-4e6f-9a7b-8c9d0e1f2a3b","f9c0d142-5d6e-4f70-8b8c-9d0e1f2a3b4c","0ad1e253-6e7f-4081-9c9d-0e1f2a3b4c5d"],"id":"a4d5e6f7-0819-4a2b-8c3d-4e5f6a7b8c9d","rulesetId":"at-representative-v1"},"tallyVersion":2}$input$, 'UTF8')), 'hex'),
       2, 'dev', 'unknown',
       $result${"contestId":"a4d5e6f7-0819-4a2b-8c3d-4e5f6a7b8c9d","rulesetId":"at-representative-v1","statistics":{"validBallots":2,"noBallots":0,"invalidBallots":0,"candidates":[{"candidateId":"e8b9c031-4c5d-4e6f-9a7b-8c9d0e1f2a3b","firstPlaces":1,"rankCounts":[1,1],"points":3},{"candidateId":"f9c0d142-5d6e-4f70-8b8c-9d0e1f2a3b4c","firstPlaces":0,"rankCounts":[0,0],"points":0},{"candidateId":"0ad1e253-6e7f-4081-9c9d-0e1f2a3b4c5d","firstPlaces":1,"rankCounts":[1,1],"points":3}]},"kind":"runoff-required","runoffCandidates":["e8b9c031-4c5d-4e6f-9a7b-8c9d0e1f2a3b","0ad1e253-6e7f-4081-9c9d-0e1f2a3b4c5d"],"trace":[{"step":"count","contestId":"a4d5e6f7-0819-4a2b-8c3d-4e5f6a7b8c9d","ballotsCast":2,"validBallots":2,"noBallots":0,"invalidBallots":0},{"step":"majority","required":2,"elected":null},{"step":"compare","basis":"first-places","seats":2,"values":[{"candidateId":"e8b9c031-4c5d-4e6f-9a7b-8c9d0e1f2a3b","value":1},{"candidateId":"0ad1e253-6e7f-4081-9c9d-0e1f2a3b4c5d","value":1},{"candidateId":"f9c0d142-5d6e-4f70-8b8c-9d0e1f2a3b4c","value":0}],"advancing":["e8b9c031-4c5d-4e6f-9a7b-8c9d0e1f2a3b","0ad1e253-6e7f-4081-9c9d-0e1f2a3b4c5d"],"tied":[]},{"step":"runoff","candidates":["e8b9c031-4c5d-4e6f-9a7b-8c9d0e1f2a3b","0ad1e253-6e7f-4081-9c9d-0e1f2a3b4c5d"]}]}$result$::jsonb,
       $outcome${"kind":"runoff-required","runoffCandidates":["e8b9c031-4c5d-4e6f-9a7b-8c9d0e1f2a3b","0ad1e253-6e7f-4081-9c9d-0e1f2a3b4c5d"],"trace":[{"step":"count","contestId":"a4d5e6f7-0819-4a2b-8c3d-4e5f6a7b8c9d","ballotsCast":2,"validBallots":2,"noBallots":0,"invalidBallots":0},{"step":"majority","required":2,"elected":null},{"step":"compare","basis":"first-places","seats":2,"values":[{"candidateId":"e8b9c031-4c5d-4e6f-9a7b-8c9d0e1f2a3b","value":1},{"candidateId":"0ad1e253-6e7f-4081-9c9d-0e1f2a3b4c5d","value":1},{"candidateId":"f9c0d142-5d6e-4f70-8b8c-9d0e1f2a3b4c","value":0}],"advancing":["e8b9c031-4c5d-4e6f-9a7b-8c9d0e1f2a3b","0ad1e253-6e7f-4081-9c9d-0e1f2a3b4c5d"],"tied":[]},{"step":"runoff","candidates":["e8b9c031-4c5d-4e6f-9a7b-8c9d0e1f2a3b","0ad1e253-6e7f-4081-9c9d-0e1f2a3b4c5d"]}]}$outcome$::jsonb
  FROM fixture f;

-- A lot recorded on the box: the officials drew between Anna and Paul
-- Wagner for the deputy's place, Paul first.
INSERT INTO lot_decision (election_id, round_contest_id, lot_id, candidates, drawn, reason, actor_tid, actor_oid, actor_name)
SELECT f.klassensprecherwahl, f.box_3b, 'positions:deputy', ARRAY[f.anna, f.paul], ARRAY[f.paul, f.anna],
       'Losentscheid der Wahlkommission am 3. Oktober', '6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b', 'a0000000-0000-4000-8000-00000000000a', 'Anna Lehrerin'
  FROM fixture f;

-- Finalized as it stands, the runoff never held: the outcome after the
-- lot (the runoff still required, the deputy decided by the lot) stored
-- as the API stores it, and the election moved to final. A botched
-- election ends as it stands, with a reason in the log, which this
-- fixture leaves to the audit chain above.
SELECT finalize_election(f.klassensprecherwahl, jsonb_build_array(jsonb_build_object('contestId', f.klassensprecher, 'outcome', s.outcome)), s.tally_version, s.app_version, s.git_sha)
  FROM fixture f JOIN result_snapshot s ON s.round_contest_id = f.box_3b;
