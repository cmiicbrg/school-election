// The guard every /api/elections/:id route passes, as its first onRequest
// hook: requireElectionAccess(db, action[, lifecycle guard]). It runs
// before the body is read and checks, in this order:
//
//   1. a signed-in caller (401);
//   2. membership, looked up on every request: an id that names no
//      election, or one the caller is not a bound member of, is 404, so
//      guessing ids reveals nothing and a removed member loses access with
//      the next request;
//   3. the caller's role permits the action (403, lib/permissions.ts);
//   4. the lifecycle allows it in the election's current state (409, with
//      the lifecycle's refusal as the error code).
//
// A change runs through changeElection(), which takes the election's lock
// and checks all of it again inside its transaction, so a member removed
// or a state changed meanwhile stops the change instead of slipping past.
// app.ts refuses to register an election route without the guard. No
// other route can match an election path: the segment after /api/ is
// static in every route (test/authz.test.ts keeps it so), and the router
// prefers a static segment over a parameter or a wildcard.

import type { FastifyReply, FastifyRequest, RouteOptions } from 'fastify'
import type pg from 'pg'
import { isConsistentLifecycle, transition, type ElectionState, type Lifecycle, type LifecycleAction, type RoundState, type Verdict } from '@school-election/election-core'
import { boundedName } from './app-user.ts'
import type { AuditActor } from './audit-chain.ts'
import { lockElection } from './audit.ts'
import { authenticate, callerOf } from './auth.ts'
import type { Database } from './db.ts'
import { isPermitted, type ElectionAction, type ElectionRole } from './permissions.ts'

/** Whether the lifecycle allows the action now, e.g. canManageMembers. */
export type LifecycleGuard = (lifecycle: Lifecycle) => Verdict

/** The guard of a route that changes the election's state: whatever transition() says about the action. */
export function canTransition(action: LifecycleAction): LifecycleGuard {
  return (lifecycle) => {
    const next = transition(lifecycle, action)
    return next.ok ? { ok: true } : next
  }
}

/** What the guard established about the caller and the election. */
export interface ElectionAccess {
  electionId: string
  role: ElectionRole
  lifecycle: Lifecycle
  /** The caller, as the audit log names them. */
  actor: AuditActor
}

/**
 * A refused request. Thrown inside a transaction it rolls the transaction
 * back, and the error handler answers with the status and the code.
 */
export class Refusal extends Error {
  override name = 'Refusal'
  readonly statusCode: number
  readonly code: string

  constructor(statusCode: number, code: string) {
    super(code)
    this.statusCode = statusCode
    this.code = code
  }
}

export type ElectionGuard = (request: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply | undefined>

interface Check {
  action: ElectionAction
  guard: LifecycleGuard | undefined
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// The hooks requireElectionAccess made, and what each let through, per request.
const guards = new WeakSet<object>()
const granted = new WeakMap<FastifyRequest, { check: Check, access: ElectionAccess }>()

/**
 * The onRequest guard of an election route. Reading needs no lifecycle
 * guard; every other action names the one that applies to it.
 */
export function requireElectionAccess(db: Database, action: 'view'): ElectionGuard
export function requireElectionAccess(db: Database, action: ElectionAction, guard: LifecycleGuard): ElectionGuard
export function requireElectionAccess(db: Database, action: ElectionAction, guard?: LifecycleGuard): ElectionGuard {
  const check: Check = { action, guard }
  // An async hook that answers returns the reply, and Fastify stops there.
  const hook: ElectionGuard = async (request, reply) => {
    const user = authenticate(request)
    if (!user) return reply.code(401).send({ error: 'unauthenticated' })
    try {
      granted.set(request, { check, access: await evaluate(db, electionIdOf(request), user.id, check) })
    } catch (err) {
      if (!(err instanceof Refusal)) throw err
      return reply.code(err.statusCode).send({ error: err.code })
    }
    return undefined
  }
  guards.add(hook)
  return hook
}

/** For handlers behind requireElectionAccess: what the guard established. */
export function electionAccessOf(request: FastifyRequest): ElectionAccess {
  const entry = granted.get(request)
  if (!entry) throw new Error('electionAccessOf() used on a route without requireElectionAccess')
  return entry.access
}

/**
 * Runs a change to the election in one transaction: takes the election's
 * lock, checks the caller's access again exactly as the route's guard did,
 * then calls fn with the current access. The change and its audit event
 * commit together, or neither does.
 */
export async function changeElection<T>(
  db: Database,
  request: FastifyRequest,
  fn: (client: pg.PoolClient, access: ElectionAccess) => Promise<T>,
): Promise<T> {
  const entry = granted.get(request)
  if (!entry) throw new Error('changeElection() used on a route without requireElectionAccess')
  const { check, access } = entry
  return db.tx(async (client) => {
    await lockElection(client, access.electionId)
    return fn(client, await evaluate(client, access.electionId, callerOf(request).id, check))
  })
}

interface AccessRow {
  state: ElectionState
  regular: RoundState | null
  runoff: RoundState | null
  role: ElectionRole
  tid: string
  oid: string
  display_name: string
}

/**
 * The states of an election's rounds, as stored, read with the election
 * `e` by two joins: select ROUND_STATE_COLUMNS, from `election e` with
 * ROUND_STATE_JOINS; null where the round does not exist.
 */
export const ROUND_STATE_COLUMNS = 'regular.state as regular, runoff.state as runoff'
export const ROUND_STATE_JOINS = `left join round regular on regular.election_id = e.id and regular.kind = 'regular'
       left join round runoff on runoff.election_id = e.id and runoff.kind = 'runoff'`

async function evaluate(db: Pick<Database, 'query'>, id: unknown, userId: string, check: Check): Promise<ElectionAccess> {
  if (typeof id !== 'string' || !UUID.test(id)) throw new Refusal(404, 'not_found')
  const electionId = id.toLowerCase()
  const { rows } = await db.query<AccessRow>(
    `select e.state, m.role, u.tid, u.oid, u.display_name, ${ROUND_STATE_COLUMNS}
       from election_member m
       join election e on e.id = m.election_id
       join app_user u on u.id = m.user_id
       ${ROUND_STATE_JOINS}
      where m.election_id = $1 and m.user_id = $2`,
    [electionId, userId],
  )
  const row = rows[0]
  if (!row) throw new Refusal(404, 'not_found')
  if (!isPermitted(row.role, check.action)) throw new Refusal(403, 'forbidden')
  const lifecycle = lifecycleOf(row.state, row)
  const verdict = check.guard?.(lifecycle)
  if (verdict && !verdict.ok) throw new Refusal(409, verdict.refusal.replaceAll('-', '_'))
  return { electionId, role: row.role, lifecycle, actor: { tid: row.tid, oid: row.oid, name: boundedName(row.display_name) ?? row.oid } }
}

function electionIdOf(request: FastifyRequest): unknown {
  return (request.params as Record<string, unknown> | undefined)?.id
}

/**
 * The lifecycle of an election from its stored states: the election's and
 * its rounds' (ROUND_STATE_COLUMNS). A regular round that does not exist yet
 * is a planned one; a runoff round that does not exist is none. States
 * that do not form a lifecycle (the application writes none) are a wiring
 * error, never a user error.
 */
export function lifecycleOf(election: ElectionState, rounds: { regular: RoundState | null, runoff: RoundState | null }): Lifecycle {
  const lifecycle = { election, regular: rounds.regular ?? 'planned', runoff: rounds.runoff } as Lifecycle
  if (!isConsistentLifecycle(lifecycle)) throw new Error(`the stored states do not form a lifecycle: ${JSON.stringify(lifecycle)}`)
  return lifecycle
}

const ELECTION_PATH = '/api/elections/'

/**
 * An onRoute hook (app.ts): every route below /api/elections/ must address
 * the election as :id and start with requireElectionAccess, or the app does
 * not start.
 */
export function assertElectionGuard(route: RouteOptions): void {
  // Everything below /api/elections/, the bare /api/elections/ included.
  if (!route.url.startsWith(ELECTION_PATH)) return
  const first: unknown = [route.onRequest ?? []].flat()[0]
  const addressed = route.url === '/api/elections/:id' || route.url.startsWith('/api/elections/:id/')
  if (!addressed || typeof first !== 'function' || !guards.has(first)) {
    throw new Error(`${String(route.method)} ${route.url} must address the election as :id and start with requireElectionAccess`)
  }
}
