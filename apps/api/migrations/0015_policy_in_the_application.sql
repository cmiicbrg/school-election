-- The windows of the lifecycle are the application's; the database keeps
-- what the stored data must always satisfy, whoever writes it.
--
-- Migrations 0007 to 0014 restated the lifecycle's windows as triggers:
-- whether the structure, the candidates, the title or the keys may change
-- now, which state an election may move to, when a round may open or
-- enter test mode, when a lot or a final outcome may be written. Every one
-- of those is a guard of election-core's lifecycle (packages/election-core/
-- src/lifecycle.ts), asked by the route and asked again by changeElection
-- under the election's lock before the change is made, so the triggers
-- were a second implementation of the same policy. They go. What stays
-- are the invariants of the stored data: a round moves only along its
-- transitions and leaves a state that accepts ballots only through the
-- seal or the end of a test; a final election never changes, and becomes
-- final only with the final outcome of every contest written; a runoff
-- box names two candidates of its contest and no other box names a pair;
-- a lot is recorded on a box of the regular round, among candidates of
-- its contest, with the order drawn being exactly the tied set, and never
-- on a final election. The vote-once rules of the entitlements, the
-- write-only ballot box, the seal and the immutability of snapshots, lots
-- and declared outcomes are untouched. The flag tables stay as they are,
-- read by the definer functions and the triggers that remain.

drop trigger contest_window on contest;
drop trigger voter_group_window on voter_group;
drop trigger voter_group_contest_window on voter_group_contest;
drop function structure_window();
drop trigger candidate_window on candidate;
drop function candidate_window();
drop trigger candidate_keep_one on candidate;
drop function candidate_keep_one();
drop trigger round_created_planned on round;
drop function round_created_planned();
drop trigger credential_batch_prepared on credential_batch;
drop function credential_batch_prepared();
drop trigger credential_batch_window on credential_batch;
drop function credential_batch_window();
drop trigger credential_added on credential;
drop function credential_added();
drop trigger final_outcome_written on final_outcome;
drop function final_outcome_written();

-- A final election never changes; an election becomes final only with the
-- final outcome of every contest written (finalize_election writes them in
-- the same step). Which state follows which is the lifecycle's.
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
  if new.state is distinct from old.state then
    select * into becomes from public.election_state s where s.state = new.state;
    if becomes.final and exists (
      select 1 from public.contest c left join public.final_outcome f on f.contest_id = c.id
       where c.election_id = new.id and f.contest_id is null
    ) then
      perform public.refuse('an election is final with the final outcome of every contest written');
    end if;
  end if;
  return new;
end
$$;

-- A round never moves, changes state only along round_transition, and
-- leaves a state that accepts ballots only through a definer function:
-- the seal for an open round, the end of a test for one in test mode.
-- Whether its election is in the state for the step is the lifecycle's.
create or replace function round_lifecycle() returns trigger
  language plpgsql set search_path = pg_catalog as $$
declare
  leaving public.round_state;
begin
  if (new.id, new.election_id, new.kind) is distinct from (old.id, old.election_id, old.kind) then
    perform public.refuse('a round never moves');
  end if;
  if new.state is distinct from old.state then
    if not exists (select 1 from public.round_transition t where t.from_state = old.state and t.to_state = new.state) then
      perform public.refuse(format('a round does not go from %s to %s', old.state, new.state));
    end if;
    select * into leaving from public.round_state s where s.state = old.state;
    if leaving.accepts_ballots and current_user = session_user then
      perform public.refuse('a round leaves a state that accepts ballots only through the seal');
    end if;
  end if;
  return new;
end
$$;

-- A runoff round's box names its pair, two candidates of its own contest,
-- and no other round's box names one, whoever adds it. When a box may be
-- added or removed is the lifecycle's.
create or replace function round_contest_window() returns trigger
  language plpgsql set search_path = pg_catalog as $$
declare
  target_kind text;
begin
  if tg_op = 'DELETE' then
    return old;
  end if;
  select r.kind into target_kind from public.round r where r.id = new.round_id;
  if (new.runoff_pair is null) <> (target_kind is distinct from 'runoff') then
    perform public.refuse('a runoff box names its pair, and no other box does');
  end if;
  if new.runoff_pair is not null and (
    select count(*) from public.candidate c where c.contest_id = new.contest_id and c.id = any (new.runoff_pair)
  ) <> 2 then
    perform public.refuse('a runoff pair names two candidates of its contest');
  end if;
  return new;
end
$$;

-- A lot is recorded on a box of the regular round, among candidates of
-- the box's contest, the order drawn being exactly the tied set, and never
-- on a final election. Whether the election is at the point for a lot is
-- the lifecycle's; which lots a result requires is election-core's.
create or replace function lot_decision_recorded() returns trigger
  language plpgsql set search_path = pg_catalog as $$
declare
  box record;
  final boolean;
begin
  select s.final into final
    from public.election e join public.election_state s on s.state = e.state
   where e.id = new.election_id
     for share of e;
  if final is distinct from false then
    perform public.refuse('a lot is recorded on an election that is not final');
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
  if (select array_agg(x order by x) from unnest(new.candidates) as x) <> (select array_agg(x order by x) from unnest(new.drawn) as x) then
    perform public.refuse('the order drawn is the tied set');
  end if;
  if (select count(distinct c.id) from public.candidate c where c.contest_id = box.contest_id and c.id = any (new.candidates)) <> cardinality(new.candidates) then
    perform public.refuse('a lot is drawn among candidates of its contest, each once');
  end if;
  return new;
end
$$;
