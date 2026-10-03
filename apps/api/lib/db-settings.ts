// PostgreSQL settings the privacy model depends on, checked at startup on
// the runtime connection itself, so the values seen are the ones that apply
// to the application's sessions. Any other value stops the server, in every
// environment: these are not tuning knobs.

import { RUNTIME_ROLE, type Database } from './db.ts'
import { expectedPrivileges, TABLE_PRIVILEGES, type Privilege } from './runtime-privileges.ts'

interface Requirement {
  readonly name: string
  readonly expected: string
  readonly why: string
}

const NO_ORDERING = 'would record when each transaction committed, which orders ballots'
// PostgreSQL writes every change to the write-ahead log for crash recovery,
// votes included, whatever these settings say. They only stop that log from
// being archived, kept beyond what recovery needs, reused under another file
// name or summarised, so that the clean-up after an election can remove what
// is left.
const KEEPS_WAL = 'would keep or copy write-ahead log beyond what crash recovery needs, and that log can link ballots to entitlements'
const NO_STATEMENT_LOGS = 'would let the server log statements or their parameters'

export const REQUIRED_SETTINGS: readonly Requirement[] = [
  { name: 'track_commit_timestamp', expected: 'off', why: NO_ORDERING },
  { name: 'archive_mode', expected: 'off', why: KEEPS_WAL },
  { name: 'wal_recycle', expected: 'off', why: KEEPS_WAL },
  { name: 'wal_keep_size', expected: '0', why: KEEPS_WAL },
  { name: 'summarize_wal', expected: 'off', why: KEEPS_WAL },
  { name: 'log_statement', expected: 'none', why: NO_STATEMENT_LOGS },
  // terse applies to the text formats only; log_destination is checked below.
  { name: 'log_error_verbosity', expected: 'terse', why: 'would log error detail, which can quote values' },
  { name: 'log_min_error_statement', expected: 'panic', why: NO_STATEMENT_LOGS },
  { name: 'log_parameter_max_length', expected: '0', why: NO_STATEMENT_LOGS },
  { name: 'log_parameter_max_length_on_error', expected: '0', why: NO_STATEMENT_LOGS },
  { name: 'log_min_duration_statement', expected: '-1', why: NO_STATEMENT_LOGS },
  { name: 'log_min_duration_sample', expected: '-1', why: NO_STATEMENT_LOGS },
  { name: 'log_transaction_sample_rate', expected: '0', why: NO_STATEMENT_LOGS },
  { name: 'log_lock_waits', expected: 'off', why: NO_STATEMENT_LOGS },
  { name: 'log_duration', expected: 'off', why: 'would log every completed statement with its duration' },
  { name: 'debug_print_parse', expected: 'off', why: 'would log the query tree of every statement' },
  { name: 'debug_print_rewritten', expected: 'off', why: 'would log the query tree of every statement' },
  { name: 'debug_print_plan', expected: 'off', why: 'would log the plan of every statement' },
  { name: 'log_statement_stats', expected: 'off', why: 'would log timing statistics for every statement' },
  { name: 'log_parser_stats', expected: 'off', why: 'would log timing statistics for every statement' },
  { name: 'log_planner_stats', expected: 'off', why: 'would log timing statistics for every statement' },
  { name: 'log_executor_stats', expected: 'off', why: 'would log timing statistics for every statement' },
]

/** Settings where several values are safe; for a list, every entry must be. */
export const ALLOWED_SETTINGS: readonly { name: string, allowed: readonly string[], why: string }[] = [
  {
    name: 'log_min_messages',
    allowed: ['warning', 'error', 'log', 'fatal', 'panic'],
    why: 'debug levels log every statement with a timestamp',
  },
  {
    name: 'log_destination',
    allowed: ['stderr', 'syslog', 'eventlog'],
    why: 'csvlog and jsonlog write error detail, which quotes row values, whatever log_error_verbosity says',
  },
]

// Deny by default: modules such as auto_explain and pgaudit log statements
// with their parameters, and any other module could. pg_stat_statements keeps
// aggregated query texts with constants replaced, never parameters. Two of
// these settings are hidden from unprivileged roles, so all three are read
// through preload_settings() (migration 0006), which returns exactly them.
const PRELOAD_SETTINGS = ['shared_preload_libraries', 'session_preload_libraries', 'local_preload_libraries']
const ALLOWED_PRELOAD = new Set(['pg_stat_statements'])

/**
 * Every setting that differs from what the privacy model needs, and every
 * privilege the connected role should not have, as a message naming it.
 */
export async function checkDatabaseSettings(db: Pick<Database, 'query'>): Promise<string[]> {
  const { problems, isRuntimeRole } = await checkConnectedRole(db)
  // Only for the runtime role: any other role is refused above, and a
  // superuser would list every privilege there is.
  if (isRuntimeRole) problems.push(...await checkObjectPrivileges(db))
  const values = await currentSettings(db, [
    ...REQUIRED_SETTINGS.map((s) => s.name),
    ...ALLOWED_SETTINGS.map((s) => s.name),
  ])
  const { rows: preload } = await db.query<{ name: string, setting: string }>('select name, setting from preload_settings()')
  for (const { name, setting } of preload) values.set(name, setting)
  for (const { name, expected, why } of REQUIRED_SETTINGS) {
    const actual = values.get(name) ?? ''
    if (actual !== expected) problems.push(`${name} is ${actual}, must be ${expected}: any other value ${why}`)
  }
  for (const { name, allowed, why } of ALLOWED_SETTINGS) {
    const actual = values.get(name) ?? ''
    const entries = actual.split(',').map((entry) => entry.trim().toLowerCase())
    if (entries.some((entry) => !allowed.includes(entry))) {
      problems.push(`${name} is ${actual}, must be one of ${allowed.join(', ')}: ${why}`)
    }
  }
  for (const name of PRELOAD_SETTINGS) {
    const unexpected = (values.get(name) ?? '').split(',')
      .map((entry) => entry.trim().replace(/^"|"$/g, ''))
      .filter((entry) => entry !== '')
      .map((entry) => entry.replace(/^.*\//, '').replace(/\.so$/, ''))
      .filter((library) => !ALLOWED_PRELOAD.has(library))
    if (unexpected.length > 0) {
      problems.push(`${name} loads ${unexpected.join(', ')}; only ${[...ALLOWED_PRELOAD].join(', ')} may be preloaded, since other modules such as auto_explain or pgaudit can log statements with their parameters`)
    }
  }

  return problems
}

// The server must connect as the unprivileged runtime role. A superuser,
// the database owner or a role with extra rights or memberships could read
// or change everything, and some of them could switch the settings above
// off for their own sessions.
async function checkConnectedRole(db: Pick<Database, 'query'>): Promise<{ problems: string[], isRuntimeRole: boolean }> {
  const { rows } = await db.query<{ name: string, attributes: string[], owner: boolean, memberships: string[], creates: string[] }>(
    `select r.rolname as name,
            array_remove(array[
              case when r.rolsuper then 'superuser' end,
              case when r.rolcreaterole then 'createrole' end,
              case when r.rolcreatedb then 'createdb' end,
              case when r.rolreplication then 'replication' end,
              case when r.rolbypassrls then 'bypassrls' end
            ], null) as attributes,
            (select d.datdba = r.oid from pg_database d where d.datname = current_database()) as owner,
            -- Effective membership, including inherited roles; a superuser
            -- is reported as such instead. text[], not name[]: the driver
            -- parses only the former into an array.
            case when r.rolsuper then '{}'::text[] else coalesce((
              select array_agg(g.rolname::text order by g.rolname) from pg_roles g
               where g.oid <> r.oid and pg_has_role(r.oid, g.oid, 'MEMBER')
            ), '{}'::text[]) end as memberships,
            array_remove(array[
              case when has_schema_privilege('public', 'CREATE') then 'objects in schema public' end,
              case when has_database_privilege(current_database(), 'CREATE') then 'schemas' end,
              case when has_database_privilege(current_database(), 'TEMPORARY') then 'temporary tables' end
            ], null) as creates
       from pg_roles r where r.rolname = current_user`,
  )
  const role = rows[0]
  if (!role) return { problems: ['cannot identify the connected role'], isRuntimeRole: false }
  const problems: string[] = []
  const who = `the server connects as ${role.name}`
  // Any other role could own tables or hold grants this check cannot see.
  if (role.name !== RUNTIME_ROLE) problems.push(`${who}; it must connect as ${RUNTIME_ROLE}`)
  if (role.attributes.length > 0) problems.push(`${who}, which has ${role.attributes.join(', ')}; it must use the unprivileged runtime role`)
  if (role.owner) problems.push(`${who}, which owns the database; it must use the unprivileged runtime role`)
  if (role.memberships.length > 0) problems.push(`${who}, which is a member of ${role.memberships.join(', ')}; the runtime role must hold nothing else`)
  if (role.creates.length > 0) problems.push(`${who}, which can create ${role.creates.join(', ')}; the runtime role may only use what migrations grant`)
  return { problems, isRuntimeRole: role.name === RUNTIME_ROLE && !role.attributes.includes('superuser') }
}

// What the connected role can do with every table, column, sequence and
// function in schema public, through any grant, to it or to PUBLIC. A
// column privilege is listed only where the role lacks it on the table.
const PRIVILEGES_QUERY = `
  select 'table' as kind, c.relname::text as object, p.privilege
    from pg_class c cross join unnest($1::text[]) as p(privilege)
   where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f')
     and has_table_privilege(c.oid, p.privilege)
  union all
  select 'column', c.relname || '.' || a.attname, p.privilege
    from pg_class c
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) as p(privilege)
   where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f')
     and has_column_privilege(c.oid, a.attnum, p.privilege) and not has_table_privilege(c.oid, p.privilege)
  union all
  select 'sequence', c.relname::text, p.privilege
    from pg_class c cross join unnest(array['USAGE', 'SELECT', 'UPDATE']) as p(privilege)
   where c.relnamespace = 'public'::regnamespace and c.relkind = 'S' and has_sequence_privilege(c.oid, p.privilege)
  union all
  select 'function', f.oid::regprocedure::text, 'EXECUTE'
    from pg_proc f
   where f.pronamespace = 'public'::regnamespace and has_function_privilege(f.oid, 'EXECUTE')`

// Anything beyond lib/runtime-privileges.ts, granted by hand or left over,
// stops the server: the next migration run takes it away again.
async function checkObjectPrivileges(db: Pick<Database, 'query'>): Promise<string[]> {
  const key = (p: Privilege) => `${p.privilege} on ${p.kind} ${p.object}`
  const allowed = new Set(expectedPrivileges().map(key))
  const { rows } = await db.query<Privilege>(PRIVILEGES_QUERY, [TABLE_PRIVILEGES])
  const extra = rows.map(key).filter((privilege) => !allowed.has(privilege)).sort()
  if (extra.length === 0) return []
  return [`the runtime role has ${extra.join(', ')}, beyond what lib/runtime-privileges.ts grants; run the migrations, which reset its privileges`]
}

async function currentSettings(db: Pick<Database, 'query'>, names: string[]): Promise<Map<string, string>> {
  // One round trip; current_setting takes the names as a bind parameter, so
  // none is ever spliced into SQL.
  const { rows } = await db.query<{ name: string, value: string }>(
    'select name, current_setting(name) as value from unnest($1::text[]) as name',
    [names],
  )
  return new Map(rows.map((row) => [row.name, row.value]))
}
