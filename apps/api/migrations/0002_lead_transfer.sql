-- The Wahlleitung can be handed over to a co-admin who has signed in; the
-- owner becomes a co-admin. The owner is therefore the member whose role
-- is owner, always a person, and no longer the one member without an
-- invitation: a former owner stays without one as a co-admin, and the
-- one handed the lead keeps the address they were invited with.
--
-- A release before this one runs on it as well: it creates an owner
-- without an invitation, as before, and refuses to remove a member
-- without one, which then means a former owner too.

alter table election_member drop constraint election_member_check;
alter table election_member add constraint election_member_owner_person check (role <> 'owner' or user_id is not null);

drop index election_member_owner;
create unique index election_member_owner on election_member (election_id) where role = 'owner';

-- The one way a role changes: the owner of `target` becomes a co-admin
-- and the co-admin `to_member`, who has signed in, the owner, in that
-- order, so that the election has one owner after each statement. When
-- the lead may be handed over is the lifecycle's (canManageMembers),
-- asked by the route and again under the election's lock.
create function transfer_lead(target uuid, to_member uuid) returns void
  language plpgsql security definer set search_path = pg_catalog as $$
begin
  if not exists (
    select 1 from public.election_member m
     where m.id = to_member and m.election_id = target and m.role = 'admin' and m.user_id is not null
  ) then
    perform public.refuse('the lead goes to a co-admin of the election who has signed in');
  end if;
  update public.election_member set role = 'admin' where election_id = target and role = 'owner';
  update public.election_member set role = 'owner' where id = to_member;
end
$$;
