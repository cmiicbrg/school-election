-- A round's phase: a fresh random id each time its state changes.
--
-- A voter's session is redeemed in one phase of a round, open or in test
-- mode, and must hold exactly while that phase lasts (lib/voter.ts,
-- routes/voter.ts). The state alone cannot tell one test of a round from
-- the next: a session from an ended test would hold in the test after
-- it, within its lifetime, with the key's entitlements unused again. So
-- the session carries the phase's id and holds while it is the round's.
-- The id is the database's: the trigger sets it with the state, and
-- nothing else changes it. A round is the election's, not a voter's, so
-- it is not a privacy table. Existing rounds get a phase of their own;
-- no session is bound to one yet.

alter table round add column phase uuid not null default gen_random_uuid();

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

create trigger round_phase before update on round
  for each row execute function round_phase();
