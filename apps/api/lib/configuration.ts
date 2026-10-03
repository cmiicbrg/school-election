// The configuration of an election: its contests with their candidates, and
// its voter groups with the contests each one votes in. Each kind of thing
// has its own routes (routes/configuration.ts); every change runs inside
// changeElection, so it holds the election's lock and its audit event
// commits with it. Whether a change is allowed now is the route's lifecycle
// guard; triggers keep the same windows in the database (migration 0007).
//
// Lists come out in one order, computed here and nowhere else: contests by
// title, voter groups by name, candidates by surname and given name
// (lib/names.ts).

import type pg from 'pg'
import { activeSlots, RULESETS, type RulesetId } from '@school-election/election-core'
import { appendAudit } from './audit.ts'
import type { Database } from './db.ts'
import { Refusal, type ElectionAccess } from './election-access.ts'
import { cleanName, compareCandidates, compareLabels, sameCandidateName, type CandidateName } from './names.ts'
import { pictureUrl, type StoredPicture } from './pictures.ts'

export interface Candidate {
  id: string
  surname: string
  givenName: string
  /** Where its picture is served, or null without one. The URL changes with the picture. */
  picture: string | null
}

export interface Contest {
  id: string
  title: string
  rulesetId: RulesetId
  /** The ballot's slots: min(candidates, the ruleset's slots). */
  activeSlots: number
  /** In ballot order. */
  candidates: Candidate[]
}

export interface VoterGroup {
  id: string
  name: string
  /** The contests its voters vote in, in contest order. */
  contestIds: string[]
}

export interface Configuration {
  contests: Contest[]
  voterGroups: VoterGroup[]
}

type Queryable = Pick<Database, 'query'>

interface ContestRow {
  id: string
  title: string
  ruleset_id: RulesetId
}

interface CandidateRow {
  id: string
  contest_id: string
  surname: string
  given_name: string
  picture_sha256: string | null
}

/**
 * The whole configuration. Its queries must see one state: inside
 * changeElection the election's lock keeps it still, otherwise the caller
 * runs this in a repeatable-read transaction.
 */
export async function readConfiguration(db: Queryable, electionId: string): Promise<Configuration> {
  const contests = await db.query<ContestRow>('select id, title, ruleset_id from contest where election_id = $1', [electionId])
  const candidates = await db.query<CandidateRow>(
    'select id, contest_id, surname, given_name, picture_sha256 from candidate where election_id = $1',
    [electionId],
  )
  const groups = await db.query<{ id: string, name: string }>('select id, name from voter_group where election_id = $1', [electionId])
  const mapping = await db.query<{ voter_group_id: string, contest_id: string }>(
    'select voter_group_id, contest_id from voter_group_contest where election_id = $1',
    [electionId],
  )
  const ordered = sortedContests(contests.rows)
  const position = new Map(ordered.map((contest, index) => [contest.id, index]))
  return {
    contests: ordered.map((contest) => toContest(electionId, contest, candidates.rows.filter((row) => row.contest_id === contest.id))),
    voterGroups: groups.rows
      .toSorted((a, b) => compareLabels(a.name, b.name) || compareIds(a.id, b.id))
      .map((group) => ({
        id: group.id,
        name: group.name,
        contestIds: mapping.rows
          .filter((row) => row.voter_group_id === group.id)
          .map((row) => row.contest_id)
          .toSorted((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0)),
      })),
  }
}

/** One contest with its candidates, in ballot order. */
export async function readContest(db: Queryable, electionId: string, contestId: string): Promise<Contest> {
  const contest = await db.query<ContestRow>('select id, title, ruleset_id from contest where id = $1 and election_id = $2', [contestId, electionId])
  const row = contest.rows[0]
  if (!row) throw new Refusal(404, 'not_found')
  const candidates = await db.query<CandidateRow>(
    'select id, contest_id, surname, given_name, picture_sha256 from candidate where contest_id = $1',
    [contestId],
  )
  return toContest(electionId, row, candidates.rows)
}

/** One voter group with its contests, in contest order. */
export async function readVoterGroup(db: Queryable, electionId: string, groupId: string): Promise<VoterGroup> {
  const group = await db.query<{ id: string, name: string }>('select id, name from voter_group where id = $1 and election_id = $2', [groupId, electionId])
  const row = group.rows[0]
  if (!row) throw new Refusal(404, 'not_found')
  const contests = await db.query<ContestRow>(
    `select c.id, c.title, c.ruleset_id from voter_group_contest m join contest c on c.id = m.contest_id
      where m.voter_group_id = $1`,
    [groupId],
  )
  return { id: row.id, name: row.name, contestIds: sortedContests(contests.rows).map((contest) => contest.id) }
}

function sortedContests(rows: ContestRow[]): ContestRow[] {
  return rows.toSorted((a, b) => compareLabels(a.title, b.title) || compareIds(a.id, b.id))
}

// Only for rows whose labels compare equal, which the duplicate checks
// leave to contests and groups whose labels differ in ways the collation
// ignores; candidates never get here.
function compareIds(a: string, b: string): number {
  if (a < b) return -1
  return a > b ? 1 : 0
}

function toContest(electionId: string, contest: ContestRow, candidates: CandidateRow[]): Contest {
  const listed = candidates
    .map((row) => ({
      id: row.id,
      surname: row.surname,
      givenName: row.given_name,
      picture: row.picture_sha256 === null ? null : pictureUrl(electionId, row.id, row.picture_sha256),
    }))
    .toSorted(compareCandidates)
  return {
    id: contest.id,
    title: contest.title,
    rulesetId: contest.ruleset_id,
    activeSlots: listed.length === 0 ? 0 : activeSlots(RULESETS[contest.ruleset_id], listed.length).length,
    candidates: listed,
  }
}

// --- contests ---------------------------------------------------------------

export interface ContestInput {
  title: string
  rulesetId: RulesetId
}

export async function createContest(client: pg.ClientBase, access: ElectionAccess, input: ContestInput): Promise<Contest> {
  const title = cleanName(input.title)
  await refuseTakenLabel(client, 'contest', access.electionId, title, null)
  const { rows: [row] } = await client.query<{ id: string }>(
    'insert into contest (election_id, title, ruleset_id) values ($1, $2, $3) returning id',
    [access.electionId, title, input.rulesetId],
  )
  if (!row) throw new Error('contest insert returned no row')
  await appendAudit(client, access.electionId, {
    actor: access.actor,
    action: 'contest.created',
    metadata: { contest: row.id, title, rulesetId: input.rulesetId },
  })
  return { id: row.id, title, rulesetId: input.rulesetId, activeSlots: 0, candidates: [] }
}

export async function updateContest(client: pg.ClientBase, access: ElectionAccess, contestId: string, input: Partial<ContestInput>): Promise<Contest> {
  const current = await readContest(client, access.electionId, contestId)
  const title = input.title === undefined ? current.title : cleanName(input.title)
  const rulesetId = input.rulesetId ?? current.rulesetId
  if (title === current.title && rulesetId === current.rulesetId) return current
  await refuseTakenLabel(client, 'contest', access.electionId, title, contestId)
  await client.query('update contest set title = $2, ruleset_id = $3 where id = $1', [contestId, title, rulesetId])
  await appendAudit(client, access.electionId, { actor: access.actor, action: 'contest.updated', metadata: { contest: contestId, title, rulesetId } })
  return readContest(client, access.electionId, contestId)
}

/** Removes a contest with its candidates, its ballot boxes and its place in every voter group. */
export async function removeContest(client: pg.ClientBase, access: ElectionAccess, contestId: string): Promise<void> {
  const current = await readContest(client, access.electionId, contestId)
  await client.query('delete from contest where id = $1', [contestId])
  await appendAudit(client, access.electionId, {
    actor: access.actor,
    action: 'contest.removed',
    metadata: { contest: contestId, title: current.title, candidates: current.candidates.length },
  })
}

// --- candidates -------------------------------------------------------------

export interface CandidateInput {
  surname: string
  givenName: string
}

function cleanCandidateName(input: CandidateInput): CandidateName {
  return { surname: cleanName(input.surname), givenName: cleanName(input.givenName) }
}

/** Refuses a name that compares equal to another candidate's in the contest (409 duplicate_candidate). */
function refuseTakenName(contest: Contest, name: CandidateName, except: string | null): void {
  if (contest.candidates.some((candidate) => candidate.id !== except && sameCandidateName(candidate, name))) {
    throw new Refusal(409, 'duplicate_candidate')
  }
}

export async function addCandidate(client: pg.ClientBase, access: ElectionAccess, contestId: string, input: CandidateInput): Promise<Contest> {
  const contest = await readContest(client, access.electionId, contestId)
  const name = cleanCandidateName(input)
  refuseTakenName(contest, name, null)
  const { rows: [row] } = await client.query<{ id: string }>(
    'insert into candidate (election_id, contest_id, surname, given_name) values ($1, $2, $3, $4) returning id',
    [access.electionId, contestId, name.surname, name.givenName],
  )
  if (!row) throw new Error('candidate insert returned no row')
  await appendAudit(client, access.electionId, {
    actor: access.actor,
    action: 'candidate.added',
    metadata: { contest: contestId, candidate: row.id, ...name },
  })
  return readContest(client, access.electionId, contestId)
}

interface CandidateLookup {
  contestId: string
  current: Candidate
  contest: Contest
}

async function findCandidate(client: pg.ClientBase, electionId: string, candidateId: string): Promise<CandidateLookup> {
  const { rows: [row] } = await client.query<{ contest_id: string }>(
    'select contest_id from candidate where id = $1 and election_id = $2',
    [candidateId, electionId],
  )
  if (!row) throw new Refusal(404, 'not_found')
  const contest = await readContest(client, electionId, row.contest_id)
  const current = contest.candidates.find((candidate) => candidate.id === candidateId)
  if (!current) throw new Error('a candidate the lookup found is not in its contest')
  return { contestId: row.contest_id, current, contest }
}

/** Corrects a candidate's name; possible until voting starts, so a misspelled name never forces a reprint. */
export async function renameCandidate(client: pg.ClientBase, access: ElectionAccess, candidateId: string, input: Partial<CandidateInput>): Promise<Contest> {
  const { contestId, current, contest } = await findCandidate(client, access.electionId, candidateId)
  const name = cleanCandidateName({ surname: input.surname ?? current.surname, givenName: input.givenName ?? current.givenName })
  if (name.surname === current.surname && name.givenName === current.givenName) return contest
  refuseTakenName(contest, name, candidateId)
  await client.query('update candidate set surname = $2, given_name = $3 where id = $1', [candidateId, name.surname, name.givenName])
  await appendAudit(client, access.electionId, { actor: access.actor, action: 'candidate.renamed', metadata: { candidate: candidateId, ...name } })
  return readContest(client, access.electionId, contestId)
}

export async function removeCandidate(client: pg.ClientBase, access: ElectionAccess, candidateId: string): Promise<Contest> {
  const { contestId, current } = await findCandidate(client, access.electionId, candidateId)
  await client.query('delete from candidate where id = $1', [candidateId])
  await appendAudit(client, access.electionId, {
    actor: access.actor,
    action: 'candidate.removed',
    metadata: { candidate: candidateId, surname: current.surname, givenName: current.givenName },
  })
  return readContest(client, access.electionId, contestId)
}

/** Stores a picture that normalizePicture() produced; the same picture again changes nothing. */
export async function setCandidatePicture(client: pg.ClientBase, access: ElectionAccess, candidateId: string, picture: StoredPicture): Promise<Contest> {
  const { contestId, current, contest } = await findCandidate(client, access.electionId, candidateId)
  if (current.picture === pictureUrl(access.electionId, candidateId, picture.sha256)) return contest
  await client.query('update candidate set picture = $2, picture_sha256 = $3 where id = $1', [candidateId, picture.data, picture.sha256])
  await appendAudit(client, access.electionId, { actor: access.actor, action: 'candidate.picture-set', metadata: { candidate: candidateId, sha256: picture.sha256 } })
  return readContest(client, access.electionId, contestId)
}

export async function removeCandidatePicture(client: pg.ClientBase, access: ElectionAccess, candidateId: string): Promise<Contest> {
  const { contestId, current, contest } = await findCandidate(client, access.electionId, candidateId)
  if (current.picture === null) return contest
  await client.query('update candidate set picture = null, picture_sha256 = null where id = $1', [candidateId])
  await appendAudit(client, access.electionId, { actor: access.actor, action: 'candidate.picture-removed', metadata: { candidate: candidateId } })
  return readContest(client, access.electionId, contestId)
}

// --- voter groups -----------------------------------------------------------

export async function createVoterGroup(client: pg.ClientBase, access: ElectionAccess, input: { name: string }): Promise<VoterGroup> {
  const name = cleanName(input.name)
  await refuseTakenLabel(client, 'voterGroup', access.electionId, name, null)
  const { rows: [row] } = await client.query<{ id: string }>(
    'insert into voter_group (election_id, name) values ($1, $2) returning id',
    [access.electionId, name],
  )
  if (!row) throw new Error('voter_group insert returned no row')
  await appendAudit(client, access.electionId, { actor: access.actor, action: 'voter-group.created', metadata: { group: row.id, name } })
  return { id: row.id, name, contestIds: [] }
}

export async function renameVoterGroup(client: pg.ClientBase, access: ElectionAccess, groupId: string, input: { name: string }): Promise<VoterGroup> {
  const current = await readVoterGroup(client, access.electionId, groupId)
  const name = cleanName(input.name)
  if (name === current.name) return current
  await refuseTakenLabel(client, 'voterGroup', access.electionId, name, groupId)
  await client.query('update voter_group set name = $2 where id = $1', [groupId, name])
  await appendAudit(client, access.electionId, { actor: access.actor, action: 'voter-group.renamed', metadata: { group: groupId, name } })
  return { ...current, name }
}

/** Removes a voter group with its mapping. */
export async function removeVoterGroup(client: pg.ClientBase, access: ElectionAccess, groupId: string): Promise<void> {
  const current = await readVoterGroup(client, access.electionId, groupId)
  await client.query('delete from voter_group where id = $1', [groupId])
  await appendAudit(client, access.electionId, { actor: access.actor, action: 'voter-group.removed', metadata: { group: groupId, name: current.name } })
}

/**
 * Sets the contests a voter group votes in. Each link added or removed is
 * one audit event; contests of another election, or none at all, are
 * refused (422 unknown_contest).
 */
export async function setVoterGroupContests(client: pg.ClientBase, access: ElectionAccess, groupId: string, contestIds: readonly string[]): Promise<VoterGroup> {
  const current = await readVoterGroup(client, access.electionId, groupId)
  const wanted = new Set(contestIds.map((id) => id.toLowerCase()))
  const known = await client.query<{ id: string }>('select id from contest where election_id = $1 and id = any($2::uuid[])', [access.electionId, [...wanted]])
  if (known.rows.length !== wanted.size) throw new Refusal(422, 'unknown_contest')
  const added = [...wanted].filter((id) => !current.contestIds.includes(id))
  const removed = current.contestIds.filter((id) => !wanted.has(id))
  if (added.length > 0) {
    await client.query(
      'insert into voter_group_contest (election_id, voter_group_id, contest_id) select $1, $2, unnest($3::uuid[])',
      [access.electionId, groupId, added],
    )
  }
  if (removed.length > 0) {
    await client.query('delete from voter_group_contest where voter_group_id = $1 and contest_id = any($2::uuid[])', [groupId, removed])
  }
  for (const [ids, action] of [[added, 'voter-group.contest-added'], [removed, 'voter-group.contest-removed']] as const) {
    for (const contest of ids) {
      await appendAudit(client, access.electionId, { actor: access.actor, action, metadata: { group: groupId, contest } })
    }
  }
  return readVoterGroup(client, access.electionId, groupId)
}

/**
 * Refuses a contest title or voter group name that compares equal to
 * another one's in the election, ignoring case (409 duplicate_title or
 * duplicate_name).
 */
async function refuseTakenLabel(
  client: pg.ClientBase,
  kind: keyof typeof LABELS,
  electionId: string,
  label: string,
  except: string | null,
): Promise<void> {
  const { rows } = await client.query<{ id: string, label: string }>(LABELS[kind].query, [electionId])
  if (rows.some((row) => row.id !== except && compareLabels(row.label, label) === 0)) {
    throw new Refusal(409, LABELS[kind].refusal)
  }
}

const LABELS = {
  contest: { query: 'select id, title as label from contest where election_id = $1', refusal: 'duplicate_title' },
  voterGroup: { query: 'select id, name as label from voter_group where election_id = $1', refusal: 'duplicate_name' },
} as const
