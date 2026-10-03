-- The configuration of the two 0004 elections, made the way the API makes
-- it, so every later migration meets populated configuration tables.
--
-- Maria Huber's draft: a Schulsprecherwahl with two candidates, one with a
-- picture (an 8 × 8 WebP), and two classes that vote in it.

INSERT INTO contest (id, election_id, title, ruleset_id) VALUES
  ('7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', '0b9e4a52-3c1d-4f7e-9a6b-2d8c5e1f7a30', 'Schulsprecher/in', 'at-school-speaker-v1');

INSERT INTO candidate (election_id, contest_id, surname, given_name, picture, picture_sha256) VALUES
  ('0b9e4a52-3c1d-4f7e-9a6b-2d8c5e1f7a30', '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', 'Özdemir', 'Elif',
   '\x524946463800000057454250565038202c000000d001009d012a0800080001402225a00274ba01f80003b000fef1dc8ffcf4cd7983fc9cffe4172c2eb6940000',
   '2f84977c6731a3c9967ba9664b3e50091520a8c0403d57ee0673d496bb164295'),
  ('0b9e4a52-3c1d-4f7e-9a6b-2d8c5e1f7a30', '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', 'Berger', 'Jonas', NULL, NULL);

INSERT INTO voter_group (id, election_id, name) VALUES
  ('8b2c3d4e-5f60-4b7c-9d8e-0f1a2b3c4d5e', '0b9e4a52-3c1d-4f7e-9a6b-2d8c5e1f7a30', '1A'),
  ('9c3d4e5f-6071-4c8d-8e9f-1a2b3c4d5e6f', '0b9e4a52-3c1d-4f7e-9a6b-2d8c5e1f7a30', '2B');

INSERT INTO voter_group_contest (election_id, voter_group_id, contest_id) VALUES
  ('0b9e4a52-3c1d-4f7e-9a6b-2d8c5e1f7a30', '8b2c3d4e-5f60-4b7c-9d8e-0f1a2b3c4d5e', '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'),
  ('0b9e4a52-3c1d-4f7e-9a6b-2d8c5e1f7a30', '9c3d4e5f-6071-4c8d-8e9f-1a2b3c4d5e6f', '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d');

-- The prepared Klassensprecherwahl 3B, which 0007 gave its regular round:
-- back to draft, its contest, candidates and class, its ballot box, and
-- prepared again.

UPDATE election SET state = 'draft' WHERE id = '5d7e9f10-2a3b-4c5d-8e6f-7a8b9c0d1e2f';

INSERT INTO contest (id, election_id, title, ruleset_id) VALUES
  ('a4d5e6f7-0819-4a2b-8c3d-4e5f6a7b8c9d', '5d7e9f10-2a3b-4c5d-8e6f-7a8b9c0d1e2f', 'Klassensprecher/in 3B', 'at-representative-v1');

INSERT INTO candidate (election_id, contest_id, surname, given_name) VALUES
  ('5d7e9f10-2a3b-4c5d-8e6f-7a8b9c0d1e2f', 'a4d5e6f7-0819-4a2b-8c3d-4e5f6a7b8c9d', 'Huber', 'Lena'),
  ('5d7e9f10-2a3b-4c5d-8e6f-7a8b9c0d1e2f', 'a4d5e6f7-0819-4a2b-8c3d-4e5f6a7b8c9d', 'Wagner', 'Paul'),
  ('5d7e9f10-2a3b-4c5d-8e6f-7a8b9c0d1e2f', 'a4d5e6f7-0819-4a2b-8c3d-4e5f6a7b8c9d', 'Wagner', 'Anna');

INSERT INTO voter_group (id, election_id, name) VALUES
  ('b5e6f708-192a-4b3c-9d4e-5f6a7b8c9d0e', '5d7e9f10-2a3b-4c5d-8e6f-7a8b9c0d1e2f', '3B');

INSERT INTO voter_group_contest (election_id, voter_group_id, contest_id) VALUES
  ('5d7e9f10-2a3b-4c5d-8e6f-7a8b9c0d1e2f', 'b5e6f708-192a-4b3c-9d4e-5f6a7b8c9d0e', 'a4d5e6f7-0819-4a2b-8c3d-4e5f6a7b8c9d');

INSERT INTO round_contest (election_id, round_id, contest_id)
SELECT r.election_id, r.id, 'a4d5e6f7-0819-4a2b-8c3d-4e5f6a7b8c9d'
  FROM round r WHERE r.election_id = '5d7e9f10-2a3b-4c5d-8e6f-7a8b9c0d1e2f' AND r.kind = 'regular';

UPDATE election SET state = 'prepared' WHERE id = '5d7e9f10-2a3b-4c5d-8e6f-7a8b9c0d1e2f';
