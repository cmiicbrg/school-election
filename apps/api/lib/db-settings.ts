// PostgreSQL settings the privacy model depends on, checked at startup on
// the runtime connection itself, so the values seen are the ones that apply
// to the application's sessions. Any other value stops the server, in every
// environment: these are not tuning knobs.

import { RUNTIME_ROLE, type Database } from './db.ts'

interface Requirement {
  readonly name: string
  readonly expected: string
  readonly why: string
}

const NO_ORDERING = 'would record when each transaction committed, which orders ballots'
// PostgreSQL writes every change to the write-ahead log for crash recovery,
// votes included, whatever these settings say. They only stop that log from
// being archived, kept beyond what recovery needs, reused under another file
// name, summarised, held by a replication slot or streamed to a standby, so
// that the clean-up at finalization (lib/cleanup.ts) can remove what is
// left and nothing else holds a copy.
const KEEPS_WAL = 'would keep, copy or stream write-ahead log beyond what crash recovery needs, and that log can link ballots to entitlements'
const NO_STATEMENT_LOGS = 'would let the server log statements or their parameters'

export const REQUIRED_SETTINGS: readonly Requirement[] = [
  { name: 'track_commit_timestamp', expected: 'off', why: NO_ORDERING },
  { name: 'archive_mode', expected: 'off', why: KEEPS_WAL },
  { name: 'wal_recycle', expected: 'off', why: KEEPS_WAL },
  { name: 'wal_keep_size', expected: '0', why: KEEPS_WAL },
  { name: 'summarize_wal', expected: 'off', why: KEEPS_WAL },
  { name: 'max_replication_slots', expected: '0', why: KEEPS_WAL },
  { name: 'max_wal_senders', expected: '0', why: KEEPS_WAL },
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
 * Every setting that differs from what the privacy model needs, as a message
 * naming it; or the reason the server connects as the wrong role.
 *
 * These guard against mistakes: PostgreSQL started without the documented
 * flags, a module preloaded for debugging, a connection string naming the
 * superuser or the database owner. What the runtime role may do is reset by
 * every migration run (scripts/migrate.ts). A superuser who changes it again
 * by hand works around the deployment, and no check here could stop them.
 */
export async function checkDatabaseSettings(db: Pick<Database, 'query'>): Promise<string[]> {
  const { rows: [role] } = await db.query<{ name: string }>('select current_user::text as name')
  // Any other role could hold rights the runtime role never gets, and
  // switch the settings below off for its own sessions.
  if (role?.name !== RUNTIME_ROLE) return [`the server connects as ${role?.name ?? 'an unknown role'}; it must connect as ${RUNTIME_ROLE}`]

  const problems: string[] = []
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
  problems.push(...PRELOAD_SETTINGS.flatMap((name) => preloadProblem(name, values.get(name) ?? '')))
  return problems
}

function preloadProblem(name: string, value: string): string[] {
  const unexpected = value.split(',')
    .map((entry) => entry.trim().replace(/^"|"$/g, ''))
    .filter((entry) => entry !== '')
    .map((entry) => entry.replace(/^.*\//, '').replace(/\.so$/, ''))
    .filter((library) => !ALLOWED_PRELOAD.has(library))
  if (unexpected.length === 0) return []
  return [`${name} loads ${unexpected.join(', ')}; only ${[...ALLOWED_PRELOAD].join(', ')} may be preloaded, since other modules such as auto_explain or pgaudit can log statements with their parameters`]
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
