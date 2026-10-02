-- The administrative audit log: one append-only, hash-chained list of events
-- per election, written by apps/api/lib/audit.ts in the transaction of the
-- change each event records. It holds administrators' actions only, never
-- voter activity, so nothing in it can link a ballot to a key, a session or
-- another ballot.
--
-- The runtime role may add and read events, never change or remove them.
-- The database keeps each chain linear: an election has one first event (no
-- predecessor), every other event names an existing event of the same
-- election as its predecessor, and no event is the predecessor of two.
-- Whether the hashes are right is checked by recomputing them
-- (verifyAuditChain), by the server and by the offline verifier.
--
-- election_id gets its foreign key with the election table.

create table audit_event (
  seq bigint generated always as identity primary key,
  election_id uuid not null,
  -- Milliseconds, which the hashed ISO 8601 text and a JavaScript Date hold exactly.
  at timestamptz not null check (at = date_trunc('milliseconds', at)),
  -- The stable Entra identity of the actor, and the name shown for it.
  actor_tid uuid not null,
  actor_oid uuid not null,
  actor_name text not null check (char_length(actor_name) between 1 and 256),
  action text not null check (action ~ '^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$' and char_length(action) <= 64),
  metadata jsonb not null check (jsonb_typeof(metadata) = 'object'),
  prev_hash text check (prev_hash ~ '^[0-9a-f]{64}$'),
  hash text not null check (hash ~ '^[0-9a-f]{64}$'),
  unique (election_id, hash),
  unique nulls not distinct (election_id, prev_hash),
  foreign key (election_id, prev_hash) references audit_event (election_id, hash)
);

-- The chain head (the newest event) and a chain in order.
create index audit_event_election_seq on audit_event (election_id, seq);

grant select, insert on audit_event to school_election_app;
