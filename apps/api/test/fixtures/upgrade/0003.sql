-- A genuine two-event chain, the known-answer records of
-- test/audit-chain.test.ts, so every later migration meets a populated
-- audit log whose hashes must still verify.

insert into audit_event (election_id, at, actor_tid, actor_oid, actor_name, action, metadata, prev_hash, hash) values
  ('0b9e4a52-3c1d-4f7e-9a6b-2d8c5e1f7a30', '2026-10-05T07:45:12.345Z',
   '6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b', '2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d', 'Maria Huber',
   'election.created', '{"title": "Schulsprecherwahl 2026/27"}',
   null, 'b6022b1fc84736cd665f1d8fec5926ca1d82bfcb1c9e51896c5350a3d34fe2cc'),
  ('0b9e4a52-3c1d-4f7e-9a6b-2d8c5e1f7a30', '2026-10-05T07:46:03.001Z',
   '6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b', '2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d', 'Maria Huber',
   'member.invited', '{"email": "witness@school.example", "role": "witness"}',
   'b6022b1fc84736cd665f1d8fec5926ca1d82bfcb1c9e51896c5350a3d34fe2cc', '7827d380b44d772cbfee0ecf7bb7189ab5d24c5255a70752db1489e0aa166ed6');
