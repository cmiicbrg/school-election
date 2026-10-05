// Everything the runtime role may do with the objects in schema public, in
// one list. The migrator revokes every table, sequence and function privilege
// from PUBLIC and the runtime role and grants exactly this list on every run,
// after the migrations: PostgreSQL's own defaults (every new function is
// executable by PUBLIC), a restored dump or a grant a newer version no longer
// lists do not survive the next deploy. Deny by default: a table or function
// that is not listed gets nothing, and sequences get nothing at all
// (identity columns need no grant).

export type TablePrivilege = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE' | 'REFERENCES' | 'TRIGGER' | 'MAINTAIN'

export interface TableGrant {
  /** Privileges on the whole table. */
  readonly table: readonly TablePrivilege[]
  /** UPDATE on these columns only. */
  readonly updateColumns?: readonly string[]
}

export const RUNTIME_TABLES: Readonly<Record<string, TableGrant>> = {
  // Sign-in records a person and refreshes their name and address; the
  // identity itself is never rewritten, and nobody is deleted.
  app_user: { table: ['SELECT', 'INSERT'], updateColumns: ['display_name', 'email'] },
  // Append-only: events are added and read, never changed or removed.
  audit_event: { table: ['SELECT', 'INSERT'] },
  // Title, description and the lifecycle state change, a final election
  // not at all (migration 0015); an election is removed only through
  // delete_election (0011).
  election: { table: ['SELECT', 'INSERT'], updateColumns: ['title', 'description', 'state'] },
  // Members are invited and removed; binding sets user_id once.
  election_member: { table: ['SELECT', 'INSERT', 'DELETE'], updateColumns: ['user_id'] },
  // The states of the lifecycle with their flags, and the transitions of
  // a round, which the triggers and the definer functions read as the
  // role that runs them (migrations 0007 and 0009). Nothing changes them.
  election_state: { table: ['SELECT'] },
  round_kind: { table: ['SELECT'] },
  round_state: { table: ['SELECT'] },
  round_transition: { table: ['SELECT'] },
  // The configuration of an election. Nothing moves to another election or
  // contest: those columns are never updated.
  contest: { table: ['SELECT', 'INSERT', 'DELETE'], updateColumns: ['title', 'ruleset_id'] },
  candidate: { table: ['SELECT', 'INSERT', 'DELETE'], updateColumns: ['surname', 'given_name', 'picture', 'picture_sha256'] },
  voter_group: { table: ['SELECT', 'INSERT', 'DELETE'], updateColumns: ['name'] },
  voter_group_contest: { table: ['SELECT', 'INSERT', 'DELETE'] },
  // Preparing creates the regular round and its ballot boxes; the runoff
  // round and its boxes are activate_runoff's (migration 0013). A round's
  // state moves along round_transition: opening is a direct update, closing
  // is the seal's (migration 0009); its phase is the trigger's (0012). No
  // round is removed.
  round: { table: ['SELECT', 'INSERT'], updateColumns: ['state'] },
  round_contest: { table: ['SELECT', 'INSERT', 'DELETE'] },
  // Keys are issued in batches and a batch is voided; keys and batches are
  // removed only with their voter group or election. Triggers keep a batch
  // voided once and a key unchanged (migrations 0008 and 0015), reading
  // the batch states as the role that runs them; when keys are issued is
  // the lifecycle's.
  credential_batch_state: { table: ['SELECT'] },
  credential_batch: { table: ['SELECT', 'INSERT'], updateColumns: ['state'] },
  credential: { table: ['SELECT', 'INSERT'] },
  // A vote uses an entitlement up, and nothing else changes it. The
  // clean-up at finalization rewrites the table without the dead versions
  // the votes and the seal left (VACUUM FULL, migration 0014).
  credential_entitlement: { table: ['SELECT', 'INSERT', 'MAINTAIN'], updateColumns: ['consumed'] },
  // The kinds of ballot, which the staging trigger reads (migration 0009).
  ballot_kind: { table: ['SELECT'] },
  // A vote stages its ballot. Nobody reads, changes or removes a staged
  // ballot: the seal moves them, as the owner; the clean-up rewrites the
  // table without the staged rows the seal deleted (migration 0014).
  ballot_box: { table: ['INSERT', 'MAINTAIN'] },
  // Sealed ballots are read for the count; the seal alone writes them.
  ballot: { table: ['SELECT'] },
  // The count writes one snapshot per ballot box when the round closes,
  // and members read them; a trigger refuses any change (migration 0010).
  result_snapshot: { table: ['SELECT', 'INSERT'] },
  // A lot the officials drew is recorded once and read by every member; a
  // trigger refuses any change (migration 0013).
  lot_decision: { table: ['SELECT', 'INSERT'] },
  // The final outcome of every contest, written by finalize_election alone
  // and read by every member; a trigger refuses any change (migration 0014).
  final_outcome: { table: ['SELECT'] },
}

/** Functions the runtime role may execute, by their signature as PostgreSQL prints a regprocedure: argument types without spaces between them. */
export const RUNTIME_FUNCTIONS: readonly string[] = [
  // The preload settings for the startup check (migration 0006).
  'preload_settings()',
  // How every trigger refuses a change, called as the role that runs the
  // trigger (migration 0007).
  'refuse(text)',
  // Closes an open round and seals its ballots (migration 0009).
  'seal_round(uuid)',
  // The test mode: ends a test with nothing kept, reads a test's ballots
  // for its result; and removes an election nobody used (migration 0011).
  'end_test(uuid)',
  'test_ballots(uuid)',
  'delete_election(uuid)',
  // The runoff round, created open with its boxes and entitlements, once (migration 0013).
  'activate_runoff(uuid,jsonb)',
  // The clean-up at finalization: what still holds a snapshot older than
  // the election's seals, and the flush of the write-ahead log with its
  // check; then the declaration that makes the election final (migration 0014).
  'cleanup_blockers(uuid)',
  'flush_wal(pg_lsn)',
  'finalize_election(uuid,jsonb,integer,text,text)',
]

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/
const SIGNATURE = /^[a-z_][a-z0-9_]*\((?:[a-z_][a-z0-9_ ]*(?:,[a-z_][a-z0-9_ ]*)*)?\)$/

/**
 * The GRANT statements for `role`, for the tables and functions that exist.
 * Names come from this file only, and are checked to be plain identifiers,
 * so they need no quoting.
 */
export function grantStatements(role: string, existing: { tables: ReadonlySet<string>, functions: ReadonlySet<string> }): string[] {
  const names = Object.entries(RUNTIME_TABLES).flatMap(([table, grant]) => [table, ...(grant.updateColumns ?? [])])
  const unsafe = [...names.filter((name) => !IDENTIFIER.test(name)), ...RUNTIME_FUNCTIONS.filter((signature) => !SIGNATURE.test(signature))]
  if (unsafe.length > 0) throw new Error(`runtime privileges: not a plain identifier or function signature: ${unsafe.join(', ')}`)
  return [
    ...Object.entries(RUNTIME_TABLES)
      .filter(([table]) => existing.tables.has(table))
      .flatMap(([table, grant]) => tableGrants(role, table, grant)),
    ...RUNTIME_FUNCTIONS
      .filter((signature) => existing.functions.has(signature))
      .map((signature) => `grant execute on function ${signature} to ${role}`),
  ]
}

function tableGrants(role: string, table: string, grant: TableGrant): string[] {
  const statements: string[] = []
  if (grant.table.length > 0) statements.push(`grant ${grant.table.join(', ').toLowerCase()} on table ${table} to ${role}`)
  if (grant.updateColumns?.length) statements.push(`grant update (${grant.updateColumns.join(', ')}) on table ${table} to ${role}`)
  return statements
}
