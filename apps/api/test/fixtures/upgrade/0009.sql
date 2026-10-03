-- The Klassensprecherwahl 3B votes and closes, made the way the API makes
-- it, so every later migration meets a sealed round: the election active,
-- its regular round open, both keys of the issued 0008 batch using their
-- entitlement up and staging a ballot, and the round sealed.
--
-- The seal is called in replica mode, with the triggers off: the owner's
-- direct statements are bound by them (0008), and so is a function the
-- owner calls itself, while the application calls the seal as the runtime
-- role, which the triggers exempt. The votes before it run through the
-- triggers as the application's would.

CREATE TEMP TABLE fixture AS SELECT
  '5d7e9f10-2a3b-4c5d-8e6f-7a8b9c0d1e2f'::uuid AS klassensprecherwahl,
  'a4d5e6f7-0819-4a2b-8c3d-4e5f6a7b8c9d'::uuid AS klassensprecher;

UPDATE election SET state = 'active' FROM fixture f WHERE election.id = f.klassensprecherwahl;
UPDATE round SET state = 'open' FROM fixture f WHERE round.election_id = f.klassensprecherwahl AND round.kind = 'regular';

-- Both keys vote: one puts Lena Huber first and Paul Wagner second, the
-- other the other way round.
UPDATE credential_entitlement e SET consumed = true
  FROM credential c JOIN credential_batch b ON b.id = c.batch_id AND b.state = 'issued'
 WHERE e.credential_id = c.id AND c.key IN ('CMWSBGY34M98W2PPYQYS', '5189GEVBT1ATEQHP58P8');

INSERT INTO ballot_box (election_id, round_contest_id, kind, ranking)
SELECT rc.election_id, rc.id, 'ranking', v.ranking
  FROM fixture f
  JOIN round_contest rc ON rc.election_id = f.klassensprecherwahl AND rc.contest_id = f.klassensprecher
  JOIN candidate huber ON huber.contest_id = f.klassensprecher AND huber.surname = 'Huber'
  JOIN candidate wagner ON wagner.contest_id = f.klassensprecher AND wagner.surname = 'Wagner' AND wagner.given_name = 'Paul'
  CROSS JOIN LATERAL (VALUES (ARRAY[huber.id, wagner.id]), (ARRAY[wagner.id, huber.id])) AS v (ranking);

BEGIN;
SET LOCAL session_replication_role = replica;
SELECT seal_round(r.id) FROM round r JOIN fixture f ON r.election_id = f.klassensprecherwahl WHERE r.kind = 'regular';
COMMIT;
