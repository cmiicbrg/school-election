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
-- starts; nothing once the election is final. A trigger reads the
-- election's state with a share lock on its row, so a change of state waits
-- for a configuration change to commit, and the other way round. What the
-- runtime role may do with each table is declared in
-- apps/api/lib/runtime-privileges.ts.

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

-- Rounds: kind and state mirror ROUND_KINDS and ROUND_STATES in
-- packages/election-core/src/lifecycle.ts, and a test keeps them equal. An
-- election has at most one round of each kind. Preparing an election
-- creates its regular round, planned, with one round_contest (the ballot
-- box of a contest in that round) per contest; preparing it again after a
-- return to draft adds those of contests created meanwhile, and a contest
-- removed in the draft takes its own with it.
create table round (
  id uuid primary key default gen_random_uuid(),
  election_id uuid not null references election (id),
  kind text not null check (kind in ('regular', 'runoff')),
  state text not null default 'planned' check (state in ('planned', 'open', 'closed')),
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

-- A prepared election has its regular round from now on. Before this
-- migration nothing prepared an election, so this only completes what a
-- test or a hand-made row left.
insert into round (election_id, kind) select id, 'regular' from election where state = 'prepared';

-- The editing window of a configuration table: a row of an election
-- changes only while the election is in one of the states the trigger
-- names as its arguments.
create function election_change_window() returns trigger
  language plpgsql set search_path = pg_catalog as $$
declare
  current text;
begin
  for current in
    select e.state from public.election e
     where e.id = old.election_id or e.id = new.election_id
     order by e.id
     for share
  loop
    if not current = any (tg_argv) then
      raise exception '% rows change only while their election is %', tg_table_name, array_to_string(tg_argv, ' or ')
        using errcode = 'object_not_in_prerequisite_state';
    end if;
  end loop;
  return coalesce(new, old);
end
$$;

create trigger contest_window before insert or update or delete on contest
  for each row execute function election_change_window('draft');
create trigger voter_group_window before insert or update or delete on voter_group
  for each row execute function election_change_window('draft');
create trigger voter_group_contest_window before insert or update or delete on voter_group_contest
  for each row execute function election_change_window('draft');
-- Prepared means that no round has opened yet.
create trigger candidate_window before insert or update or delete on candidate
  for each row execute function election_change_window('draft', 'prepared');

-- Once prepared, every contest keeps at least one candidate: a contest
-- without any has no ballot. In a draft, preparing checks it.
create function candidate_keep_one() returns trigger
  language plpgsql set search_path = pg_catalog as $$
begin
  if exists (select 1 from public.election e where e.id = old.election_id and e.state <> 'draft')
     and not exists (select 1 from public.candidate c where c.contest_id = old.contest_id) then
    raise exception 'a contest keeps at least one candidate once its election is prepared' using errcode = 'object_not_in_prerequisite_state';
  end if;
  return null;
end
$$;

create trigger candidate_keep_one after delete on candidate
  for each row execute function candidate_keep_one();

-- An election moves only along the lifecycle: draft ⇄ prepared → active →
-- final, and back to draft only while no round has opened. Title and
-- description change until voting starts, and a final election not at all.
create function election_lifecycle() returns trigger
  language plpgsql set search_path = pg_catalog as $$
begin
  if old.state = 'final' then
    raise exception 'a final election never changes' using errcode = 'object_not_in_prerequisite_state';
  end if;
  if (new.title, new.description) is distinct from (old.title, old.description) and old.state not in ('draft', 'prepared') then
    raise exception 'title and description change only until voting starts' using errcode = 'object_not_in_prerequisite_state';
  end if;
  if new.state is distinct from old.state then
    if (old.state, new.state) not in (('draft', 'prepared'), ('prepared', 'draft'), ('prepared', 'active'), ('active', 'final')) then
      raise exception 'an election does not go from % to %', old.state, new.state using errcode = 'object_not_in_prerequisite_state';
    end if;
    if new.state = 'draft' and exists (select 1 from public.round r where r.election_id = new.id and r.state <> 'planned') then
      raise exception 'an election goes back to draft only before any round has opened' using errcode = 'object_not_in_prerequisite_state';
    end if;
  end if;
  return new;
end
$$;

create trigger election_lifecycle before update on election
  for each row execute function election_lifecycle();

-- The regular round is created planned, while its election is a draft or
-- prepared. Its ballot boxes are added and removed only while it is
-- planned and its election is not yet active.
create function round_created_planned() returns trigger
  language plpgsql set search_path = pg_catalog as $$
begin
  if new.kind <> 'regular' or new.state <> 'planned'
     or not exists (select 1 from public.election e where e.id = new.election_id and e.state in ('draft', 'prepared') for share) then
    raise exception 'a regular round is created planned, before voting starts' using errcode = 'object_not_in_prerequisite_state';
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
    select 1 from public.round r join public.election e on e.id = r.election_id
     where r.id = target and r.state = 'planned' and e.state in ('draft', 'prepared')
       for share of e
  ) then
    raise exception 'ballot boxes change only while their round is planned' using errcode = 'object_not_in_prerequisite_state';
  end if;
  return coalesce(new, old);
end
$$;

create trigger round_contest_window before insert or update or delete on round_contest
  for each row execute function round_contest_window();
