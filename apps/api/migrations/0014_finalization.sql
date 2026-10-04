-- Finalization: the final outcome of every contest, written once, and the
-- two functions of the clean-up that precedes it.
--
-- An election ends through finalization (lib/finalize.ts), after every
-- round is sealed: the application first removes what the seals left in
-- the data directory (the staged ballots the seal deleted and the
-- entitlement versions the votes and the seal replaced, as dead tuples,
-- and the write-ahead log of the vote transactions), then stores the
-- outcome of every contest as it stands, with the versions that derived
-- it, moves the election to final and records the owner's reason. The
-- snapshots pin the counts; the positions are derived from them and the
-- recorded lots by whatever election-core runs today, and a final election
-- must show what was declared after an upgrade too. Not a privacy table:
-- derived from the snapshots and the lots, never from a ballot, once per
-- contest, never per voter. Written once, and only by finalize_election
-- below, which declares and makes the election final in one step: a
-- trigger refuses any change, for every role, and the runtime role may
-- only read the rows (lib/runtime-privileges.ts).

create table final_outcome (
  election_id uuid not null references election (id),
  contest_id uuid primary key,
  kind text not null check (kind in ('final', 'lot-required', 'runoff-required', 'tie', 'committee-decision')),
  outcome jsonb not null check (outcome ->> 'kind' = kind),
  tally_version integer not null check (tally_version > 0),
  app_version text not null,
  git_sha text not null,
  foreign key (election_id, contest_id) references contest (election_id, id)
);

-- A final outcome is written while its election is active, once its
-- regular round has closed and while no round of it accepts ballots: the
-- transaction that makes the election final writes them just before. This
-- binds everyone, the owner included; the runtime role has no way to the
-- table but the function below. The regular round is the kind created
-- planned (0007): flags, not names.
create function final_outcome_written() returns trigger
  language plpgsql set search_path = pg_catalog as $$
declare
  active boolean;
begin
  select not s.candidates_editable and not s.final into active
    from public.election e join public.election_state s on s.state = e.state
   where e.id = new.election_id
     for share of e;
  if active is not true then
    perform public.refuse('a final outcome is written on an active election');
  end if;
  if exists (
    select 1 from public.round r join public.round_state rs on rs.state = r.state
     where r.election_id = new.election_id and rs.accepts_ballots
  ) then
    perform public.refuse('a final outcome is written while no round accepts ballots');
  end if;
  if not exists (
    select 1 from public.round r
      join public.round_state rs on rs.state = r.state
      join public.round_kind k on k.kind = r.kind and k.created_planned
     where r.election_id = new.election_id and rs.opened and not rs.accepts_ballots
  ) then
    perform public.refuse('a final outcome is written once the regular round has closed');
  end if;
  return new;
end
$$;

create function final_outcome_kept() returns trigger
  language plpgsql set search_path = pg_catalog as $$
begin
  perform public.refuse('a final outcome is written once and never changes');
  return null;
end
$$;

create trigger final_outcome_written before insert on final_outcome
  for each row execute function final_outcome_written();
create trigger final_outcome_kept before update or delete on final_outcome
  for each row execute function final_outcome_kept();

-- The lifecycle trigger of 0007, as 0011 left it, with the step to the
-- final state guarded: an election is final only once its regular round
-- has closed, while no round of it accepts ballots, and with the final
-- outcome of every contest written. The state it moves to is read by its
-- flag, as the state it leaves is.
create or replace function election_lifecycle() returns trigger
  language plpgsql set search_path = pg_catalog as $$
declare
  was public.election_state;
  becomes public.election_state;
begin
  select * into was from public.election_state s where s.state = old.state;
  if was.final then
    perform public.refuse('a final election never changes');
  end if;
  if (new.title, new.description) is distinct from (old.title, old.description) and (not was.candidates_editable or exists (
    select 1 from public.round r join public.round_state rs on rs.state = r.state
     where r.election_id = new.id and rs.accepts_ballots and not rs.opened
  )) then
    perform public.refuse('title and description change only until voting starts, and not while a round is in test mode');
  end if;
  if new.state is distinct from old.state then
    if new.state is distinct from was.advances_to and new.state is distinct from was.returns_to then
      perform public.refuse(format('an election does not go from %s to %s', old.state, new.state));
    end if;
    if new.state = was.returns_to and exists (
      select 1 from public.round r join public.round_state rs on rs.state = r.state
       where r.election_id = new.id and (rs.opened or rs.accepts_ballots)
    ) then
      perform public.refuse('an election goes back to draft only before any round has opened, and not while one is in test mode');
    end if;
    select * into becomes from public.election_state s where s.state = new.state;
    if becomes.final then
      if exists (
        select 1 from public.round r join public.round_state rs on rs.state = r.state
         where r.election_id = new.id and rs.accepts_ballots
      ) then
        perform public.refuse('an election is final only while no round accepts ballots');
      end if;
      if not exists (
        select 1 from public.round r
          join public.round_state rs on rs.state = r.state
          join public.round_kind k on k.kind = r.kind and k.created_planned
         where r.election_id = new.id and rs.opened and not rs.accepts_ballots
      ) then
        perform public.refuse('an election is final once its regular round has closed');
      end if;
      if exists (
        select 1 from public.contest c left join public.final_outcome f on f.contest_id = c.id
         where c.election_id = new.id and f.contest_id is null
      ) then
        perform public.refuse('an election is final with the final outcome of every contest written');
      end if;
    end if;
  end if;
  return new;
end
$$;

-- Finalization itself: the declared outcome of every contest written, and
-- the election moved to the state its state advances to, in one step, by
-- the application's definer function (lib/finalize.ts), so no declaration
-- exists apart from a final election. `outcomes` is a JSON array of
-- { "contestId": uuid, "outcome": election-core's outcome }, one per
-- contest of the election; the kind is the outcome's own. The triggers
-- above keep the windows for the function's statements as for any other:
-- an election not active, a round still accepting ballots or a regular
-- round not closed refuse. Returns how many outcomes were declared.
create function finalize_election(target uuid, outcomes jsonb, tally_version integer, app_version text, git_sha text) returns integer
  language plpgsql security definer set search_path = pg_catalog as $$
declare
  active boolean;
  declared integer;
begin
  select not s.candidates_editable and not s.final into active
    from public.election e join public.election_state s on s.state = e.state
   where e.id = target
     for no key update of e;
  if active is null then
    perform public.refuse('no such election');
  end if;
  if not active then
    perform public.refuse('an election is finalized while active');
  end if;
  if outcomes is null or jsonb_typeof(outcomes) <> 'array' then
    perform public.refuse('a declaration is a list of outcomes');
  end if;
  if (select count(*) from jsonb_array_elements(outcomes) as o) <> (select count(*) from public.contest c where c.election_id = target)
     or (select count(distinct o ->> 'contestId') from jsonb_array_elements(outcomes) as o) <> (select count(*) from jsonb_array_elements(outcomes) as o)
     or exists (
       select 1 from jsonb_array_elements(outcomes) as o
         left join public.contest c on c.id = (o ->> 'contestId')::uuid and c.election_id = target
        where c.id is null
     ) then
    perform public.refuse('a declaration names every contest of the election, once');
  end if;
  insert into public.final_outcome (election_id, contest_id, kind, outcome, tally_version, app_version, git_sha)
  select target, (o ->> 'contestId')::uuid, o -> 'outcome' ->> 'kind', o -> 'outcome', tally_version, app_version, git_sha
    from jsonb_array_elements(outcomes) as o;
  get diagnostics declared = row_count;
  update public.election e set state = s.advances_to
    from public.election_state s
   where e.id = target and s.state = e.state;
  return declared;
end
$$;

-- A lot is recorded on an active election (0013 asked for the regular
-- round closed and nothing accepting ballots, which a final election
-- satisfies too): once final, nothing of the election changes, the lots
-- included, for every role.
create or replace function lot_decision_recorded() returns trigger
  language plpgsql set search_path = pg_catalog as $$
declare
  box record;
  active boolean;
begin
  select not s.candidates_editable and not s.final into active
    from public.election e join public.election_state s on s.state = e.state
   where e.id = new.election_id
     for share of e;
  if active is not true then
    perform public.refuse('a lot is recorded on an active election');
  end if;
  -- The regular round is the kind created planned (0007): flags, not names.
  select rc.contest_id, k.created_planned as regular into box
    from public.round_contest rc
    join public.round r on r.id = rc.round_id
    join public.round_kind k on k.kind = r.kind
   where rc.id = new.round_contest_id and rc.election_id = new.election_id;
  if box.regular is not true then
    perform public.refuse('a lot is recorded on a box of the regular round');
  end if;
  if exists (
    select 1 from public.round r join public.round_state rs on rs.state = r.state
     where r.election_id = new.election_id and rs.accepts_ballots
  ) then
    perform public.refuse('a lot is recorded while no round accepts ballots');
  end if;
  if not exists (
    select 1 from public.round r
      join public.round_state rs on rs.state = r.state
      join public.round_kind k on k.kind = r.kind and k.created_planned
     where r.election_id = new.election_id and rs.opened and not rs.accepts_ballots
  ) then
    perform public.refuse('a lot is recorded once the regular round has closed');
  end if;
  if (select array_agg(x order by x) from unnest(new.candidates) as x) <> (select array_agg(x order by x) from unnest(new.drawn) as x) then
    perform public.refuse('the order drawn is the tied set');
  end if;
  if (select count(distinct c.id) from public.candidate c where c.contest_id = box.contest_id and c.id = any (new.candidates)) <> cardinality(new.candidates) then
    perform public.refuse('a lot is drawn among candidates of its contest, each once');
  end if;
  return new;
end
$$;

-- The clean-up (lib/cleanup.ts) rewrites ballot_box and
-- credential_entitlement without their dead rows (VACUUM FULL, which the
-- runtime role runs with MAINTAIN on the two tables, since VACUUM cannot
-- run inside a function) and then removes the write-ahead log written
-- before that. Two things it needs run as the owner, each one fixed
-- action: a count of what would keep the dead rows alive, read from
-- catalog views the runtime role cannot see into, and the flush of the
-- write-ahead log with its check.

-- How many sessions, prepared transactions and replication slots hold a
-- snapshot that could still see what the election's seals removed: one
-- whose xmin or transaction id is at or before the youngest seal of the
-- election. VACUUM keeps a dead row for as long as such a snapshot exists,
-- so the clean-up waits until this is zero. The seal's id is the xmin of
-- every live row of a sealed round; ids are compared by age, the one
-- ordering of 32-bit transaction ids. The caller's own session is left
-- out. An election without a sealed row has nothing to wait for. A vacuum
-- may have frozen the sealed rows by then: xmin still shows the seal's
-- id (freezing is a flag on the tuple), so the comparison stands, and a
-- tuple is frozen only once its transaction precedes every snapshot, so
-- no snapshot older than the seal exists alongside frozen sealed rows
-- and none can start later (test/db/cleanup.test.ts).
create function cleanup_blockers(target uuid) returns integer
  language plpgsql security definer set search_path = pg_catalog as $$
declare
  seal_age integer;
  blockers integer;
begin
  select min(age(sealed.x)) into seal_age from (
    select b.xmin as x from public.ballot b where b.election_id = target
    union all
    select e.xmin from public.credential_entitlement e where e.election_id = target
  ) as sealed;
  if seal_age is null then
    return 0;
  end if;
  select count(*)::integer into blockers from (
    select a.pid from pg_stat_activity a
     where a.pid <> pg_backend_pid() and (age(a.backend_xmin) >= seal_age or age(a.backend_xid) >= seal_age)
    union all
    select 0 from pg_prepared_xacts p where age(p.transaction) >= seal_age
    union all
    select 0 from pg_replication_slots s where age(s.xmin) >= seal_age or age(s.catalog_xmin) >= seal_age
  ) as held;
  return blockers;
end
$$;

-- Switches the write-ahead log and checkpoints, twice, so the segments
-- written before `after` are removed (wal_recycle is off, so they are
-- unlinked, not renamed and reused; apps/api/lib/db-settings.ts), and says
-- whether that happened: true iff no segment on disk sorts at or before
-- the one that holds `after`. The caller passes the position it read after
-- its rewrite. Nothing of the directory listing reaches the caller.
-- CHECKPOINT, unlike VACUUM, runs inside a function (it is no
-- transaction control); test/db/cleanup.test.ts runs this one and reads
-- the directory afterwards.
create function flush_wal(after pg_lsn) returns boolean
  language plpgsql security definer set search_path = pg_catalog as $$
begin
  perform pg_switch_wal();
  execute 'checkpoint';
  perform pg_switch_wal();
  execute 'checkpoint';
  return not exists (
    select 1 from pg_ls_waldir() as w
     where w.name ~ '^[0-9A-F]{24}$' and w.name <= pg_walfile_name(after)
  );
end
$$;
