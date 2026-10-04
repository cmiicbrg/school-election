-- The runoff round, the pair its ballot boxes are for, and the lots the
-- officials drew, as recorded.
--
-- A runoff is a round of its own, voted on fresh keys, with one ballot box
-- per contest that needs one, for exactly the two candidates the first
-- round's result and the recorded lots name: the box is a round_contest of
-- the same contest, with the pair in a column of its own, so turnout, the
-- seal, the snapshot and the privacy tables need no second shape, and the
-- staging trigger lets a runoff ballot name the pair alone. The round comes
-- to be in one way only, activate_runoff, a definer function the runtime
-- role calls, which creates it open, with its boxes and with an entitlement
-- per key of every issued runoff batch of the groups that vote in the
-- contest: there is nothing to prepare for a runoff, so it has no planned
-- state, and a round that accepts ballots is entered only through a
-- definer function, as 0011 has it for leaving one. The triggers that let
-- only a regular round be created, planned, and ballot boxes change only
-- while their round is planned, exempt a definer function as the
-- entitlement window does (0011) and bind every direct statement as before,
-- the owner's included: no runoff round is ever made by hand.
--
-- A lot the officials drew is recorded once by an authorised person, with
-- the lot's id as election-core names it, the tied set, the order drawn,
-- the reason and the actor, and never changes: lib/outcome.ts applies the
-- recorded decisions through election-core's resolve, which refuses a
-- decision that is not exactly the lot's tied set, a second one for a lot,
-- or one for a lot that is not required. Not a privacy table: a lot names
-- candidates and officials, never a voter.

alter table round_contest add column runoff_pair uuid[]
  check (runoff_pair is null or (
    cardinality(runoff_pair) = 2 and runoff_pair[1] is not null and runoff_pair[2] is not null and runoff_pair[1] <> runoff_pair[2]
  ));

-- A regular round is created planned, by hand or by the application,
-- before voting starts (0007); a runoff round only by the definer
-- function below, which keeps rules of its own.
create or replace function round_created_planned() returns trigger
  language plpgsql set search_path = pg_catalog as $$
begin
  if current_user <> session_user then
    return new;
  end if;
  if not exists (
    select 1 from public.round_kind k, public.round_state rs
     where k.kind = new.kind and k.created_planned and rs.state = new.state and not rs.opened
  ) or not exists (
    select 1 from public.election e join public.election_state s on s.state = e.state
     where e.id = new.election_id and s.candidates_editable
       for share of e
  ) then
    perform public.refuse('a regular round is created planned, before voting starts');
  end if;
  return new;
end
$$;

-- Ballot boxes change only while their round is planned (0007, 0011), by
-- a direct statement; the definer function adds a runoff's. A runoff
-- round's box names its pair, two candidates of its own contest, and no
-- other round's box names one, whoever adds it.
create or replace function round_contest_window() returns trigger
  language plpgsql set search_path = pg_catalog as $$
declare
  target uuid := coalesce(new.round_id, old.round_id);
  target_kind text;
begin
  if tg_op <> 'DELETE' then
    select r.kind into target_kind from public.round r where r.id = new.round_id;
    if (new.runoff_pair is null) <> (target_kind is distinct from 'runoff') then
      perform public.refuse('a runoff box names its pair, and no other box does');
    end if;
    if new.runoff_pair is not null and (
      select count(*) from public.candidate c where c.contest_id = new.contest_id and c.id = any (new.runoff_pair)
    ) <> 2 then
      perform public.refuse('a runoff pair names two candidates of its contest');
    end if;
  end if;
  if current_user <> session_user then
    return coalesce(new, old);
  end if;
  if not exists (
    select 1 from public.round r
      join public.round_state rs on rs.state = r.state
      join public.election e on e.id = r.election_id
      join public.election_state s on s.state = e.state
     where r.id = target and not rs.opened and not rs.accepts_ballots and s.candidates_editable
       for share of e
  ) then
    perform public.refuse('ballot boxes change only while their round is planned');
  end if;
  return coalesce(new, old);
end
$$;

-- A ballot of a runoff box names one of the pair, or is invalid, and never "Nein".
create or replace function ballot_staged() returns trigger
  language plpgsql set search_path = pg_catalog as $$
declare
  accepting boolean;
  box_contest uuid;
  pair uuid[];
  ranked boolean;
begin
  perform 1 from public.election e where e.id = new.election_id for share of e;
  select rs.accepts_ballots, rc.contest_id, rc.runoff_pair into accepting, box_contest, pair
    from public.round_contest rc
    join public.round r on r.id = rc.round_id
    join public.round_state rs on rs.state = r.state
   where rc.id = new.round_contest_id and rc.election_id = new.election_id;
  if accepting is not true then
    perform public.refuse('a ballot is cast only while its round is open');
  end if;
  -- An unknown kind is left to the foreign key.
  select k.ranked into ranked from public.ballot_kind k where k.kind = new.kind;
  if ranked is not null and ((ranked and cardinality(new.ranking) not between 1 and 6) or (not ranked and cardinality(new.ranking) <> 0)) then
    perform public.refuse('a ranked ballot names one to six candidates, any other none');
  end if;
  if (select count(*) from unnest(new.ranking) as r (id)) <> (select count(distinct r.id) from unnest(new.ranking) as r (id)) then
    perform public.refuse('a ranking names each candidate once');
  end if;
  if pair is not null then
    if new.kind = 'ranking' and cardinality(new.ranking) <> 1 then
      perform public.refuse('a runoff ballot names one of the pair');
    end if;
    if exists (select 1 from unnest(new.ranking) as r (id) where r.id <> all (pair)) then
      perform public.refuse('a runoff ballot names a candidate of the pair');
    end if;
    if new.kind = 'no' then
      perform public.refuse('"Nein" is offered where a contest has a single candidate');
    end if;
    return new;
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


-- A lot's outcome, recorded once: the lot as election-core names it, on
-- the first-round box of its contest.
create table lot_decision (
  id uuid primary key default gen_random_uuid(),
  election_id uuid not null,
  round_contest_id uuid not null,
  lot_id text not null check (lot_id <> ''),
  candidates uuid[] not null check (cardinality(candidates) >= 2),
  drawn uuid[] not null check (cardinality(drawn) = cardinality(candidates)),
  reason text not null check (length(reason) between 1 and 500),
  actor_tid uuid not null,
  actor_oid uuid not null,
  actor_name text not null,
  recorded_at timestamptz not null default now(),
  unique (round_contest_id, lot_id),
  foreign key (election_id, round_contest_id) references round_contest (election_id, id)
);

-- A lot is recorded on a first-round box, once the regular round has
-- closed and while no round accepts ballots, among candidates of the
-- box's contest, the order drawn being exactly the tied set; and never
-- changes. This binds everyone, the owner included.
create function lot_decision_recorded() returns trigger
  language plpgsql set search_path = pg_catalog as $$
declare
  box record;
begin
  select rc.contest_id, r.kind into box
    from public.round_contest rc join public.round r on r.id = rc.round_id
   where rc.id = new.round_contest_id and rc.election_id = new.election_id;
  if box.kind is distinct from 'regular' then
    perform public.refuse('a lot is recorded on a box of the regular round');
  end if;
  if exists (
    select 1 from public.round r join public.round_state rs on rs.state = r.state
     where r.election_id = new.election_id and rs.accepts_ballots
  ) then
    perform public.refuse('a lot is recorded while no round accepts ballots');
  end if;
  if not exists (
    select 1 from public.round r join public.round_state rs on rs.state = r.state
     where r.election_id = new.election_id and r.kind = 'regular' and rs.opened and not rs.accepts_ballots
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

create function lot_decision_kept() returns trigger
  language plpgsql set search_path = pg_catalog as $$
begin
  perform public.refuse('a recorded lot is written once and never changes');
  return null;
end
$$;

create trigger lot_decision_recorded before insert on lot_decision
  for each row execute function lot_decision_recorded();
create trigger lot_decision_kept before update or delete on lot_decision
  for each row execute function lot_decision_kept();

-- The pair each contest of the regular round needs for its runoff, as the
-- stored first-round result and the recorded lots have it: the result's
-- runoff candidates, or, where the runoff entry went to a lot, those who
-- qualified without it and the first drawn of the lot's decision, as many
-- as the lot seats. Null where the contest needs no runoff; `waiting`
-- where it waits for a lot not recorded yet; `missing` where the box has
-- no result.
create function runoff_pairs(target uuid)
  returns table (contest_id uuid, candidates uuid[], waiting boolean, missing boolean)
  language sql stable set search_path = pg_catalog as $$
  select rc.contest_id,
         case s.result ->> 'kind'
           when 'runoff-required' then array(select c::uuid from jsonb_array_elements_text(s.result -> 'runoffCandidates') as c)
           when 'lot-required' then (
             select array(select c::uuid from jsonb_array_elements_text(s.result -> 'lot' -> 'qualified') as c)
                    || d.drawn[1:(s.result -> 'lot' ->> 'seats')::int]
               from public.lot_decision d
              where d.round_contest_id = rc.id and d.lot_id = s.result -> 'lot' ->> 'id')
         end as candidates,
         s.result ->> 'kind' = 'lot-required'
           and not exists (select 1 from public.lot_decision d where d.round_contest_id = rc.id and d.lot_id = s.result -> 'lot' ->> 'id') as waiting,
         s.id is null as missing
    from public.round_contest rc
    join public.round r on r.id = rc.round_id
    left join public.result_snapshot s on s.round_contest_id = rc.id
   where r.election_id = target and r.kind = 'regular'
$$;

-- The runoff round: created open, with a ballot box per pair and the
-- entitlements of every issued runoff batch of the groups that vote in
-- the contest, once, after the regular round has closed. `pairs` is a
-- JSON array of { "contestId": uuid, "candidates": [uuid, uuid] }, which
-- must be exactly what runoff_pairs gives: the application computes it
-- the same way, and the database does not take its word for it.
create function activate_runoff(target uuid, pairs jsonb) returns uuid
  language plpgsql security definer set search_path = pg_catalog as $$
declare
  runoff constant text := 'runoff';
  active boolean;
  regular_closed boolean;
  new_round uuid;
  expected record;
  given uuid[];
  needed integer := 0;
  pair record;
  box uuid;
begin
  select not s.candidates_editable and not s.final into active
    from public.election e join public.election_state s on s.state = e.state
   where e.id = target
     for no key update of e;
  if active is null then
    perform public.refuse('no such election');
  end if;
  if not active then
    perform public.refuse('a runoff is activated on an active election');
  end if;
  select rs.opened and not rs.accepts_ballots into regular_closed
    from public.round r join public.round_state rs on rs.state = r.state
   where r.election_id = target and r.kind = 'regular';
  if regular_closed is not true then
    perform public.refuse('a runoff is activated once the regular round has closed');
  end if;
  if exists (select 1 from public.round r where r.election_id = target and r.kind = runoff) then
    perform public.refuse('the runoff was activated already');
  end if;
  if pairs is null or jsonb_typeof(pairs) <> 'array' or jsonb_array_length(pairs) = 0 then
    perform public.refuse('a runoff is of at least one contest');
  end if;
  -- The pairs given are the pairs the results and the lots give, contest for contest.
  for expected in select * from public.runoff_pairs(target) loop
    if expected.missing then
      perform public.refuse('a contest of the regular round has no result');
    end if;
    if expected.waiting then
      perform public.refuse('a runoff entry waits for a lot');
    end if;
    select array(select c::uuid from jsonb_array_elements_text(p -> 'candidates') as c) into given
      from jsonb_array_elements(pairs) as p
     where (p ->> 'contestId')::uuid = expected.contest_id;
    if expected.candidates is null then
      if given is not null then
        perform public.refuse('a runoff is of the contests that need one');
      end if;
    else
      if given is null or (select array_agg(x order by x) from unnest(given) as x) <> (select array_agg(x order by x) from unnest(expected.candidates) as x) then
        perform public.refuse('a runoff pair is the one the first round and the lots give');
      end if;
      needed := needed + 1;
    end if;
  end loop;
  if needed = 0 then
    perform public.refuse('no contest needs a runoff');
  end if;
  insert into public.round (election_id, kind, state) values (target, runoff, 'open') returning id into new_round;
  for pair in
    select (p ->> 'contestId')::uuid as contest_id,
           array(select c::uuid from jsonb_array_elements_text(p -> 'candidates') as c) as candidates
      from jsonb_array_elements(pairs) as p
  loop
    if not exists (
      select 1 from public.round_contest rc join public.round r on r.id = rc.round_id
       where r.election_id = target and r.kind = 'regular' and rc.contest_id = pair.contest_id
    ) then
      perform public.refuse('a runoff is of a contest of the regular round');
    end if;
    insert into public.round_contest (election_id, round_id, contest_id, runoff_pair)
    values (target, new_round, pair.contest_id, pair.candidates)
    returning id into box;
    insert into public.credential_entitlement (election_id, credential_id, round_contest_id)
    select c.election_id, c.id, box
      from public.credential c
      join public.credential_batch b on b.id = c.batch_id and b.state = 'issued' and b.round_kind = runoff
      join public.voter_group_contest m on m.election_id = b.election_id and m.voter_group_id = b.voter_group_id and m.contest_id = pair.contest_id
     where c.election_id = target;
  end loop;
  return new_round;
end
$$;
