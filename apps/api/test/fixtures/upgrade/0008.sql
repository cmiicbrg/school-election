-- Keys for the prepared Klassensprecherwahl 3B, made the way the API makes
-- them, so every later migration meets populated credential tables: a
-- regular batch of two keys entitled to the class's ballot box, a runoff
-- batch of one key without entitlements, and a replaced regular batch.
-- The batches, each id named once, in a table of this session:

CREATE TEMP TABLE fixture (id uuid, round_kind text, keys text[], replaced boolean);
INSERT INTO fixture VALUES
  ('59250cc6-5a3d-4db1-b1d6-dfd9046ea604', 'regular', '{CMWSBGY34M98W2PPYQYS,5189GEVBT1ATEQHP58P8}', false),
  ('838e5148-2d60-4d40-a761-cd299bcb036d', 'runoff', '{E4ZTX1WDG97J3M9BCY06}', false),
  ('3b59fece-a520-4582-a440-21b94724f31e', 'regular', '{S4TGSVC3Z92J800H07HT}', true);

-- All for class 3B.
INSERT INTO credential_batch (id, election_id, voter_group_id, round_kind)
SELECT f.id, g.election_id, g.id, f.round_kind
  FROM fixture f, voter_group g
 WHERE g.id = 'b5e6f708-192a-4b3c-9d4e-5f6a7b8c9d0e';

INSERT INTO credential (election_id, batch_id, key)
SELECT b.election_id, b.id, k.key
  FROM fixture f JOIN credential_batch b ON b.id = f.id, unnest(f.keys) AS k (key);

-- Each key is entitled to the ballot boxes of its batch's round, which for
-- the runoff does not exist yet.
INSERT INTO credential_entitlement (election_id, credential_id, round_contest_id)
SELECT c.election_id, c.id, rc.id
  FROM fixture f
  JOIN credential c ON c.batch_id = f.id
  JOIN round r ON r.election_id = c.election_id AND r.kind = f.round_kind
  JOIN round_contest rc ON rc.round_id = r.id;

UPDATE credential_batch b SET state = 'void' FROM fixture f WHERE b.id = f.id AND f.replaced;
