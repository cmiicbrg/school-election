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

revoke all on function preload_settings() from public;
