-- The Klassensprecherwahl 3B's result, made the way the API makes it when
-- the round closes (lib/tally.ts), so every later migration meets a
-- snapshot: one for the one ballot box the 0009 fixture sealed, with two
-- ballots (Lena Huber first on one, Paul Wagner on the other). The result
-- and the outcome are what the count gives for them; the digest is taken
-- here over the count's own canonical input, since the candidates' ids are
-- drawn when the 0007 fixture inserts them.

CREATE TEMP TABLE fixture AS SELECT
  '5d7e9f10-2a3b-4c5d-8e6f-7a8b9c0d1e2f'::uuid AS klassensprecherwahl,
  'a4d5e6f7-0819-4a2b-8c3d-4e5f6a7b8c9d'::uuid AS klassensprecher;

CREATE TEMP TABLE template AS SELECT
  $input${"ballots":[{"kind":"ranking","ranking":["HUBER","PAUL"]},{"kind":"ranking","ranking":["PAUL","HUBER"]}],"contest":{"candidateIds":["HUBER","ANNA","PAUL"],"id":"a4d5e6f7-0819-4a2b-8c3d-4e5f6a7b8c9d","rulesetId":"at-representative-v1"},"tallyVersion":2}$input$::text AS input,
  $result${"contestId":"a4d5e6f7-0819-4a2b-8c3d-4e5f6a7b8c9d","rulesetId":"at-representative-v1","statistics":{"validBallots":2,"noBallots":0,"invalidBallots":0,"candidates":[{"candidateId":"HUBER","firstPlaces":1,"rankCounts":[1,1],"points":3},{"candidateId":"ANNA","firstPlaces":0,"rankCounts":[0,0],"points":0},{"candidateId":"PAUL","firstPlaces":1,"rankCounts":[1,1],"points":3}]},"kind":"runoff-required","runoffCandidates":["HUBER","PAUL"],"trace":[{"step":"count","contestId":"a4d5e6f7-0819-4a2b-8c3d-4e5f6a7b8c9d","ballotsCast":2,"validBallots":2,"noBallots":0,"invalidBallots":0},{"step":"majority","required":2,"elected":null},{"step":"compare","basis":"first-places","seats":2,"values":[{"candidateId":"HUBER","value":1},{"candidateId":"PAUL","value":1},{"candidateId":"ANNA","value":0}],"advancing":["HUBER","PAUL"],"tied":[]},{"step":"runoff","candidates":["HUBER","PAUL"]}]}$result$::text AS result,
  $outcome${"kind":"runoff-required","runoffCandidates":["HUBER","PAUL"],"trace":[{"step":"count","contestId":"a4d5e6f7-0819-4a2b-8c3d-4e5f6a7b8c9d","ballotsCast":2,"validBallots":2,"noBallots":0,"invalidBallots":0},{"step":"majority","required":2,"elected":null},{"step":"compare","basis":"first-places","seats":2,"values":[{"candidateId":"HUBER","value":1},{"candidateId":"PAUL","value":1},{"candidateId":"ANNA","value":0}],"advancing":["HUBER","PAUL"],"tied":[]},{"step":"runoff","candidates":["HUBER","PAUL"]}]}$outcome$::text AS outcome;

-- The candidates' ids, drawn by the 0007 fixture, in place of the
-- placeholders the count's text names them by.
CREATE TEMP TABLE ids AS
SELECT huber.id AS huber, anna.id AS anna, paul.id AS paul
  FROM fixture f
  JOIN candidate huber ON huber.contest_id = f.klassensprecher AND huber.surname = 'Huber'
  JOIN candidate anna ON anna.contest_id = f.klassensprecher AND anna.surname = 'Wagner' AND anna.given_name = 'Anna'
  JOIN candidate paul ON paul.contest_id = f.klassensprecher AND paul.surname = 'Wagner' AND paul.given_name = 'Paul';

CREATE FUNCTION pg_temp.with_ids(template text) RETURNS text LANGUAGE sql AS $$
  SELECT replace(replace(replace(template, 'HUBER', huber::text), 'ANNA', anna::text), 'PAUL', paul::text) FROM ids
$$;

INSERT INTO result_snapshot (election_id, round_contest_id, input_sha256, tally_version, app_version, git_sha, result, outcome)
SELECT rc.election_id, rc.id,
       encode(sha256(convert_to(pg_temp.with_ids(t.input), 'UTF8')), 'hex'),
       2, 'dev', 'unknown',
       pg_temp.with_ids(t.result)::jsonb,
       pg_temp.with_ids(t.outcome)::jsonb
  FROM fixture f
  CROSS JOIN template t
  JOIN round_contest rc ON rc.election_id = f.klassensprecherwahl AND rc.contest_id = f.klassensprecher;
