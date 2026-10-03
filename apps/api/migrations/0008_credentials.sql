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
-- activated. Random (version 4) ids and no timestamps, as everywhere.
--
-- The rules below bind every statement a session runs directly, the
-- runtime role's above all. A foreign key's cascade, and a function the
-- migrations define as SECURITY DEFINER, run as the table owner and are
-- not bound: a cascade only follows a change its own table's rules already
-- allowed, and such a function, which the runtime role may call only if
-- apps/api/lib/runtime-privileges.ts lists it, keeps rules of its own.

-- Entitlements name their ballot box together with its election.
alter table round_contest add unique (election_id, id);

-- A batch is issued, and voided once when it is replaced. A void batch
-- keeps its keys and their entitlements, so its sheets can still be
-- compared, but its keys are not usable: they never vote, and no key is
-- added to it. BATCH_STATES in apps/api/lib/credentials.ts lists the
-- states, and a test keeps the two equal.
create table credential_batch_state (
  state text primary key,
  usable boolean not null
);
insert into credential_batch_state (state, usable) values ('issued', true), ('void', false);

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
-- Like the configuration triggers, they read the election's row with a
-- share lock, so a change of the election's state waits for them to
-- commit, and the other way round.
--
-- Keys belong to a fixed structure: an election takes them once it is
-- prepared, its structure no longer editable, until it is final. Batches
-- are issued then, and a batch is voided, once, until its round opens: a
-- regular batch before voting starts, a runoff batch until the runoff is
-- activated, also while the regular round is open or closed. Nothing else
-- about a batch changes.
create function credential_batch_prepared() returns trigger
  language plpgsql set search_path = pg_catalog as $$
declare
  editable boolean;
begin
  if current_user <> session_user then
    return new;
  end if;
  select s.structure_editable into editable
    from public.election e join public.election_state s on s.state = e.state
   where e.id = new.election_id
     for share of e;
  if editable then
    perform public.refuse('keys are issued once the election is prepared');
  end if;
  return new;
end
$$;

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

create function credential_batch_window() returns trigger
  language plpgsql set search_path = pg_catalog as $$
declare
  election_final boolean;
  round_opened boolean;
begin
  if current_user <> session_user then
    return new;
  end if;
  select s.final into election_final
    from public.election e join public.election_state s on s.state = e.state
   where e.id = new.election_id
     for share of e;
  select rs.opened into round_opened
    from public.round r join public.round_state rs on rs.state = r.state
   where r.election_id = new.election_id and r.kind = new.round_kind;
  if election_final or coalesce(round_opened, false) then
    perform public.refuse('keys are issued and replaced only until their round opens');
  end if;
  return new;
end
$$;

create trigger credential_batch_prepared before insert on credential_batch
  for each row execute function credential_batch_prepared();
create trigger credential_batch_void_once before update on credential_batch
  for each row execute function credential_batch_void_once();
create trigger credential_batch_window before insert or update on credential_batch
  for each row execute function credential_batch_window();

-- A key is added to a usable batch while its election takes keys and its
-- round has not opened, and never changes.
create function credential_added() returns trigger
  language plpgsql set search_path = pg_catalog as $$
begin
  if current_user <> session_user then
    return new;
  end if;
  if not exists (
    select 1 from public.credential_batch b
      join public.credential_batch_state bs on bs.state = b.state
      join public.election e on e.id = b.election_id
      join public.election_state s on s.state = e.state
      left join public.round r on r.election_id = b.election_id and r.kind = b.round_kind
      left join public.round_state rs on rs.state = r.state
     where b.id = new.batch_id and bs.usable and not s.structure_editable and not s.final and not coalesce(rs.opened, false)
       for share of b, e
  ) then
    perform public.refuse('keys are added only to an issued batch, until its round opens');
  end if;
  return new;
end
$$;

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

create trigger credential_added before insert on credential
  for each row execute function credential_added();
create trigger credential_unchanged before update on credential
  for each row execute function credential_unchanged();

-- The freeze: entitlements are added and removed only while their round is
-- planned, and added only unused, for keys of a usable batch for that
-- round. Once the round is open the only change is a vote using one up,
-- consumed from false to true, by a key of a usable batch; nothing ever
-- turns it back, and nothing changes once the round has closed.
create function credential_entitlement_planned() returns trigger
  language plpgsql set search_path = pg_catalog as $$
declare
  round_opened boolean;
begin
  if current_user <> session_user then
    return coalesce(new, old);
  end if;
  select rs.opened into round_opened
    from public.round_contest rc
    join public.round r on r.id = rc.round_id
    join public.round_state rs on rs.state = r.state
    join public.election e on e.id = r.election_id
   where rc.id = coalesce(new.round_contest_id, old.round_contest_id)
     for share of e;
  if round_opened is not false then
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
