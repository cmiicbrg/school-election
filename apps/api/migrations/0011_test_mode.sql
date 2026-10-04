-- The test mode of a prepared election, and deleting an election nobody
-- used.
--
-- A round in test mode accepts ballots as an open round does, but has not
-- opened: the election stays prepared, and keys and ballots behave as they
-- do during the election. The test ends by taking the round back to
-- planned with nothing kept: the ballots it staged are removed and every
-- entitlement is unused again. Flags, not names (0007, 0009): the staging
-- trigger and the entitlement triggers read accepts_ballots, the seal
-- requires an opened round, so it never applies to a test, and a round
-- leaves a state that accepts ballots only through a definer function,
-- which end_test is. Starting a test is the runtime role's direct update
-- along the new transition row.

insert into round_state (state, opened, accepts_ballots) values ('testing', false, true);
insert into round_transition (from_state, to_state) values ('planned', 'testing'), ('testing', 'planned');

-- A test's ballots name candidates, so candidates change only while no
-- round of their election accepts ballots without having opened: the
-- window of 0007, with the test added.
create or replace function candidate_window() returns trigger
  language plpgsql set search_path = pg_catalog as $$
declare
  editable boolean;
begin
  for editable in
    select s.candidates_editable
      from public.election e join public.election_state s on s.state = e.state
     where e.id = old.election_id or e.id = new.election_id
     order by e.id
       for share of e
  loop
    if not editable then
      perform public.refuse('candidate rows change only while their election is draft or prepared');
    end if;
  end loop;
  if exists (
    select 1 from public.round r join public.round_state rs on rs.state = r.state
     where (r.election_id = old.election_id or r.election_id = new.election_id) and rs.accepts_ballots and not rs.opened
  ) then
    perform public.refuse('candidate rows change only while no round of their election is in test mode');
  end if;
  return coalesce(new, old);
end
$$;

-- Ends a test: removes the round's staged ballots, sets every entitlement
-- of the round unused and takes the round back to planned, in one
-- transaction, as the owner of the tables (the runtime role may neither
-- remove a staged ballot nor restore an entitlement). It locks the
-- round's entitlements and then the election's row in the seal's order,
-- so it waits for votes in flight and never deadlocks with one, and it
-- refuses anything but a round in test mode. Returns how many ballots it
-- removed and how many keys had voted.
create function end_test(target uuid, out ballots integer, out keys integer)
  language plpgsql security definer set search_path = pg_catalog as $$
declare
  election uuid;
  the_round public.round;
  is_testing boolean;
  planned_state text;
begin
  perform 1 from public.credential_entitlement e
    where e.round_contest_id in (select rc.id from public.round_contest rc where rc.round_id = target)
      for update;
  select e.id into election
    from public.round r join public.election e on e.id = r.election_id
   where r.id = target
     for no key update of e;
  if election is null then
    perform public.refuse('no such round');
  end if;
  select r.* into the_round from public.round r where r.id = target for no key update;
  select rs.accepts_ballots and not rs.opened into is_testing from public.round_state rs where rs.state = the_round.state;
  if not is_testing then
    perform public.refuse('only a round in test mode is ended');
  end if;
  select count(distinct e.credential_id)::integer into keys
    from public.credential_entitlement e join public.round_contest rc on rc.id = e.round_contest_id
   where rc.round_id = target and e.consumed;
  delete from public.ballot_box b
   where b.round_contest_id in (select rc.id from public.round_contest rc where rc.round_id = target);
  get diagnostics ballots = row_count;
  update public.credential_entitlement e set consumed = false
    from public.round_contest rc
   where rc.id = e.round_contest_id and rc.round_id = target and e.consumed;
  select t.to_state into planned_state
    from public.round_transition t join public.round_state rs on rs.state = t.to_state
   where t.from_state = the_round.state and not rs.accepts_ballots and not rs.opened;
  update public.round set state = planned_state where id = target;
end
$$;

-- The staged ballots of a round, only while it is in test mode, for the
-- test result: the one case of staged ballots being read. A test is not
-- secret: its ballots are the teacher's own and go when the test ends.
create function test_ballots(target uuid)
  returns table (round_contest_id uuid, kind text, ranking uuid[])
  language plpgsql security definer set search_path = pg_catalog as $$
declare
  is_testing boolean;
begin
  select rs.accepts_ballots and not rs.opened into is_testing
    from public.round r join public.round_state rs on rs.state = r.state
   where r.id = target;
  if is_testing is not true then
    perform public.refuse('the ballots of a round are read only while it is in test mode');
  end if;
  return query
    select b.round_contest_id, b.kind, b.ranking
      from public.ballot_box b join public.round_contest rc on rc.id = b.round_contest_id
     where rc.round_id = target
     order by b.round_contest_id, b.kind, b.ranking;
end
$$;

-- Removes an election nobody used, with everything of it, the audit
-- events included: a draft, or a prepared election whose rounds are all
-- planned (neither opened nor in test mode). A prepared one goes back to
-- draft first, so the windows of 0007 let its structure go; the rest
-- follows the foreign keys, in dependency order.
create function delete_election(target uuid) returns void
  language plpgsql security definer set search_path = pg_catalog as $$
declare
  the_election public.election;
  editable boolean;
begin
  select e.* into the_election from public.election e where e.id = target for no key update;
  if the_election is null then
    perform public.refuse('no such election');
  end if;
  select s.structure_editable into editable from public.election_state s where s.state = the_election.state;
  if (not editable and (select s.returns_to from public.election_state s where s.state = the_election.state) is null) or exists (
    select 1 from public.round r join public.round_state rs on rs.state = r.state
     where r.election_id = target and (rs.opened or rs.accepts_ballots)
  ) then
    perform public.refuse('only an election nobody used is deleted: a draft, or a prepared one whose rounds are planned');
  end if;
  if not editable then
    update public.election e set state = s.returns_to from public.election_state s where s.state = e.state and e.id = target;
  end if;
  delete from public.contest where election_id = target;
  delete from public.voter_group where election_id = target;
  delete from public.round where election_id = target;
  delete from public.election_member where election_id = target;
  delete from public.audit_event where election_id = target;
  delete from public.election where id = target;
end
$$;
