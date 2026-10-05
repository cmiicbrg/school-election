-- The schema of version 1, in one migration. What the tables hold, what the
-- triggers keep whoever writes, and the functions that do the elevated
-- steps; docs/design.md has the reasoning, docs/privacy-model.md what
-- PostgreSQL itself records about a vote and what removes it.
--
-- Random (version 4) ids and no timestamps, as everywhere: the audit log
-- records who changed what, and when. Every table of an election carries
-- its election_id, and the links between them are composite foreign keys
-- on (election_id, id), so a candidate, a mapping or a ballot box can only
-- ever join things of one election.
--
-- The lifecycle's windows (what may change in which state, which state
-- follows which) are the application's: election-core's guards, asked by
-- the route and again by changeElection under the election's lock. The
-- triggers keep what the stored data must satisfy whoever writes it: the
-- vote-once rules of the entitlements, the write-only ballot box and the
-- seal, a round's transitions, the immutability of snapshots, lots,
-- declared outcomes and a final election, and the shape of a runoff box
-- and a lot. The states are rows with flags, which the triggers and the
-- definer functions read instead of naming states; a test keeps the rows
-- equal to the lifecycle's states, guards and transitions.
--
-- A trigger's rule binds every statement a session runs directly, the
-- owner's included, where it says so. A foreign key's cascade, and a
-- function defined as SECURITY DEFINER, run as the table owner and are
-- not bound where the trigger returns at once for current_user <>
-- session_user: a cascade only follows a change its own table's rules
-- already allowed, and such a function, which the runtime role may call
-- only if apps/api/lib/runtime-privileges.ts lists it, keeps rules of its
-- own. Nothing here grants anything: the migrator applies that list, and
-- the runtime role's attributes, on every run.

-- Every trigger refuses a change through this one function, with SQLSTATE
-- 55000 (object_not_in_prerequisite_state).
create function refuse(reason text) returns void
  language plpgsql set search_path = pg_catalog as $$
begin
  raise exception '%', reason using errcode = 'object_not_in_prerequisite_state';
end
$$;

-- The states of the lifecycle (packages/election-core/src/lifecycle.ts),
-- each with its flags.
--
-- An election's state: structure_editable as canEditStructure (contests,
-- voter groups and their mapping), candidates_editable as
-- canEditCandidates (candidates, title and description: until voting
-- starts), and final for the state in which nothing changes any more. An
-- election advances to the next state of draft → prepared → active →
-- final, and returns from prepared to draft. The definer functions read
-- the flags: active is neither candidates_editable nor final, and
-- finalize_election moves to the state its state advances to.
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

-- A round's kind: created_planned for the regular round, which preparing
-- the election creates, planned; a runoff round is created when it is
-- activated, which opens it.
create table round_kind (
  kind text primary key,
  created_planned boolean not null
);
insert into round_kind (kind, created_planned) values ('regular', true), ('runoff', false);

-- A round's state: opened once voting in it has started (canIssueBatch
-- refuses), accepts_ballots while it is open (canCastBallot). A round in
-- test mode accepts ballots without having opened: the election stays
-- prepared, and keys and ballots behave as they do during the election.
create table round_state (
  state text primary key,
  opened boolean not null,
  accepts_ballots boolean not null
);
insert into round_state (state, opened, accepts_ballots) values
  ('planned', false, false),
  ('open', true, true),
  ('closed', true, false),
  ('testing', false, true);

-- A round's state changes only along these rows: planned → open → closed,
-- and planned ⇄ testing. The application opens a round itself (a direct
-- update along the first row) and starts a test the same way; the seal
-- closes a round, and end_test takes it back to planned. Like the state
-- tables, this is data the triggers read, so a later state is a row here,
-- not a trigger change.
create table round_transition (
  from_state text not null references round_state (state),
  to_state text not null references round_state (state),
  primary key (from_state, to_state)
);
insert into round_transition (from_state, to_state) values
  ('planned', 'open'),
  ('open', 'closed'),
  ('planned', 'testing'),
  ('testing', 'planned');

-- A batch of keys is issued, and voided once when it is replaced. A void
-- batch keeps its keys and their entitlements, so its sheets can still be
-- compared, but its keys are not usable: they never vote. BATCH_STATES in
-- apps/api/lib/credentials.ts lists the states, and a test keeps the two
-- equal.
create table credential_batch_state (
  state text primary key,
  usable boolean not null
);
insert into credential_batch_state (state, usable) values ('issued', true), ('void', false);

-- A ballot's kind is a row here, mirroring BallotKind in
-- packages/election-core (a test keeps the two equal): a complete ranking,
-- "Nein" where a contest has a single candidate, or an invalid vote, which
-- keeps no content. ranked says whether a ballot of that kind carries a
-- ranking; the staging trigger reads it, as the other triggers read the
-- state tables.
create table ballot_kind (
  kind text primary key,
  ranked boolean not null
);
insert into ballot_kind (kind, ranked) values ('ranking', true), ('no', false), ('invalid', false);

-- Teachers and student witnesses who have signed in with Entra ID. Voters
-- never appear here: they have no account, only an anonymous key.
--
-- A person is the pair (tid, oid), the directory and the object id within
-- it, which Entra never reuses. Not the e-mail address: it can be renamed or
-- handed to someone else. The email is the token's email claim, or its
-- preferred_username without one (the school address of a school account),
-- and null without either. It is kept only to match an invitation sent to
-- a school address to the person who signs in with it.
--
-- Random (version 4) ids: a time-ordered id would record when each person
-- first signed in. Sign-in inserts a person or refreshes their name and
-- email; the identity itself cannot be rewritten, and nobody is deleted by
-- the server.
create table app_user (
  id uuid primary key default gen_random_uuid(),
  tid uuid not null,
  oid uuid not null,
  display_name text not null,
  email text,
  constraint app_user_identity unique (tid, oid)
);

-- Elections and the people who may work on them. An election is visible
-- only to its members: its owner (the teacher who created it), co-admins
-- (role admin) and witnesses. No global role grants access to an election.
create table election (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 200),
  description text not null default '' check (char_length(description) <= 2000),
  state text not null default 'draft' references election_state (state)
);

-- Co-admins and witnesses are invited by their school e-mail address:
-- invited_email holds it as it was entered, and user_id stays null until
-- that person signs in with a matching address. A pending invitation
-- grants nothing. Binding sets user_id once and keeps the address, which
-- the audit log names when the member is removed. The owner is the one
-- member who was not invited, and is always a person.
create table election_member (
  id uuid primary key default gen_random_uuid(),
  election_id uuid not null references election (id),
  role text not null check (role in ('owner', 'admin', 'witness')),
  user_id uuid references app_user (id),
  invited_email text check (char_length(invited_email) between 3 and 254),
  check ((role = 'owner') = (invited_email is null)),
  check (user_id is not null or invited_email is not null),
  -- One membership per person and election; pending invitations have no person yet.
  unique (election_id, user_id)
);

-- One owner per election, and one invitation per address and election,
-- whatever its case.
create unique index election_member_owner on election_member (election_id) where invited_email is null;
create unique index election_member_invitation on election_member (election_id, lower(invited_email));
-- A person's elections, and the pending invitations a sign-in binds.
create index election_member_user on election_member (user_id);
create index election_member_pending on election_member (lower(invited_email)) where user_id is null;

-- An invitation binds once: user_id goes from null to a person and never
-- changes again.
create function election_member_bind_once() returns trigger
  language plpgsql set search_path = pg_catalog as $$
begin
  if old.user_id is not null or new.user_id is null then
    raise exception 'an invitation is bound once' using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end
$$;

create trigger election_member_bind_once before update of user_id on election_member
  for each row execute function election_member_bind_once();

-- The administrative audit log: one append-only, hash-chained list of events
-- per election, written by apps/api/lib/audit.ts in the transaction of the
-- change each event records. It holds administrators' actions only, never
-- voter activity, so nothing in it can link a ballot to a key, a session or
-- another ballot.
--
-- The runtime role may add and read events, never change or remove them.
-- The database keeps each chain linear: an election has one first event (no
-- predecessor), every other event names an earlier event of the same
-- election as its predecessor, by its seq and hash, and no event is the
-- predecessor of two. Each link points to a smaller seq, so following the
-- links always ends at the first event: no event can name itself or a later
-- one, and the links cannot form a cycle, even within one statement.
-- Whether the hashes are right is checked by recomputing them
-- (verifyAuditChain), by the server and by the offline verifier. Every
-- event belongs to an election that exists, and goes with it.
create table audit_event (
  seq bigint generated always as identity primary key,
  election_id uuid not null,
  -- A finite time in whole milliseconds, which the hashed ISO 8601 text and
  -- a JavaScript Date hold exactly.
  at timestamptz not null check (isfinite(at) and at = date_trunc('milliseconds', at)),
  -- The stable Entra identity of the actor, and the name shown for it.
  actor_tid uuid not null,
  actor_oid uuid not null,
  actor_name text not null check (char_length(actor_name) between 1 and 256),
  action text not null check (action ~ '^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$' and char_length(action) <= 64),
  metadata jsonb not null check (jsonb_typeof(metadata) = 'object'),
  prev_seq bigint,
  prev_hash text check (prev_hash ~ '^[0-9a-f]{64}$'),
  hash text not null check (hash ~ '^[0-9a-f]{64}$'),
  check ((prev_seq is null) = (prev_hash is null)),
  check (prev_seq < seq),
  unique (election_id, hash),
  unique (election_id, seq, hash),
  unique nulls not distinct (election_id, prev_hash),
  foreign key (election_id, prev_seq, prev_hash) references audit_event (election_id, seq, hash),
  constraint audit_event_election foreign key (election_id) references election (id)
);

-- The chain head (the newest event) and a chain in order.
create index audit_event_election_seq on audit_event (election_id, seq);

-- The startup check refuses any preloaded module but pg_stat_statements,
-- since modules such as auto_explain or pgaudit can log statements with
-- their parameters. Two of the three preload settings are visible only to
-- superusers and members of pg_read_all_settings, which may read every
-- setting there is. This function shows exactly the three preload settings
-- and nothing else, so the runtime role needs no such membership.
--
-- SECURITY DEFINER runs it as its owner, the superuser that runs the
-- migrations: it takes no arguments, pins its search_path and runs one
-- fixed query. Only the runtime role may execute it, as
-- apps/api/lib/runtime-privileges.ts grants.
create function preload_settings() returns table (name text, setting text)
  language sql stable security definer
  set search_path = pg_catalog
begin atomic
  select s.name, s.setting from pg_catalog.pg_settings s
   where s.name in ('shared_preload_libraries', 'session_preload_libraries', 'local_preload_libraries');
end;

-- What an election consists of: its contests with their candidates, the
-- voter groups (classes, departments) with the contests each one votes in,
-- and its rounds.

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
-- contest removed in the draft takes its own with it. A runoff round is
-- activate_runoff's alone.
--
-- A round's phase is a fresh random id each time its state changes. A
-- voter's session is redeemed in one phase of a round, open or in test
-- mode, and must hold exactly while that phase lasts (lib/voter.ts,
-- routes/voter.ts). The state alone cannot tell one test of a round from
-- the next: a session from an ended test would hold in the test after
-- it, within its lifetime, with the key's entitlements unused again. So
-- the session carries the phase's id and holds while it is the round's.
-- The id is the database's: the trigger round_phase sets it with the
-- state, and nothing else changes it. A round is the election's, not a
-- voter's, so it is not a privacy table.
create table round (
  id uuid primary key default gen_random_uuid(),
  election_id uuid not null references election (id),
  kind text not null references round_kind (kind),
  state text not null default 'planned' references round_state (state),
  phase uuid not null default gen_random_uuid(),
  unique (election_id, kind),
  unique (election_id, id)
);

-- A ballot box: one contest in one round. A runoff round's box names its
-- pair, the two candidates the first round's result and the recorded lots
-- gave, in a column of its own, so turnout, the seal, the snapshot and the
-- privacy tables need no second shape, and the staging trigger lets a
-- runoff ballot name the pair alone. Entitlements name a box together
-- with its election.
create table round_contest (
  id uuid primary key default gen_random_uuid(),
  election_id uuid not null,
  round_id uuid not null,
  contest_id uuid not null,
  runoff_pair uuid[] check (runoff_pair is null or (
    cardinality(runoff_pair) = 2 and runoff_pair[1] is not null and runoff_pair[2] is not null and runoff_pair[1] <> runoff_pair[2]
  )),
  unique (round_id, contest_id),
  unique (election_id, id),
  foreign key (election_id, round_id) references round (election_id, id),
  foreign key (election_id, contest_id) references contest (election_id, id) on delete cascade
);
create index round_contest_contest on round_contest (election_id, contest_id);

-- Voting keys. A batch is a set of keys issued at once for one voter group
-- and one round: the regular round, or a possible runoff, whose keys can be
-- printed in advance. A group may have several batches per round (a top-up
-- adds one), and a batch is replaced by voiding it and issuing another.
--
-- Keys are stored as the server generated them (apps/api/lib/credentials.ts),
-- normalised, so a batch's sheets can be printed again and compared with
-- the database at any time; a voter's key is looked up by that value. An
-- entitlement lets one key cast one ballot in one ballot box of its round:
-- a regular batch's keys get those of the contests their group votes in
-- when the batch is issued, a runoff batch's none until the runoff is
-- activated. When batches are issued and voided is the lifecycle's.

-- round_kind: the round of that kind of the batch's election, which for a
-- runoff does not exist until the runoff is activated. Removing a voter
-- group, which happens only in a draft, removes its batches.
create table credential_batch (
  id uuid primary key default gen_random_uuid(),
  election_id uuid not null,
  voter_group_id uuid not null,
  round_kind text not null references round_kind (kind),
  state text not null default 'issued' references credential_batch_state (state),
  unique (election_id, id),
  foreign key (election_id, voter_group_id) references voter_group (election_id, id) on delete cascade
);
create index credential_batch_group on credential_batch (election_id, voter_group_id);

-- The key in its normalised form: 20 symbols of Crockford Base32, the last
-- one the check symbol (packages/election-core/src/credential-key.ts).
create table credential (
  id uuid primary key default gen_random_uuid(),
  election_id uuid not null,
  batch_id uuid not null,
  key text not null check (key ~ '^[0-9A-HJKMNP-TV-Z]{20}$'),
  unique (election_id, id),
  foreign key (election_id, batch_id) references credential_batch (election_id, id) on delete cascade
);
create unique index credential_key on credential (key);
create index credential_batch_id on credential (batch_id);

-- No id of its own: a key and a ballot box name an entitlement.
create table credential_entitlement (
  election_id uuid not null,
  credential_id uuid not null,
  round_contest_id uuid not null,
  consumed boolean not null default false,
  primary key (credential_id, round_contest_id),
  foreign key (election_id, credential_id) references credential (election_id, id) on delete cascade,
  foreign key (election_id, round_contest_id) references round_contest (election_id, id) on delete cascade
);
create index credential_entitlement_round_contest on credential_entitlement (round_contest_id);

-- Each trigger below states one rule for the operations it binds, and
-- returns at once for a change it does not bind: one made by a cascade or
-- by a SECURITY DEFINER function, where current_user is not session_user.
--
-- A batch is only ever voided, once, and nothing else about it changes.
create function credential_batch_void_once() returns trigger
  language plpgsql set search_path = pg_catalog as $$
begin
  if current_user <> session_user then
    return new;
  end if;
  if (new.id, new.election_id, new.voter_group_id, new.round_kind) is distinct from (old.id, old.election_id, old.voter_group_id, old.round_kind)
     or not exists (
       select 1 from public.credential_batch_state was, public.credential_batch_state becomes
        where was.state = old.state and was.usable and becomes.state = new.state and not becomes.usable
     ) then
    perform public.refuse('a batch is only ever voided, once');
  end if;
  return new;
end
$$;

create trigger credential_batch_void_once before update on credential_batch
  for each row execute function credential_batch_void_once();

-- A key never changes.
create function credential_unchanged() returns trigger
  language plpgsql set search_path = pg_catalog as $$
begin
  if current_user <> session_user then
    return new;
  end if;
  perform public.refuse('a key never changes');
  return new;
end
$$;

create trigger credential_unchanged before update on credential
  for each row execute function credential_unchanged();

-- The freeze: entitlements are added and removed only while their round is
-- planned (neither opened nor in test mode), and added only unused, for
-- keys of a usable batch for that round. Once the round accepts ballots
-- the only change is a vote using one up, consumed from false to true, by
-- a key of a usable batch; nothing ever turns it back, and nothing changes
-- once the round has closed. The seal and end_test, definer functions,
-- are not bound.
create function credential_entitlement_planned() returns trigger
  language plpgsql set search_path = pg_catalog as $$
declare
  round_frozen boolean;
begin
  if current_user <> session_user then
    return coalesce(new, old);
  end if;
  select rs.opened or rs.accepts_ballots into round_frozen
    from public.round_contest rc
    join public.round r on r.id = rc.round_id
    join public.round_state rs on rs.state = r.state
    join public.election e on e.id = r.election_id
   where rc.id = coalesce(new.round_contest_id, old.round_contest_id)
     for share of e;
  if round_frozen is not false then
    perform public.refuse('entitlements are added and removed only while their round is planned');
  end if;
  return coalesce(new, old);
end
$$;

create function credential_entitlement_unused() returns trigger
  language plpgsql set search_path = pg_catalog as $$
begin
  if current_user <> session_user then
    return new;
  end if;
  if new.consumed or not exists (
    select 1 from public.credential c
      join public.credential_batch b on b.id = c.batch_id
      join public.credential_batch_state bs on bs.state = b.state
      join public.round_contest rc on rc.id = new.round_contest_id
      join public.round r on r.id = rc.round_id
     where c.id = new.credential_id and bs.usable and b.round_kind = r.kind
  ) then
    perform public.refuse('an entitlement is added unused, for a key of an issued batch for its round');
  end if;
  return new;
end
$$;

create function credential_entitlement_used() returns trigger
  language plpgsql set search_path = pg_catalog as $$
declare
  round_accepts_ballots boolean;
begin
  if current_user <> session_user then
    return new;
  end if;
  if (new.election_id, new.credential_id, new.round_contest_id) is distinct from (old.election_id, old.credential_id, old.round_contest_id) then
    perform public.refuse('an entitlement never moves');
  end if;
  select rs.accepts_ballots into round_accepts_ballots
    from public.round_contest rc
    join public.round r on r.id = rc.round_id
    join public.round_state rs on rs.state = r.state
    join public.election e on e.id = r.election_id
   where rc.id = new.round_contest_id
     for share of e;
  if new.consumed is distinct from old.consumed and (old.consumed or round_accepts_ballots is not true) then
    perform public.refuse('an entitlement is used up only while its round is open, and never restored');
  end if;
  -- A void batch keeps its entitlements, so its sheets can still be
  -- compared, but its keys never vote.
  if new.consumed and not old.consumed and not exists (
    select 1 from public.credential c
      join public.credential_batch b on b.id = c.batch_id
      join public.credential_batch_state bs on bs.state = b.state
     where c.id = new.credential_id and bs.usable
  ) then
    perform public.refuse('a key of a void batch never votes');
  end if;
  return new;
end
$$;

create trigger credential_entitlement_planned before insert or delete on credential_entitlement
  for each row execute function credential_entitlement_planned();
create trigger credential_entitlement_unused before insert on credential_entitlement
  for each row execute function credential_entitlement_unused();
create trigger credential_entitlement_used before update on credential_entitlement
  for each row execute function credential_entitlement_used();

-- The ballot box: where ballots are staged while a round accepts them and
-- where they are kept once it is sealed, laid out so that nothing in the
-- database links a ballot to the key that cast it or to another ballot.
--
-- What could link them, and what is done about each:
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
--   transactions stay on disk until the clean-up at finalization
--   (cleanup_blockers and flush_wal below, with VACUUM FULL run by the
--   application); deploy/README.md keeps backups and snapshots away from
--   that window.
--
-- While a round accepts ballots the staging table is write-only for the
-- runtime role: it inserts ballots and cannot read, change or remove them,
-- so no code path can show a result or a single ballot before the round
-- is sealed; a test is the one exception, read through test_ballots while
-- it runs. Sealing is closing: seal_round(), the only way a round leaves
-- the open state, does both in one transaction. No sequence: the ballots
-- of a box are a set.
--
-- A ranking lists candidates from the highest slot down; no ruleset has
-- more than six slots. Which slots a contest has, and that a ranking fills
-- them, is the application's to check (election-core); the database keeps
-- the shape: one dimension and no null entry here, and in ballot_staged
-- below one to six entries for a ranked kind and none for the others,
-- each a candidate of the box's contest, named once. Sealed ballots come
-- from the staging table alone (ballot_kept), so the same holds for them.
create table ballot_box (
  election_id uuid not null,
  round_contest_id uuid not null,
  kind text not null references ballot_kind (kind),
  ranking uuid[] not null,
  check (coalesce(array_ndims(ranking), 1) = 1),
  check (array_position(ranking, null) is null),
  foreign key (election_id, round_contest_id) references round_contest (election_id, id) on delete cascade
);

create table ballot (
  id uuid primary key default gen_random_uuid(),
  election_id uuid not null,
  round_contest_id uuid not null,
  kind text not null references ballot_kind (kind),
  ranking uuid[] not null,
  check (coalesce(array_ndims(ranking), 1) = 1),
  check (array_position(ranking, null) is null),
  foreign key (election_id, round_contest_id) references round_contest (election_id, id) on delete cascade
);
-- Reading a box's ballots for the count. A B-tree over this column orders
-- equal keys by physical position, which after the seal follows from the
-- random ids alone.
create index ballot_round_contest on ballot (election_id, round_contest_id);

-- A ballot is staged only while its round accepts ballots. The trigger
-- takes the election's row with a share lock first: a seal in progress
-- holds that row until it commits, so this waits for it, and a seal that
-- comes later waits for the vote to commit. The round's state is read
-- afterwards, by a statement of its own, so it is the state a seal left
-- behind and not the one this transaction saw before waiting (in read
-- committed each statement takes a new snapshot; a lock taken in the same
-- statement would not refresh the round's row). A ballot names each
-- candidate once, candidates of its own contest only, and "Nein" only
-- where the contest has a single candidate; a ballot of a runoff box
-- names one of the pair, or is invalid, and never "Nein". This binds
-- everyone, the seal and the owner included.
create function ballot_staged() returns trigger
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

-- A staged ballot is moved by the seal and changed by nobody; a sealed
-- ballot is written by the seal, never changes, and leaves only with its
-- election. The seal, end_test and a foreign key's cascade run as the
-- table owner and are not bound; every direct statement is.
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

-- A final election never changes; an election becomes final only with the
-- final outcome of every contest written (finalize_election writes them in
-- the same step). Which state follows which is the lifecycle's.
create function election_lifecycle() returns trigger
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
-- the seal for an open round, the end of a test for one in test mode. So
-- a closed round is always a sealed one, and an ended test keeps nothing.
-- Whether its election is in the state for the step is the lifecycle's.
create function round_lifecycle() returns trigger
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

-- The phase changes with the state, and with nothing else.
create function round_phase() returns trigger
  language plpgsql set search_path = pg_catalog as $$
begin
  if new.state is distinct from old.state then
    new.phase := gen_random_uuid();
  elsif new.phase is distinct from old.phase then
    perform public.refuse('a round''s phase changes with its state alone');
  end if;
  return new;
end $$;

-- A runoff round's box names its pair, two candidates of its own contest,
-- and no other round's box names one, whoever adds it. When a box may be
-- added or removed is the lifecycle's.
create function round_contest_window() returns trigger
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

create trigger election_lifecycle before update on election
  for each row execute function election_lifecycle();
create trigger round_lifecycle before update on round
  for each row execute function round_lifecycle();
create trigger round_phase before update on round
  for each row execute function round_phase();
create trigger round_contest_window before insert or update or delete on round_contest
  for each row execute function round_contest_window();

-- The seal: closes an open round and makes its ballots unlinkable, in one
-- transaction. It runs as the owner of the tables (SECURITY DEFINER, with
-- the search path pinned), because the runtime role may neither read nor
-- remove staged ballots, nor remove entitlements, nor close a round, and
-- it refuses anything but an open round, so a second call refuses too.
-- Returns the number of ballots sealed.
--
-- It locks the round's entitlements first and then the election's row,
-- in the order a vote takes its locks: a vote locks the entitlement it
-- uses up before its trigger takes the election's row for share, and
-- holds both until it commits. So the seal waits for the votes in flight,
-- a vote that arrives while the seal holds the rows waits for it and then
-- finds its entitlement gone and the round closed, and neither ever waits
-- for the other while holding what the other needs. A second seal waits
-- the same way, and then reads the round, by a statement of its own with
-- a snapshot of its own, as closed.
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
  boxes := array(select rc.id from public.round_contest rc where rc.round_id = target);
  perform 1 from public.credential_entitlement e where e.round_contest_id = any (boxes) for update;
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
-- draft first, as unpreparing would; the rest follows the foreign keys,
-- in dependency order.
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

-- The result of one ballot box, computed from its sealed ballots when the
-- round closed, in the transaction that sealed it (lib/tally.ts): the
-- digest of what the count saw, the versions that computed it, the result
-- with its statistics and trace, and the outcome as it stood without lots.
-- Derived from the anonymous ballots and the configuration alone, never
-- per voter. Written once: a snapshot never changes, for any role, and the
-- runtime role may only add and read them (lib/runtime-privileges.ts). A
-- round is never closed without its snapshots.
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

-- A lot the officials drew is recorded once by an authorised person, with
-- the lot's id as election-core names it, the tied set, the order drawn,
-- the reason and the actor, and never changes: lib/outcome.ts applies the
-- recorded decisions through election-core's resolve, which refuses a
-- decision that is not exactly the lot's tied set, a second one for a lot,
-- or one for a lot that is not required. Not a privacy table: a lot names
-- candidates and officials, never a voter.
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

-- A lot is recorded on a box of the regular round, among candidates of
-- the box's contest, the order drawn being exactly the tied set, and never
-- on a final election. Whether the election is at the point for a lot is
-- the lifecycle's; which lots a result requires is election-core's. This
-- binds everyone, the owner included.
create function lot_decision_recorded() returns trigger
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
  -- The regular round is the kind created planned: flags, not names.
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

-- The runoff: a round of its own, voted on fresh keys, with one ballot box
-- per contest that needs one, for exactly the two candidates the first
-- round's result and the recorded lots name. It comes to be in one way
-- only, activate_runoff, a definer function the runtime role calls, which
-- creates it open, with its boxes and with an entitlement per key of every
-- issued runoff batch of the groups that vote in the contest: there is
-- nothing to prepare for a runoff, so it has no planned state.

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
    join public.round_kind k on k.kind = r.kind and k.created_planned
    left join public.result_snapshot s on s.round_contest_id = rc.id
   where r.election_id = target
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
    from public.round r
    join public.round_state rs on rs.state = r.state
    join public.round_kind k on k.kind = r.kind and k.created_planned
   where r.election_id = target;
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
      select 1 from public.round_contest rc
        join public.round r on r.id = rc.round_id
        join public.round_kind k on k.kind = r.kind and k.created_planned
       where r.election_id = target and rc.contest_id = pair.contest_id
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

create function final_outcome_kept() returns trigger
  language plpgsql set search_path = pg_catalog as $$
begin
  perform public.refuse('a final outcome is written once and never changes');
  return null;
end
$$;

create trigger final_outcome_kept before update or delete on final_outcome
  for each row execute function final_outcome_kept();

-- Finalization itself: the declared outcome of every contest written, and
-- the election moved to the state its state advances to, in one step, by
-- the application's definer function (lib/finalize.ts), so no declaration
-- exists apart from a final election. `outcomes` is a JSON array of
-- { "contestId": uuid, "outcome": election-core's outcome }, one per
-- contest of the election; the kind is the outcome's own. That the
-- regular round has closed and no round is open is the lifecycle's. Returns
-- how many outcomes were declared.
create function finalize_election(target uuid, outcomes jsonb, tally_version integer, app_version text, git_sha text) returns integer
  language plpgsql security definer set search_path = pg_catalog as $$
declare
  active boolean;
  given integer;
  distinct_contests integer;
  known integer;
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
  select count(*), count(distinct d."contestId"), count(c.id) into given, distinct_contests, known
    from jsonb_to_recordset(outcomes) as d ("contestId" uuid, outcome jsonb)
    left join public.contest c on c.id = d."contestId" and c.election_id = target;
  if given <> (select count(*) from public.contest c where c.election_id = target) or distinct_contests <> given or known <> given then
    perform public.refuse('a declaration names every contest of the election, once');
  end if;
  insert into public.final_outcome (election_id, contest_id, kind, outcome, tally_version, app_version, git_sha)
  select target, d."contestId", d.outcome ->> 'kind', d.outcome, tally_version, app_version, git_sha
    from jsonb_to_recordset(outcomes) as d ("contestId" uuid, outcome jsonb);
  get diagnostics declared = row_count;
  update public.election e set state = s.advances_to
    from public.election_state s
   where e.id = target and s.state = e.state;
  return declared;
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
