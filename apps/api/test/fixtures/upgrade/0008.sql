-- Keys for the prepared Klassensprecherwahl 3B, made the way the API makes
-- them, so every later migration meets populated credential tables: a
-- regular batch of two keys entitled to the class's ballot box, a runoff
-- batch of one key without entitlements, and a replaced regular batch.

INSERT INTO credential_batch (id, election_id, voter_group_id, round_kind) VALUES
  ('59250cc6-5a3d-4db1-b1d6-dfd9046ea604', '5d7e9f10-2a3b-4c5d-8e6f-7a8b9c0d1e2f', 'b5e6f708-192a-4b3c-9d4e-5f6a7b8c9d0e', 'regular'),
  ('838e5148-2d60-4d40-a761-cd299bcb036d', '5d7e9f10-2a3b-4c5d-8e6f-7a8b9c0d1e2f', 'b5e6f708-192a-4b3c-9d4e-5f6a7b8c9d0e', 'runoff'),
  ('3b59fece-a520-4582-a440-21b94724f31e', '5d7e9f10-2a3b-4c5d-8e6f-7a8b9c0d1e2f', 'b5e6f708-192a-4b3c-9d4e-5f6a7b8c9d0e', 'regular');

INSERT INTO credential (election_id, batch_id, key) VALUES
  ('5d7e9f10-2a3b-4c5d-8e6f-7a8b9c0d1e2f', '59250cc6-5a3d-4db1-b1d6-dfd9046ea604', 'CMWSBGY34M98W2PPYQYS'),
  ('5d7e9f10-2a3b-4c5d-8e6f-7a8b9c0d1e2f', '59250cc6-5a3d-4db1-b1d6-dfd9046ea604', '5189GEVBT1ATEQHP58P8'),
  ('5d7e9f10-2a3b-4c5d-8e6f-7a8b9c0d1e2f', '838e5148-2d60-4d40-a761-cd299bcb036d', 'E4ZTX1WDG97J3M9BCY06'),
  ('5d7e9f10-2a3b-4c5d-8e6f-7a8b9c0d1e2f', '3b59fece-a520-4582-a440-21b94724f31e', 'S4TGSVC3Z92J800H07HT');

INSERT INTO credential_entitlement (election_id, credential_id, round_contest_id)
SELECT c.election_id, c.id, rc.id
  FROM credential c
  JOIN round r ON r.election_id = c.election_id AND r.kind = 'regular'
  JOIN round_contest rc ON rc.round_id = r.id
 WHERE c.batch_id IN ('59250cc6-5a3d-4db1-b1d6-dfd9046ea604', '3b59fece-a520-4582-a440-21b94724f31e');

UPDATE credential_batch SET state = 'void' WHERE id = '3b59fece-a520-4582-a440-21b94724f31e';
