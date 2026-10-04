-- A lot recorded on the Klassensprecherwahl 3B's box, so every later
-- migration meets a recorded lot: the officials drew between Anna and
-- Paul Wagner for the deputy's place, Paul first.

CREATE TEMP TABLE fixture AS SELECT
  '5d7e9f10-2a3b-4c5d-8e6f-7a8b9c0d1e2f'::uuid AS klassensprecherwahl,
  'a4d5e6f7-0819-4a2b-8c3d-4e5f6a7b8c9d'::uuid AS klassensprecher;

INSERT INTO lot_decision (election_id, round_contest_id, lot_id, candidates, drawn, reason, actor_tid, actor_oid, actor_name)
SELECT rc.election_id, rc.id, 'positions:deputy', ARRAY[anna.id, paul.id], ARRAY[paul.id, anna.id],
       'Losentscheid der Wahlkommission am 3. Oktober', '6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b', 'a0000000-0000-4000-8000-00000000000a', 'Anna Lehrerin'
  FROM fixture f
  JOIN round_contest rc ON rc.election_id = f.klassensprecherwahl AND rc.contest_id = f.klassensprecher
  JOIN candidate anna ON anna.contest_id = f.klassensprecher AND anna.surname = 'Wagner' AND anna.given_name = 'Anna'
  JOIN candidate paul ON paul.contest_id = f.klassensprecher AND paul.surname = 'Wagner' AND paul.given_name = 'Paul';
