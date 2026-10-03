// The members of an election: invitations by school e-mail address,
// removal, and binding an invitation to the person who signs in with that
// address. Every change appends its audit event in its own transaction.

import type pg from 'pg'
import { canManageMembers, type ElectionState } from '@school-election/election-core'
import type { EntraIdentity } from './app-user.ts'
import { appendAudit, lockElection } from './audit.ts'
import type { Database } from './db.ts'
import { lifecycleOf, Refusal, type ElectionAccess } from './election-access.ts'
import type { ElectionRole, InvitedRole } from './permissions.ts'

export interface Member {
  id: string
  role: ElectionRole
  /** Pending until the invited person signs in; the owner is always bound. */
  status: 'pending' | 'bound'
  /** The address the member was invited by, as it was entered; null for the owner. */
  email: string | null
  /** The bound person's name; null while pending. */
  displayName: string | null
}

interface MemberRow {
  id: string
  role: ElectionRole
  invited_email: string | null
  bound: boolean
  display_name: string | null
}

const toMember = (row: MemberRow): Member => ({
  id: row.id,
  role: row.role,
  status: row.bound ? 'bound' : 'pending',
  email: row.invited_email,
  displayName: row.display_name,
})

/** The owner first, then co-admins, then witnesses, each by name or address. */
export async function listMembers(db: Pick<Database, 'query'>, electionId: string): Promise<Member[]> {
  const { rows } = await db.query<MemberRow>(
    `select m.id, m.role, m.invited_email, m.user_id is not null as bound, u.display_name
       from election_member m left join app_user u on u.id = m.user_id
      where m.election_id = $1
      order by array_position(array['owner', 'admin', 'witness'], m.role), lower(coalesce(u.display_name, m.invited_email)), m.id`,
    [electionId],
  )
  return rows.map(toMember)
}

/**
 * Invites a co-admin or witness, inside changeElection. An address that
 * already has an invitation in this election, or belongs to a member who
 * signed in with it, is refused (409 already_member).
 */
export async function inviteMember(client: pg.ClientBase, access: ElectionAccess, email: string, role: InvitedRole): Promise<Member> {
  const { rows } = await client.query<{ id: string }>(
    `insert into election_member (election_id, role, invited_email)
     select $1, $2, $3
      where not exists (
        select 1 from election_member m left join app_user u on u.id = m.user_id
         where m.election_id = $1 and (lower(m.invited_email) = lower($3) or lower(u.email) = lower($3)))
     returning id`,
    [access.electionId, role, email],
  )
  const id = rows[0]?.id
  if (id === undefined) throw new Refusal(409, 'already_member')
  await appendAudit(client, access.electionId, { actor: access.actor, action: 'member.invited', metadata: { email, role } })
  return { id, role, status: 'pending', email, displayName: null }
}

/**
 * Removes an invitation or a member, inside changeElection. Access ends
 * with the removed person's next request. The owner cannot be removed.
 */
export async function removeMember(client: pg.ClientBase, access: ElectionAccess, memberId: string): Promise<void> {
  const { rows } = await client.query<{ role: ElectionRole, invited_email: string | null }>(
    'select role, invited_email from election_member where id = $1 and election_id = $2',
    [memberId, access.electionId],
  )
  const member = rows[0]
  if (!member) throw new Refusal(404, 'not_found')
  if (member.role === 'owner' || member.invited_email === null) throw new Refusal(409, 'owner_not_removable')
  await client.query('delete from election_member where id = $1', [memberId])
  await appendAudit(client, access.electionId, {
    actor: access.actor,
    action: 'member.removed',
    metadata: { email: member.invited_email, role: member.role },
  })
}

/**
 * At sign-in, in the transaction that records the person: binds every
 * pending invitation whose address matches theirs, ignoring case, to
 * their app_user row, once. Only for a person of the configured tenant,
 * and not in an election that is final or that they are a member of
 * already; such an invitation stays pending and grants nothing. Each
 * binding is audited with the invited person as the actor.
 */
export async function bindInvitations(client: pg.ClientBase, userId: string, person: EntraIdentity, tenantId: string): Promise<void> {
  if (person.email === null || person.tid !== tenantId) return
  const { rows } = await client.query<{ election_id: string }>(
    `select distinct election_id from election_member
      where user_id is null and lower(invited_email) = lower($1)
      order by election_id`,
    [person.email],
  )
  // One election after another, in a fixed order, each under its lock:
  // two sign-ins never wait for each other's locks the other way round.
  for (const { election_id: electionId } of rows) {
    await lockElection(client, electionId)
    const election = await client.query<{ state: ElectionState }>('select state from election where id = $1', [electionId])
    const state = election.rows[0]?.state
    if (state === undefined || !canManageMembers(lifecycleOf(state)).ok) continue
    const bound = await client.query<{ invited_email: string, role: InvitedRole }>(
      `update election_member m set user_id = $3
        where m.election_id = $1 and m.user_id is null and lower(m.invited_email) = lower($2)
          and not exists (select 1 from election_member o where o.election_id = $1 and o.user_id = $3)
        returning m.invited_email, m.role`,
      [electionId, person.email, userId],
    )
    for (const row of bound.rows) {
      await appendAudit(client, electionId, {
        actor: { tid: person.tid, oid: person.oid, name: person.displayName },
        action: 'member.bound',
        metadata: { email: row.invited_email, role: row.role },
      })
    }
  }
}
