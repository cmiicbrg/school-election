// PostgreSQL settings the privacy model depends on, checked at startup on
// the runtime connection itself, so the values seen are the ones that apply
// to the application's sessions. Any other value stops the server, in every
// environment: these are not tuning knobs.

import type { Database } from './db.ts'

interface Requirement {
  readonly name: string
  readonly expected: string
  readonly why: string
}

const NO_ORDERING = 'would record when each transaction committed, which orders ballots'
const NO_WAL_RESIDUE = 'would keep write-ahead log that still links ballots to entitlements'
const NO_STATEMENT_LOGS = 'would let the server log statements or their parameters'

export const REQUIRED_SETTINGS: readonly Requirement[] = [
  { name: 'track_commit_timestamp', expected: 'off', why: NO_ORDERING },
  { name: 'archive_mode', expected: 'off', why: NO_WAL_RESIDUE },
  { name: 'wal_recycle', expected: 'off', why: NO_WAL_RESIDUE },
  { name: 'wal_keep_size', expected: '0', why: NO_WAL_RESIDUE },
  { name: 'summarize_wal', expected: 'off', why: NO_WAL_RESIDUE },
  { name: 'log_statement', expected: 'none', why: NO_STATEMENT_LOGS },
  { name: 'log_error_verbosity', expected: 'terse', why: 'would log error detail, which can quote values' },
  { name: 'log_min_error_statement', expected: 'panic', why: NO_STATEMENT_LOGS },
  { name: 'log_parameter_max_length', expected: '0', why: NO_STATEMENT_LOGS },
  { name: 'log_parameter_max_length_on_error', expected: '0', why: NO_STATEMENT_LOGS },
  { name: 'log_min_duration_statement', expected: '-1', why: NO_STATEMENT_LOGS },
  { name: 'log_min_duration_sample', expected: '-1', why: NO_STATEMENT_LOGS },
  { name: 'log_transaction_sample_rate', expected: '0', why: NO_STATEMENT_LOGS },
  { name: 'log_lock_waits', expected: 'off', why: NO_STATEMENT_LOGS },
]

// auto_explain logs statements with their plans and parameters.
const PRELOAD_SETTINGS = ['shared_preload_libraries', 'session_preload_libraries', 'local_preload_libraries']

/** Every setting that differs from what the privacy model needs, as a message naming it. */
export async function checkDatabaseSettings(db: Pick<Database, 'query'>): Promise<string[]> {
  const problems: string[] = []
  for (const { name, expected, why } of REQUIRED_SETTINGS) {
    const actual = await show(db, name)
    if (actual !== expected) problems.push(`${name} is ${actual}, must be ${expected}: any other value ${why}`)
  }
  for (const name of PRELOAD_SETTINGS) {
    const libraries = (await show(db, name)).split(',').map((s) => s.trim().replace(/^"|"$/g, ''))
    if (libraries.some((library) => /(^|\/)auto_explain(\.so)?$/.test(library))) {
      problems.push(`${name} loads auto_explain, which logs statements with their parameters`)
    }
  }
  return problems
}

async function show(db: Pick<Database, 'query'>, name: string): Promise<string> {
  // SHOW takes no bind parameters; current_setting does, so no name is ever
  // spliced into SQL.
  const { rows } = await db.query<{ value: string }>('select current_setting($1) as value', [name])
  return rows[0]?.value ?? ''
}
