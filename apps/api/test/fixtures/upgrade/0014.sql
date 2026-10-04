-- The Klassensprecherwahl 3B finalized, so every later migration meets a
-- final election: the outcome as it stands after the 0013 fixture's lot
-- (the runoff still required, the deputy decided by the lot), stored as
-- the API stores it, and the election moved to final. The runoff never
-- took place: a botched election ends as it stands, with a reason in the
-- log (which this fixture leaves to the audit fixtures).

CREATE TEMP TABLE fixture AS SELECT
  '5d7e9f10-2a3b-4c5d-8e6f-7a8b9c0d1e2f'::uuid AS klassensprecherwahl,
  'a4d5e6f7-0819-4a2b-8c3d-4e5f6a7b8c9d'::uuid AS klassensprecher;

SELECT finalize_election(f.klassensprecherwahl, jsonb_build_array(jsonb_build_object('contestId', f.klassensprecher, 'outcome', s.outcome)), s.tally_version, s.app_version, s.git_sha)
  FROM fixture f
  JOIN round_contest rc ON rc.election_id = f.klassensprecherwahl AND rc.contest_id = f.klassensprecher
  JOIN result_snapshot s ON s.round_contest_id = rc.id;
