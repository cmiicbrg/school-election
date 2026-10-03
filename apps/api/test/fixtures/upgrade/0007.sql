-- The configuration of the two 0004 elections, made the way the API makes
-- it, so every later migration meets populated configuration tables. The
-- ids it uses, each named once, in a table of this session:

CREATE TEMP TABLE fixture AS SELECT
  '0b9e4a52-3c1d-4f7e-9a6b-2d8c5e1f7a30'::uuid AS schulsprecherwahl,
  '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'::uuid AS schulsprecher,
  '8b2c3d4e-5f60-4b7c-9d8e-0f1a2b3c4d5e'::uuid AS class_1a,
  '9c3d4e5f-6071-4c8d-8e9f-1a2b3c4d5e6f'::uuid AS class_2b,
  '5d7e9f10-2a3b-4c5d-8e6f-7a8b9c0d1e2f'::uuid AS klassensprecherwahl,
  'a4d5e6f7-0819-4a2b-8c3d-4e5f6a7b8c9d'::uuid AS klassensprecher,
  'b5e6f708-192a-4b3c-9d4e-5f6a7b8c9d0e'::uuid AS class_3b;

-- Maria Huber's draft: a Schulsprecherwahl with two candidates, one with a
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

-- The prepared Klassensprecherwahl 3B, which 0007 gave its regular round:
-- back to draft, its contest, candidates and class, its ballot box, and
-- prepared again.

UPDATE election SET state = 'draft' FROM fixture f WHERE election.id = f.klassensprecherwahl;

INSERT INTO contest (id, election_id, title, ruleset_id)
SELECT klassensprecher, klassensprecherwahl, 'Klassensprecher/in 3B', 'at-representative-v1' FROM fixture;

INSERT INTO candidate (election_id, contest_id, surname, given_name)
SELECT f.klassensprecherwahl, f.klassensprecher, c.surname, c.given_name
  FROM fixture f, (VALUES ('Huber', 'Lena'), ('Wagner', 'Paul'), ('Wagner', 'Anna')) AS c (surname, given_name);

INSERT INTO voter_group (id, election_id, name)
SELECT class_3b, klassensprecherwahl, '3B' FROM fixture;

INSERT INTO voter_group_contest (election_id, voter_group_id, contest_id)
SELECT klassensprecherwahl, class_3b, klassensprecher FROM fixture;

INSERT INTO round_contest (election_id, round_id, contest_id)
SELECT r.election_id, r.id, f.klassensprecher
  FROM fixture f JOIN round r ON r.election_id = f.klassensprecherwahl AND r.kind = 'regular';

UPDATE election SET state = 'prepared' FROM fixture f WHERE election.id = f.klassensprecherwahl;
