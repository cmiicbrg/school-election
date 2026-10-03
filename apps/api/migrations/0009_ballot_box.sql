-- The ballot box: where ballots are staged while a round is open and where
-- they are kept once it is sealed, laid out so that nothing in the
-- database links a ballot to the key that cast it or to another ballot.
--
-- What could link them, and what this migration does about each:
--
-- - A column. A ballot carries its ballot box (round_contest), its kind
--   and its ranking: no credential, entitlement, session, user, time or
--   request. Nothing references a ballot.
-- - The transaction id. A vote uses an entitlement up and stages a ballot
--   in one transaction, so both rows carry the same xmin, and the three
--   ballots of one key carry three ids that pageinspect could pair with
--   the key's three entitlements. The seal moves the round's ballots under
--   fresh random ids and rewrites the round's entitlements, so every live
--   row of a sealed round carries the seal's one transaction id.
-- - The physical order. Rows lie in the order they were written, which is
--   the order votes came in; an entitlement used up at vote time gets a
--   new tuple at that moment. The seal inserts the ballots in id order,
--   which is random, so their order on disk, and with it a dump's order,
--   follows from the ids and the sizes of the rows and says nothing about
--   when a ballot was cast. The entitlements it writes again in credential
--   order, into the space the votes left behind, so the live rows no
--   longer lie in the order the votes used them up.
-- - Dead tuples and the write-ahead log. The staged rows the seal deletes,
--   the entitlement versions it replaces and the log of the vote
--   transactions stay on disk until the clean-up after the election
--   (VACUUM FULL and a write-ahead log switch), which the application
--   adds later; deploy/README.md keeps backups and snapshots away from
--   that window.
--
-- During voting the staging table is write-only for the runtime role: it
-- inserts ballots and cannot read, change or remove them, so no code path
-- can show a result or a single ballot before the round is sealed. Sealing
-- is closing: seal_round(), the only way a round leaves the open state,
-- does both in one transaction. Random (version 4) ids and no timestamps,
-- as everywhere, and no sequence: the ballots of a box are a set.

-- A ballot's kind mirrors BallotKind in packages/election-core, and a test
-- keeps the two equal: a complete ranking, "Nein" where a contest has a
-- single candidate, or an invalid vote, which keeps no content. A ranking
-- lists candidates from the highest slot down; no ruleset has more than
-- six slots. Which slots a contest has, and that a ranking fills them, is
-- the application's to check (election-core); the database keeps the
-- shape, and that a ranking names each candidate of its contest once
-- (ballot_staged below).
create table ballot_box (
  election_id uuid not null,
  round_contest_id uuid not null,
  kind text not null check (kind in ('ranking', 'no', 'invalid')),
  ranking uuid[] not null,
  check (coalesce(array_ndims(ranking), 1) = 1),
  check (array_position(ranking, null) is null),
  check (case when kind = 'ranking' then cardinality(ranking) between 1 and 6 else cardinality(ranking) = 0 end),
  foreign key (election_id, round_contest_id) references round_contest (election_id, id) on delete cascade
);

create table ballot (
  id uuid primary key default gen_random_uuid(),
  election_id uuid not null,
  round_contest_id uuid not null,
  kind text not null check (kind in ('ranking', 'no', 'invalid')),
  ranking uuid[] not null,
  check (coalesce(array_ndims(ranking), 1) = 1),
  check (array_position(ranking, null) is null),
  check (case when kind = 'ranking' then cardinality(ranking) between 1 and 6 else cardinality(ranking) = 0 end),
  foreign key (election_id, round_contest_id) references round_contest (election_id, id) on delete cascade
);
-- Reading a box's ballots for the count. A B-tree over this column orders
-- equal keys by physical position, which after the seal follows from the
-- random ids alone.
create index ballot_round_contest on ballot (election_id, round_contest_id);

-- A ballot is staged only while its round accepts ballots. The trigger
-- takes the election's row with a share lock first, as every trigger
-- does: a seal in progress holds that row until it commits, so this waits
-- for it, and a seal that comes later waits for the vote to commit. The
-- round's state is read afterwards, by a statement of its own, so it is
-- the state a seal left behind and not the one this transaction saw
-- before waiting (in read committed each statement takes a new snapshot;
-- a lock taken in the same statement would not refresh the round's row).
-- A ballot names each candidate once, candidates of its own contest only,
-- and "Nein" only where the contest has a single candidate. This binds
-- everyone, the seal and the owner included.
create function ballot_staged() returns trigger
  language plpgsql set search_path = pg_catalog as $$
declare
  accepting boolean;
  box_contest uuid;
begin
  perform 1 from public.election e where e.id = new.election_id for share of e;
  select rs.accepts_ballots, rc.contest_id into accepting, box_contest
    from public.round_contest rc
    join public.round r on r.id = rc.round_id
    join public.round_state rs on rs.state = r.state
   where rc.id = new.round_contest_id and rc.election_id = new.election_id;
  if accepting is not true then
    perform public.refuse('a ballot is cast only while its round is open');
  end if;
  if (select count(*) from unnest(new.ranking) as r (id)) <> (select count(distinct r.id) from unnest(new.ranking) as r (id)) then
    perform public.refuse('a ranking names each candidate once');
  end if;
  if exists (
    select 1 from unnest(new.ranking) as r (id)
     where not exists (select 1 from public.candidate c where c.id = r.id and c.contest_id = box_contest)
  ) then
    perform public.refuse('a ranking names candidates of its own contest');
  end if;
  if new.kind = 'no' and (select count(*) from public.candidate c where c.contest_id = box_contest) <> 1 then
    perform public.refuse('"Nein" is offered where a contest has a single candidate');
  end if;
  return new;
end
$$;

-- A staged ballot is moved by the seal and changed by nobody; a sealed
-- ballot is written by the seal, never changes, and leaves only with its
-- election. The seal and a foreign key's cascade run as the table owner
-- and are not bound (see 0008); every direct statement is.
create function ballot_kept() returns trigger
  language plpgsql set search_path = pg_catalog as $$
begin
  if tg_op = 'UPDATE' or current_user = session_user then
    perform public.refuse(format('%s rows are written and moved by the seal alone', tg_table_name));
  end if;
  return coalesce(new, old);
end
$$;

create trigger ballot_staged before insert on ballot_box
  for each row execute function ballot_staged();
create trigger ballot_box_kept before update or delete on ballot_box
  for each row execute function ballot_kept();
create trigger ballot_kept before insert or update or delete on ballot
  for each row execute function ballot_kept();

-- A round's state changes only along these rows: planned → open → closed.
-- The application opens a round itself (a direct update along the first
-- row); the seal closes it. Like the state tables, this is data the
-- triggers read, so a later state is a row here, not a trigger change.
create table round_transition (
  from_state text not null references round_state (state),
  to_state text not null references round_state (state),
  primary key (from_state, to_state)
);
insert into round_transition (from_state, to_state) values ('planned', 'open'), ('open', 'closed');

-- A round never moves to another election or kind, changes its state only
-- along round_transition, opens only once its election is active (its
-- candidates fixed, as the lifecycle in election-core has it: the
-- application moves the election and opens the round in one transaction,
-- the election first), and leaves a state that accepts ballots only
-- through the seal, which is not a direct statement: so a closed round is
-- always a sealed one. A closed round has no transition and never changes.
create function round_lifecycle() returns trigger
  language plpgsql set search_path = pg_catalog as $$
declare
  leaving public.round_state;
  entering public.round_state;
begin
  if (new.id, new.election_id, new.kind) is distinct from (old.id, old.election_id, old.kind) then
    perform public.refuse('a round never moves');
  end if;
  if new.state is distinct from old.state then
    if not exists (select 1 from public.round_transition t where t.from_state = old.state and t.to_state = new.state) then
      perform public.refuse(format('a round does not go from %s to %s', old.state, new.state));
    end if;
    select * into leaving from public.round_state s where s.state = old.state;
    select * into entering from public.round_state s where s.state = new.state;
    if entering.opened and not leaving.opened and not exists (
      select 1 from public.election e join public.election_state s on s.state = e.state
       where e.id = new.election_id and not s.candidates_editable and not s.final
         for share of e
    ) then
      perform public.refuse('a round opens only once its election is active');
    end if;
    if leaving.accepts_ballots and current_user = session_user then
      perform public.refuse('a round leaves a state that accepts ballots only through the seal');
    end if;
  end if;
  return new;
end
$$;

create trigger round_lifecycle before update on round
  for each row execute function round_lifecycle();

-- The seal: closes an open round and makes its ballots unlinkable, in one
-- transaction. It runs as the owner of the tables (SECURITY DEFINER, with
-- the search path pinned), because the runtime role may neither read nor
-- remove staged ballots, nor remove entitlements, nor close a round, and
-- it refuses anything but an open round, so a second call refuses too.
-- Returns the number of ballots sealed.
--
-- It locks the election's row as a change of the election would: every
-- vote holds that row for share until it commits (the entitlement
-- triggers of 0008 and ballot_staged above), so the seal waits for the
-- votes in flight, and a vote that arrives afterwards waits there and then
-- finds the round closed. A second seal waits for the first the same way,
-- and then reads the round, by a statement of its own with a snapshot of
-- its own, as closed.
create function seal_round(target uuid) returns integer
  language plpgsql security definer set search_path = pg_catalog as $$
declare
  election uuid;
  the_round public.round;
  is_open boolean;
  closed_state text;
  boxes uuid[];
  sealed integer;
  kept public.credential_entitlement[];
begin
  select e.id into election
    from public.round r join public.election e on e.id = r.election_id
   where r.id = target
     for no key update of e;
  if election is null then
    perform public.refuse('no such round');
  end if;
  select r.* into the_round from public.round r where r.id = target for no key update;
  select rs.opened and rs.accepts_ballots into is_open from public.round_state rs where rs.state = the_round.state;
  if not is_open then
    perform public.refuse('only an open round is sealed');
  end if;
  select t.to_state into closed_state
    from public.round_transition t join public.round_state rs on rs.state = t.to_state
   where t.from_state = the_round.state and rs.opened and not rs.accepts_ballots;
  update public.round set state = closed_state where id = target;

  boxes := array(select rc.id from public.round_contest rc where rc.round_id = target);

  -- Fresh ids, drawn once, and the rows written in their order.
  with staged as materialized (
    select gen_random_uuid() as id, b.election_id, b.round_contest_id, b.kind, b.ranking
      from public.ballot_box b
     where b.round_contest_id = any (boxes)
  )
  insert into public.ballot (id, election_id, round_contest_id, kind, ranking)
  select s.id, s.election_id, s.round_contest_id, s.kind, s.ranking from staged s order by s.id;
  get diagnostics sealed = row_count;
  delete from public.ballot_box b where b.round_contest_id = any (boxes);

  -- The entitlements as they are, written again in credential order: a
  -- separate delete and insert, since one statement doing both would
  -- find its own deleted rows still in the way of the primary key.
  kept := array(
    select e from public.credential_entitlement e
     where e.round_contest_id = any (boxes)
     order by e.credential_id, e.round_contest_id
  );
  delete from public.credential_entitlement e where e.round_contest_id = any (boxes);
  insert into public.credential_entitlement (election_id, credential_id, round_contest_id, consumed)
  select u.election_id, u.credential_id, u.round_contest_id, u.consumed
    from unnest(kept) with ordinality as u
   order by u.ordinality;
  return sealed;
end
$$;
