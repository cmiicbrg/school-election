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

-- round_kind mirrors ROUND_KINDS in packages/election-core: the round of
-- that kind of the batch's election, which for a runoff does not exist
-- until the runoff is activated. Removing a voter group, which happens only
-- in a draft, removes its batches.
create table credential_batch (
  id uuid primary key default gen_random_uuid(),
  election_id uuid not null,
  voter_group_id uuid not null,
  round_kind text not null check (round_kind in ('regular', 'runoff')),
  state text not null default 'issued' check (state in ('issued', 'void')),
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

-- Batches are issued once the election is prepared, and a batch is voided,
-- once, until its round opens: a regular batch before voting starts, a
-- runoff batch until the runoff is activated, also while the regular round
-- is open or closed. Nothing else about a batch changes.
create function credential_batch_window() returns trigger
  language plpgsql set search_path = pg_catalog as $$
declare
  election_state text;
  round_state text;
begin
  if current_user <> session_user then
    return new;
  end if;
  if tg_op = 'UPDATE' and ((new.id, new.election_id, new.voter_group_id, new.round_kind) is distinct from (old.id, old.election_id, old.voter_group_id, old.round_kind)
     or old.state <> 'issued' or new.state <> 'void') then
    raise exception 'a batch is only ever voided, once' using errcode = 'object_not_in_prerequisite_state';
  end if;
  select e.state into election_state from public.election e where e.id = new.election_id for share;
  select r.state into round_state from public.round r where r.election_id = new.election_id and r.kind = new.round_kind;
  if election_state = 'final' or coalesce(round_state, 'planned') <> 'planned' then
    raise exception 'keys are issued and replaced only until their round opens' using errcode = 'object_not_in_prerequisite_state';
  end if;
  if tg_op = 'INSERT' and election_state = 'draft' then
    raise exception 'keys are issued once the election is prepared' using errcode = 'object_not_in_prerequisite_state';
  end if;
  return new;
end
$$;

create trigger credential_batch_window before insert or update on credential_batch
  for each row execute function credential_batch_window();

-- A key is added to an issued batch until the batch's round opens, and
-- never changes.
create function credential_window() returns trigger
  language plpgsql set search_path = pg_catalog as $$
begin
  if current_user <> session_user then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    raise exception 'a key never changes' using errcode = 'object_not_in_prerequisite_state';
  end if;
  if not exists (
    select 1 from public.credential_batch b
      join public.election e on e.id = b.election_id
      left join public.round r on r.election_id = b.election_id and r.kind = b.round_kind
     where b.id = new.batch_id and b.state = 'issued' and e.state in ('prepared', 'active') and coalesce(r.state, 'planned') = 'planned'
       for share of b, e
  ) then
    raise exception 'keys are added only to an issued batch, until its round opens' using errcode = 'object_not_in_prerequisite_state';
  end if;
  return new;
end
$$;

create trigger credential_window before insert or update on credential
  for each row execute function credential_window();

-- The freeze: entitlements are added and removed only while their round is
-- planned, and only for keys of an issued batch for that round. Once the
-- round is open the only change is a vote using one up, consumed from
-- false to true, by a key of an issued batch; nothing ever turns it back,
-- and nothing changes once the round has closed. Like the configuration triggers, these read the
-- election's row with a share lock, so a change of the election's state
-- waits for them to commit, and the other way round.
create function credential_entitlement_freeze() returns trigger
  language plpgsql set search_path = pg_catalog as $$
declare
  round_state text;
begin
  if current_user <> session_user then
    return coalesce(new, old);
  end if;
  if tg_op = 'UPDATE' and (new.election_id, new.credential_id, new.round_contest_id) is distinct from (old.election_id, old.credential_id, old.round_contest_id) then
    raise exception 'an entitlement never moves' using errcode = 'object_not_in_prerequisite_state';
  end if;
  select r.state into round_state
    from public.round_contest rc
    join public.round r on r.id = rc.round_id
    join public.election e on e.id = r.election_id
   where rc.id = coalesce(new.round_contest_id, old.round_contest_id)
     for share of e;
  if tg_op = 'UPDATE' then
    if new.consumed is distinct from old.consumed and (old.consumed or round_state is distinct from 'open') then
      raise exception 'an entitlement is used up only while its round is open, and never restored' using errcode = 'object_not_in_prerequisite_state';
    end if;
    -- A void batch keeps its entitlements, so its sheets can still be
    -- compared, but its keys never vote.
    if new.consumed and not old.consumed and not exists (
      select 1 from public.credential c join public.credential_batch b on b.id = c.batch_id
       where c.id = new.credential_id and b.state = 'issued'
    ) then
      raise exception 'a key of a void batch never votes' using errcode = 'object_not_in_prerequisite_state';
    end if;
    return new;
  end if;
  if round_state is distinct from 'planned' then
    raise exception 'entitlements are added and removed only while their round is planned' using errcode = 'object_not_in_prerequisite_state';
  end if;
  if tg_op = 'INSERT' and (new.consumed or not exists (
    select 1 from public.credential c
      join public.credential_batch b on b.id = c.batch_id
      join public.round_contest rc on rc.id = new.round_contest_id
      join public.round r on r.id = rc.round_id
     where c.id = new.credential_id and b.state = 'issued' and b.round_kind = r.kind
  )) then
    raise exception 'an entitlement is added unused, for a key of an issued batch for its round' using errcode = 'object_not_in_prerequisite_state';
  end if;
  return coalesce(new, old);
end
$$;

create trigger credential_entitlement_freeze before insert or update or delete on credential_entitlement
  for each row execute function credential_entitlement_freeze();
