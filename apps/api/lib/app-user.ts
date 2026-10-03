import type { Database } from './db.ts'

/** A person as a verified ID token describes them. */
export interface EntraIdentity {
  tid: string
  oid: string
  displayName: string
  upn: string | null
}

/**
 * Records a sign-in: the person is found by (tid, oid) and nothing else,
 * never by e-mail address, UPN or oid alone, and their name and upn are
 * refreshed from the token. Returns app_user.id.
 */
export async function upsertAppUser(db: Pick<Database, 'query'>, identity: EntraIdentity): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into app_user (tid, oid, display_name, upn) values ($1, $2, $3, $4)
     on conflict (tid, oid) do update set display_name = excluded.display_name, upn = excluded.upn
     returning id`,
    [identity.tid, identity.oid, identity.displayName, identity.upn],
  )
  const id = rows[0]?.id
  if (id === undefined) throw new Error('app_user upsert returned no row')
  return id
}
