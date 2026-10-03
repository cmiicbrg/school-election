-- Elections and the people who may work on them. An election is visible
-- only to its members: its owner (the teacher who created it), co-admins
-- (role admin) and witnesses. No global role grants access to an election.
--
-- state mirrors ELECTION_STATES in packages/election-core/src/lifecycle.ts,
-- and a test keeps the two equal. Random (version 4) ids, and no
-- timestamps: the audit log records when each change happened.

create table election (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 200),
  description text not null default '' check (char_length(description) <= 2000),
  state text not null default 'draft' check (state in ('draft', 'prepared', 'active', 'final'))
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

-- The server creates elections, but does not yet change or delete them; it
-- adds and removes members, and binds an invitation by setting user_id.
grant select, insert on election to school_election_app;
grant select, insert, delete on election_member to school_election_app;
grant update (user_id) on election_member to school_election_app;
