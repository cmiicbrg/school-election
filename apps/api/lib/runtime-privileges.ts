// Everything the runtime role may do with the objects in schema public, in
// one list. The migrator revokes every table, sequence and function privilege
// from PUBLIC and the runtime role and grants exactly this list on every run,
// after the migrations, so a grant made by hand does not survive the next
// deploy; the server refuses to start while the role can do anything more.
// Deny by default: a table or function that is not listed gets nothing, and
// sequences get nothing at all (identity columns need no grant).

export const TABLE_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] as const
export type TablePrivilege = typeof TABLE_PRIVILEGES[number]

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
  election: { table: ['SELECT', 'INSERT'] },
  // Members are invited and removed; binding sets user_id once.
  election_member: { table: ['SELECT', 'INSERT', 'DELETE'], updateColumns: ['user_id'] },
}

/** Functions the runtime role may execute, by their signature. */
export const RUNTIME_FUNCTIONS: readonly string[] = []

/** One privilege, as the startup check reports what the role can do. */
export interface Privilege {
  kind: 'table' | 'column' | 'sequence' | 'function'
  /** A table, `table.column`, a sequence or a function signature. */
  object: string
  privilege: string
}

/** The privileges the list grants, in the form the startup check reports them. */
export function expectedPrivileges(): Privilege[] {
  return [
    ...Object.entries(RUNTIME_TABLES).flatMap(([table, grant]) => [
      ...grant.table.map((privilege): Privilege => ({ kind: 'table', object: table, privilege })),
      ...(grant.updateColumns ?? []).map((column): Privilege => ({ kind: 'column', object: `${table}.${column}`, privilege: 'UPDATE' })),
    ]),
    ...RUNTIME_FUNCTIONS.map((signature): Privilege => ({ kind: 'function', object: signature, privilege: 'EXECUTE' })),
  ]
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/
const SIGNATURE = /^[a-z_][a-z0-9_]*\((?:[a-z_][a-z0-9_ ]*(?:, [a-z_][a-z0-9_ ]*)*)?\)$/

/**
 * The GRANT statements for `role`, for the tables and functions that exist.
 * Names come from this file only, and are checked to be plain identifiers,
 * so they need no quoting.
 */
export function grantStatements(role: string, existing: { tables: ReadonlySet<string>, functions: ReadonlySet<string> }): string[] {
  const statements: string[] = []
  for (const [table, grant] of Object.entries(RUNTIME_TABLES)) {
    for (const name of [table, ...(grant.updateColumns ?? [])]) {
      if (!IDENTIFIER.test(name)) throw new Error(`runtime privileges: ${name} is not a plain identifier`)
    }
    if (!existing.tables.has(table)) continue
    if (grant.table.length > 0) statements.push(`grant ${grant.table.join(', ').toLowerCase()} on table ${table} to ${role}`)
    if (grant.updateColumns?.length) statements.push(`grant update (${grant.updateColumns.join(', ')}) on table ${table} to ${role}`)
  }
  for (const signature of RUNTIME_FUNCTIONS) {
    if (!SIGNATURE.test(signature)) throw new Error(`runtime privileges: ${signature} is not a plain function signature`)
    if (existing.functions.has(signature)) statements.push(`grant execute on function ${signature} to ${role}`)
  }
  return statements
}
