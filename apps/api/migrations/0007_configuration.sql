-- What an election consists of: its contests with their candidates, the
-- voter groups (classes, departments) with the contests each one votes in,
-- and its rounds. Random (version 4) ids and no timestamps, as everywhere:
-- the audit log records who changed what, and when.
--
-- Every table carries its election_id, and the links between them are
-- composite foreign keys on (election_id, id), so a candidate, a mapping or
-- a ballot box can only ever join things of one election.
--
-- The editing windows of the lifecycle (packages/election-core) are kept by
-- triggers as well as by the API: contests, voter groups and their mapping
-- change only in a draft; candidates, title and description until voting
-- starts; nothing once the election is final. The states are rows that say
-- what each state allows, and the triggers read those flags instead of
-- naming states. A trigger reads the election's state with a share lock on
-- its row, so a change of state waits for a configuration change to commit,
-- and the other way round. What the runtime role may do with each table is
-- declared in apps/api/lib/runtime-privileges.ts.

-- Every trigger of the migrations refuses a change through this one
-- function, with SQLSTATE 55000 (object_not_in_prerequisite_state).
create function refuse(reason text) returns void
  language plpgsql set search_path = pg_catalog as $$
begin
  raise exception '%', reason using errcode = 'object_not_in_prerequisite_state';
end
$$;

-- The states of the lifecycle (packages/election-core/src/lifecycle.ts),
-- each with what it allows; a test keeps the rows equal to the lifecycle's
-- states, guards and transitions.
--
-- An election's state: structure_editable as canEditStructure (contests,
-- voter groups and their mapping), candidates_editable as
-- canEditCandidates (candidates, title and description, and with them the
-- regular round and its ballot boxes: until voting starts), and final for
-- the state in which nothing changes any more. An election advances to the
-- next state of draft → prepared → active → final, and returns from
-- prepared to draft.
create table election_state (
  state text primary key,
  structure_editable boolean not null,
  candidates_editable boolean not null,
  final boolean not null,
  advances_to text references election_state (state),
  returns_to text references election_state (state)
);
insert into election_state (state, structure_editable, candidates_editable, final, advances_to, returns_to) values
  ('draft', true, true, false, 'prepared', null),
  ('prepared', false, true, false, 'active', 'draft'),
  ('active', false, false, false, 'final', null),
  ('final', false, false, true, null, null);

alter table election
  drop constraint election_state_check,
  add foreign key (state) references election_state (state);

-- A round's kind: created_planned for the regular round, which preparing
-- the election creates, planned; a runoff round is created when it is
-- activated, which opens it.
create table round_kind (
  kind text primary key,
  created_planned boolean not null
);
insert into round_kind (kind, created_planned) values ('regular', true), ('runoff', false);

-- A round's state: opened once voting in it has started (canIssueBatch
-- refuses), accepts_ballots while it is open (canCastBallot).
create table round_state (
  state text primary key,
  opened boolean not null,
  accepts_ballots boolean not null
);
insert into round_state (state, opened, accepts_ballots) values
  ('planned', false, false),
  ('open', true, true),
  ('closed', true, false);

-- A contest elects one office, or is one question of a poll, under a fixed
-- ruleset: the list mirrors RULESET_IDS in packages/election-core, and a
-- test keeps the two equal. The API refuses a second contest whose title
-- compares equal to another one's, ignoring case (apps/api/lib/names.ts);
-- the database refuses identical ones.
create table contest (
  id uuid primary key default gen_random_uuid(),
  election_id uuid not null references election (id),
  title text not null check (char_length(title) between 1 and 200),
  ruleset_id text not null check (ruleset_id in ('at-school-speaker-v1', 'at-representative-v1', 'single-choice-v1')),
  unique (election_id, title),
  unique (election_id, id)
);

-- A candidate of one contest, or an option of a poll (a surname without a
-- given name). The API lists candidates alphabetically by surname, then
-- given name, and refuses two whose names compare equal, ignoring case, so
-- the order never needs a tiebreak; the database refuses identical ones.
--
-- The picture is stored here, so it is deleted with the candidate and the
-- election: a WebP of at most 128 KiB, as the API re-encoded the upload
-- (apps/api/lib/pictures.ts), with the SHA-256 of its bytes, which names
-- it in its URL.
create table candidate (
  id uuid primary key default gen_random_uuid(),
  election_id uuid not null,
  contest_id uuid not null,
  surname text not null check (char_length(surname) between 1 and 100),
  given_name text not null check (char_length(given_name) <= 100),
  picture bytea check (
    octet_length(picture) between 12 and 131072
    and substring(picture from 1 for 4) = '\x52494646'::bytea -- RIFF
    and substring(picture from 9 for 4) = '\x57454250'::bytea -- WEBP
  ),
  picture_sha256 text check (picture_sha256 = encode(sha256(picture), 'hex')),
  check ((picture is null) = (picture_sha256 is null)),
  unique (contest_id, surname, given_name),
  foreign key (election_id, contest_id) references contest (election_id, id) on delete cascade
);
create index candidate_election on candidate (election_id, contest_id);

-- A voter group gets its own batches of keys, which entitle its voters to
-- the contests it is mapped to: a class, say, to the Schulsprecherwahl,
-- its department's and its own Klassensprecherwahl. Names are unique
-- within an election, as contest titles are.
create table voter_group (
  id uuid primary key default gen_random_uuid(),
  election_id uuid not null references election (id),
  name text not null check (char_length(name) between 1 and 100),
  unique (election_id, name),
  unique (election_id, id)
);

create table voter_group_contest (
  election_id uuid not null,
  voter_group_id uuid not null,
  contest_id uuid not null,
  primary key (voter_group_id, contest_id),
  foreign key (election_id, voter_group_id) references voter_group (election_id, id) on delete cascade,
  foreign key (election_id, contest_id) references contest (election_id, id) on delete cascade
);
create index voter_group_contest_contest on voter_group_contest (election_id, contest_id);

-- Rounds: an election has at most one round of each kind. Preparing an
-- election creates its regular round, planned, with one round_contest (the
-- ballot box of a contest in that round) per contest; preparing it again
-- after a return to draft adds those of contests created meanwhile, and a
-- contest removed in the draft takes its own with it.
create table round (
  id uuid primary key default gen_random_uuid(),
  election_id uuid not null references election (id),
  kind text not null references round_kind (kind),
  state text not null default 'planned' references round_state (state),
  unique (election_id, kind),
  unique (election_id, id)
);

create table round_contest (
  id uuid primary key default gen_random_uuid(),
  election_id uuid not null,
  round_id uuid not null,
  contest_id uuid not null,
  unique (round_id, contest_id),
  foreign key (election_id, round_id) references round (election_id, id),
  foreign key (election_id, contest_id) references contest (election_id, id) on delete cascade
);
create index round_contest_contest on round_contest (election_id, contest_id);

-- A prepared election, its structure fixed and voting not yet started, has
-- its regular round from now on. Before this migration nothing prepared an
-- election, so this only completes what a test or a hand-made row left.
insert into round (election_id, kind)
select e.id, k.kind
  from election e
  join election_state s on s.state = e.state
  join round_kind k on k.created_planned
 where not s.structure_editable and s.candidates_editable;

-- The editing windows of the configuration tables: contests, voter groups
-- and their mapping change while their election's structure is editable,
-- candidates while its candidates are. Each reads the state of the
-- election, or of both elections of a row that would move, with a share
-- lock on its row.
create function structure_window() returns trigger
  language plpgsql set search_path = pg_catalog as $$
declare
  editable boolean;
begin
  for editable in
    select s.structure_editable
      from public.election e join public.election_state s on s.state = e.state
     where e.id = old.election_id or e.id = new.election_id
     order by e.id
       for share of e
  loop
    if not editable then
      perform public.refuse(format('%s rows change only while their election is draft', tg_table_name));
    end if;
  end loop;
  return coalesce(new, old);
end
$$;

create function candidate_window() returns trigger
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
  return coalesce(new, old);
end
$$;

create trigger contest_window before insert or update or delete on contest
  for each row execute function structure_window();
create trigger voter_group_window before insert or update or delete on voter_group
  for each row execute function structure_window();
create trigger voter_group_contest_window before insert or update or delete on voter_group_contest
  for each row execute function structure_window();
-- Prepared means that no round has opened yet.
create trigger candidate_window before insert or update or delete on candidate
  for each row execute function candidate_window();

-- Once the structure is fixed, every contest keeps at least one candidate:
-- a contest without any has no ballot. In a draft, preparing checks it.
create function candidate_keep_one() returns trigger
  language plpgsql set search_path = pg_catalog as $$
begin
  if exists (
    select 1 from public.election e join public.election_state s on s.state = e.state
     where e.id = old.election_id and not s.structure_editable
  ) and not exists (select 1 from public.candidate c where c.contest_id = old.contest_id) then
    perform public.refuse('a contest keeps at least one candidate once its election is prepared');
  end if;
  return null;
end
$$;

create trigger candidate_keep_one after delete on candidate
  for each row execute function candidate_keep_one();

-- An election moves only along the lifecycle, to the state its state
-- advances to or returns to, and back to draft only while no round has
-- opened. Title and description change until voting starts, and a final
-- election not at all.
create function election_lifecycle() returns trigger
  language plpgsql set search_path = pg_catalog as $$
declare
  was public.election_state;
begin
  select * into was from public.election_state s where s.state = old.state;
  if was.final then
    perform public.refuse('a final election never changes');
  end if;
  if (new.title, new.description) is distinct from (old.title, old.description) and not was.candidates_editable then
    perform public.refuse('title and description change only until voting starts');
  end if;
  if new.state is distinct from old.state then
    if new.state is distinct from was.advances_to and new.state is distinct from was.returns_to then
      perform public.refuse(format('an election does not go from %s to %s', old.state, new.state));
    end if;
    if new.state = was.returns_to and exists (
      select 1 from public.round r join public.round_state rs on rs.state = r.state
       where r.election_id = new.id and rs.opened
    ) then
      perform public.refuse('an election goes back to draft only before any round has opened');
    end if;
  end if;
  return new;
end
$$;

create trigger election_lifecycle before update on election
  for each row execute function election_lifecycle();

-- The regular round is created planned, while its election's candidates
-- can still change. Its ballot boxes are added and removed only while it
-- has not opened and its election is not yet active.
create function round_created_planned() returns trigger
  language plpgsql set search_path = pg_catalog as $$
begin
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

create trigger round_created_planned before insert on round
  for each row execute function round_created_planned();

create function round_contest_window() returns trigger
  language plpgsql set search_path = pg_catalog as $$
declare
  target uuid := coalesce(new.round_id, old.round_id);
begin
  if not exists (
    select 1 from public.round r
      join public.round_state rs on rs.state = r.state
      join public.election e on e.id = r.election_id
      join public.election_state s on s.state = e.state
     where r.id = target and not rs.opened and s.candidates_editable
       for share of e
  ) then
    perform public.refuse('ballot boxes change only while their round is planned');
  end if;
  return coalesce(new, old);
end
$$;

create trigger round_contest_window before insert or update or delete on round_contest
  for each row execute function round_contest_window();
