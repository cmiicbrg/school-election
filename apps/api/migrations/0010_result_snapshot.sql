-- The result of one ballot box, computed from its sealed ballots when the
-- round closed, in the transaction that sealed it (lib/tally.ts): the
-- digest of what the count saw, the versions that computed it, the result
-- with its statistics and trace, and the outcome as it stood without lots.
-- Derived from the anonymous ballots and the configuration alone, never
-- per voter. Written once: a snapshot never changes, for any role, and the
-- runtime role may only add and read them (lib/runtime-privileges.ts).
-- Nothing is backfilled: no round was closed before this migration, since
-- closing had no route (the test fixtures seal one, and their 0010 fixture
-- adds its snapshot), and from now on a round is never closed without
-- its snapshots.

create table result_snapshot (
  id uuid primary key default gen_random_uuid(),
  election_id uuid not null,
  round_contest_id uuid not null unique,
  input_sha256 text not null check (input_sha256 ~ '^[0-9a-f]{64}$'),
  tally_version integer not null check (tally_version > 0),
  app_version text not null,
  git_sha text not null,
  result jsonb not null,
  outcome jsonb not null,
  foreign key (election_id, round_contest_id) references round_contest (election_id, id)
);

create function result_snapshot_kept() returns trigger
  language plpgsql set search_path = pg_catalog as $$
begin
  perform public.refuse('a result snapshot is written once and never changes');
  return null;
end
$$;

create trigger result_snapshot_kept before update or delete on result_snapshot
  for each row execute function result_snapshot_kept();
