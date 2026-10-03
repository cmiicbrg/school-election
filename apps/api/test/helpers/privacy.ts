// The privacy regression: one key entitled to three contests votes in all
// three among at least fifty other voters, interleaved, and afterwards
// nothing in the database tells which three ballots were its. Every test
// of the path from a key to a sealed ballot runs it: at the SQL level
// here, through castBallot, the close route and the voter routes later.
//
// The scenario is seeded as the owner, straight into the tables, so it
// does not depend on the HTTP layer. Votes go through the caster the test
// passes: sqlCaster() casts them as the runtime role with plain SQL, the
// way the application's ballot transaction does, and castBallotCaster()
// through castBallot itself. The assertions read the database as the
// owner, including what the runtime role never sees: the staging table,
// and each row's transaction id (xmin) and position (ctid).

import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import type pg from 'pg'
import { activeSlots, RULESETS, validateBallot, type BallotKind, type Contest, type RulesetId } from '@school-election/election-core'
import { castBallot } from '../../lib/ballot-box.ts'
import type { Database } from '../../lib/db.ts'
import { inOrder } from '../../lib/in-order.ts'
import { createTestDatabase, withClient, type TestDatabase } from './db.ts'

export interface ScenarioContest {
  contestId: string
  boxId: string
  rulesetId: RulesetId
  /** Candidate ids in display order. */
  candidateIds: string[]
  /** How many a ranking fills. */
  slots: number
}

export interface PrivacyScenario extends TestDatabase {
  electionId: string
  roundId: string
  /** Three contests: more than six candidates, three, and one. */
  contests: ScenarioContest[]
  /** Every key's credential id; the tracked one is the first. */
  credentialIds: string[]
  tracked: string
  /**
   * The 32-bit transaction id of every vote, as xmin shows it; filled by
   * the caster. castBallot writes under a savepoint, whose rows carry the
   * subtransaction's id, so the caster records the id its rows carry.
   */
  voteXids: Set<string>
  /** The votes in the order they were cast; filled by voteInterleaved. */
  castOrder: Vote[]
  /** xmin of every credential row at issuance. */
  credentialXmins: Map<string, string>
}

export interface Vote {
  credentialId: string
  boxId: string
  kind: BallotKind
  ranking: string[]
}

/** Casts one vote and records its transaction id in the scenario. */
export type Caster = (vote: Vote) => Promise<void>

const ELECTION = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const GROUP = '2b3c4d5e-6f70-4b8c-9dae-1f2a3b4c5d6e'
const ROUND = '3c4d5e6f-7081-4c9d-8ebf-2a3b4c5d6e7f'
const BATCH = '4d5e6f70-8192-4dae-9fc0-3b4c5d6e7f80'
const CONTESTS: { id: string, boxId: string, title: string, rulesetId: RulesetId, candidates: number }[] = [
  { id: '5e6f7081-92a3-4ebf-8ad1-4c5d6e7f8091', boxId: '8091a2b3-c4d5-41e2-9f03-7f8091a2b3c4', title: 'Schulsprecher/in', rulesetId: 'at-school-speaker-v1', candidates: 7 },
  { id: '6f708192-a3b4-4fc0-9be2-5d6e7f8091a2', boxId: '91a2b3c4-d5e6-42f3-8014-8091a2b3c4d5', title: 'Abteilungssprecher/in', rulesetId: 'at-representative-v1', candidates: 3 },
  { id: '708192a3-b4c5-40d1-8cf3-6e7f8091a2b3', boxId: 'a2b3c4d5-e6f7-4304-9125-91a2b3c4d5e6', title: 'Abstimmung', rulesetId: 'single-choice-v1', candidates: 1 },
]

/**
 * The tracked key, and a segment of every candidate id: values that occur
 * nowhere but in this scenario, so a log that quoted a key, a ranking or a
 * statement would be found by a search for them. CI searches the
 * PostgreSQL container's log for both once the tests have run
 * (.github/workflows/ci.yml).
 */
export const CANARY_KEY = 'CANARYKEY00000000000'
export const CANARY_CANDIDATE_SEGMENT = '0ca0a0a0a0'
const canaryCandidateId = (contest: number, n: number) => `${contest}a0a0a0a-0a0a-4a0a-8a0a-${CANARY_CANDIDATE_SEGMENT}${String(n).padStart(2, '0')}`

/** A normalised key that is no real key: digits only, numbered. */
const fakeKey = (n: number) => String(n).padStart(20, '0')

/**
 * A prepared election with the three contests, one voter group that votes
 * in all of them, the tracked key and `others` more entitled to all three
 * boxes, and the regular round open; made as the owner.
 */
export async function seedPrivacyScenario(t: TestContext, { others = 50 } = {}): Promise<PrivacyScenario> {
  assert.ok(others >= 50, 'the anonymity set is at least fifty other voters')
  const db = await createTestDatabase(t)
  return withClient(db.ownerUrl, async (client) => {
    await client.query('insert into election (id, title) values ($1, $2)', [ELECTION, 'Wahl'])
    await client.query('insert into voter_group (id, election_id, name) values ($1, $2, $3)', [GROUP, ELECTION, '3A'])
    await client.query('insert into round (id, election_id, kind) values ($1, $2, $3)', [ROUND, ELECTION, 'regular'])
    const contests: ScenarioContest[] = []
    await inOrder(CONTESTS.entries(), async ([index, contest]) => {
      await client.query('insert into contest (id, election_id, title, ruleset_id) values ($1, $2, $3, $4)', [contest.id, ELECTION, contest.title, contest.rulesetId])
      const candidateIds = Array.from({ length: contest.candidates }, (_, n) => canaryCandidateId(index, n)).toSorted((a, b) => a.localeCompare(b, 'en'))
      await client.query(
        `insert into candidate (id, election_id, contest_id, surname, given_name)
         select c.id, $1, $2, 'Kandidat ' || c.n, '' from unnest($3::uuid[]) with ordinality as c (id, n)`,
        [ELECTION, contest.id, candidateIds],
      )
      await client.query('insert into voter_group_contest (election_id, voter_group_id, contest_id) values ($1, $2, $3)', [ELECTION, GROUP, contest.id])
      await client.query('insert into round_contest (id, election_id, round_id, contest_id) values ($1, $2, $3, $4)', [contest.boxId, ELECTION, ROUND, contest.id])
      contests.push({ contestId: contest.id, boxId: contest.boxId, rulesetId: contest.rulesetId, candidateIds, slots: activeSlots(RULESETS[contest.rulesetId], candidateIds.length).length })
    })
    await client.query('update election set state = $2 where id = $1', [ELECTION, 'prepared'])
    await client.query('insert into credential_batch (id, election_id, voter_group_id, round_kind) values ($1, $2, $3, $4)', [BATCH, ELECTION, GROUP, 'regular'])
    const { rows: keys } = await client.query<{ id: string, xmin: string }>(
      `insert into credential (election_id, batch_id, key)
       select $1, $2, k.key from unnest($3::text[]) as k (key)
       returning id, xmin::text`,
      [ELECTION, BATCH, [CANARY_KEY, ...Array.from({ length: others }, (_, n) => fakeKey(n + 1))]],
    )
    await client.query(
      `insert into credential_entitlement (election_id, credential_id, round_contest_id)
       select c.election_id, c.id, rc.id from credential c, round_contest rc where c.batch_id = $1 and rc.round_id = $2`,
      [BATCH, ROUND],
    )
    await client.query('update election set state = $2 where id = $1', [ELECTION, 'active'])
    await client.query('update round set state = $2 where id = $1', [ROUND, 'open'])
    const { rows: ordered } = await client.query<{ id: string }>('select id from credential where key = $1', [CANARY_KEY])
    const tracked = ordered[0]?.id ?? assert.fail('the tracked key is missing')
    return {
      ...db,
      electionId: ELECTION,
      roundId: ROUND,
      contests,
      credentialIds: [tracked, ...keys.map((row) => row.id).filter((id) => id !== tracked)],
      tracked,
      voteXids: new Set(),
      castOrder: [],
      credentialXmins: new Map(keys.map((row) => [row.id, row.xmin])),
    }
  })
}

/** A small seeded generator (mulberry32), so the interleaving is the same in every run. */
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const result = [...items]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    const a = result[i] as T
    result[i] = result[j] as T
    result[j] = a
  }
  return result
}

/** The tracked key's three ballots: distinctive, so the assertions can look for them. */
export function trackedVotes(scenario: PrivacyScenario): Vote[] {
  const [speaker, representative, poll] = scenario.contests
  if (!speaker || !representative || !poll) throw new Error('the scenario has three contests')
  return [
    { credentialId: scenario.tracked, boxId: speaker.boxId, kind: 'ranking', ranking: speaker.candidateIds.toReversed().slice(0, speaker.slots) },
    { credentialId: scenario.tracked, boxId: representative.boxId, kind: 'ranking', ranking: representative.candidateIds.toReversed().slice(0, representative.slots) },
    { credentialId: scenario.tracked, boxId: poll.boxId, kind: 'no', ranking: [] },
  ]
}

/**
 * Every voter's ballot in every contest, in one seeded, shuffled order, so
 * the tracked key's three ballots are spread among the others' and the
 * same voter's ballots are not adjacent. Rankings are random complete
 * rankings; in the single-candidate contest a vote is "Ja", "Nein" or
 * invalid.
 */
export function plannedVotes(scenario: PrivacyScenario, seed = 2026): Vote[] {
  const random = seeded(seed)
  const others = scenario.credentialIds.slice(1).flatMap((credentialId) =>
    scenario.contests.map((contest) => randomVote(credentialId, contest, random)))
  return shuffled([...trackedVotes(scenario), ...others], random)
}

/** With one candidate: "Ja", "Nein" or an invalid vote; otherwise a random complete ranking. */
function randomVote(credentialId: string, contest: ScenarioContest, random: () => number): Vote {
  if (contest.candidateIds.length > 1) {
    return { credentialId, boxId: contest.boxId, kind: 'ranking', ranking: shuffled(contest.candidateIds, random).slice(0, contest.slots) }
  }
  const kinds: readonly BallotKind[] = ['no', 'invalid', 'ranking']
  const kind = kinds[Math.floor(random() * kinds.length)] ?? 'ranking'
  return { credentialId, boxId: contest.boxId, kind, ranking: kind === 'ranking' ? [...contest.candidateIds] : [] }
}

/** Casts every planned vote through `cast`, one after the other. */
export async function voteInterleaved(scenario: PrivacyScenario, cast: Caster, seed = 2026): Promise<void> {
  await inOrder(plannedVotes(scenario, seed), async (vote) => {
    await cast(vote)
    scenario.castOrder.push(vote)
  })
}

/** The current transaction's id as xmin will show it: the low 32 bits. */
const XID = 'select (pg_current_xact_id()::text::bigint % 4294967296)::text as xid'

/**
 * Casts a vote as the application's ballot transaction does: one
 * transaction that uses the entitlement up and stages the ballot, as the
 * runtime role, recording the transaction's id as xmin will show it.
 */
export function sqlCaster(client: pg.Client, scenario: PrivacyScenario): Caster {
  return async (vote) => {
    await client.query('begin')
    try {
      const { rows: [xid] } = await client.query<{ xid: string }>(XID)
      scenario.voteXids.add(xid?.xid ?? assert.fail('no transaction id'))
      const used = await client.query(
        'update credential_entitlement set consumed = true where credential_id = $1 and round_contest_id = $2 and not consumed',
        [vote.credentialId, vote.boxId],
      )
      assert.equal(used.rowCount, 1, 'the entitlement was unused')
      await client.query(
        'insert into ballot_box (election_id, round_contest_id, kind, ranking) values ($1, $2, $3, $4::uuid[])',
        [scenario.electionId, vote.boxId, vote.kind, vote.ranking],
      )
      await client.query('commit')
    } catch (err) {
      await client.query('rollback')
      throw err
    }
  }
}

/** What the voter would submit for a planned vote, for election-core to validate. */
function ballotInput(vote: Vote, contest: ScenarioContest): unknown {
  switch (vote.kind) {
    case 'no':
      return { kind: 'no' }
    case 'invalid':
      return { kind: 'ranking', ranking: Array.from({ length: contest.slots }, () => null), confirmInvalid: true }
    case 'ranking':
      return { kind: 'ranking', ranking: vote.ranking }
  }
}

/**
 * Casts a vote through castBallot, the production code, in a transaction
 * of its own from the pool, as the voter route does: the ballot validated
 * by election-core for the contest, as the route validates it.
 */
export function castBallotCaster(db: Database, scenario: PrivacyScenario): Caster {
  return async (vote) => {
    const scenarioContest = scenario.contests.find((contest) => contest.boxId === vote.boxId) ?? assert.fail('no contest for the box')
    const contest: Contest = { id: scenarioContest.contestId, rulesetId: scenarioContest.rulesetId, candidateIds: scenarioContest.candidateIds }
    const validated = validateBallot(contest, ballotInput(vote, scenarioContest))
    assert.ok(validated.ok, `the planned ${vote.kind} vote is a ballot`)
    await db.tx(async (client) => {
      const { rows: [xid] } = await client.query<{ xid: string }>(XID)
      scenario.voteXids.add(xid?.xid ?? assert.fail('no transaction id'))
      const result = await castBallot(client, { credentialId: vote.credentialId, roundContestId: vote.boxId, contest, ballot: validated.ballot })
      assert.deepEqual(result, { cast: true })
      // What the rows castBallot wrote actually carry: the savepoint's id.
      const { rows: [written] } = await client.query<{ xid: string }>(
        'select xmin::text as xid from credential_entitlement where credential_id = $1 and round_contest_id = $2',
        [vote.credentialId, vote.boxId],
      )
      scenario.voteXids.add(written?.xid ?? assert.fail('the entitlement castBallot used up'))
    })
  }
}

/** The five tables of the privacy model and every column each may have. */
export const PRIVACY_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  ballot_box: ['election_id', 'round_contest_id', 'kind', 'ranking'],
  ballot: ['id', 'election_id', 'round_contest_id', 'kind', 'ranking'],
  credential_batch: ['id', 'election_id', 'voter_group_id', 'round_kind', 'state'],
  credential: ['id', 'election_id', 'batch_id', 'key'],
  credential_entitlement: ['election_id', 'credential_id', 'round_contest_id', 'consumed'],
}

/**
 * The schema half of the argument, which holds whatever was voted: the
 * privacy tables have exactly the columns above, nothing links a ballot
 * to anything but its box, and no column numbers or dates a row.
 */
export async function assertPrivacySchema(client: pg.Client): Promise<void> {
  const { rows: columns } = await client.query<{ table_name: string, column_name: string }>(
    `select table_name, column_name from information_schema.columns
      where table_schema = 'public' and table_name = any($1) order by table_name, ordinal_position`,
    [Object.keys(PRIVACY_COLUMNS)],
  )
  const actual = Object.fromEntries(Object.keys(PRIVACY_COLUMNS).map((table) =>
    [table, columns.filter((row) => row.table_name === table).map((row) => row.column_name)]))
  assert.deepEqual(actual, PRIVACY_COLUMNS)

  const { rows: links } = await client.query<{ source: string, target: string }>(
    `select conrelid::regclass::text as source, confrelid::regclass::text as target from pg_constraint
      where contype = 'f' and (conrelid in ('ballot'::regclass, 'ballot_box'::regclass) or confrelid in ('ballot'::regclass, 'ballot_box'::regclass))
      order by 1, 2`,
  )
  // A ballot joins its box and the list of kinds, nothing else.
  assert.deepEqual(links, [
    { source: 'ballot', target: 'ballot_kind' },
    { source: 'ballot', target: 'round_contest' },
    { source: 'ballot_box', target: 'ballot_kind' },
    { source: 'ballot_box', target: 'round_contest' },
  ])

  const { rows: ordering } = await client.query<{ column: string }>(
    `select table_name || '.' || column_name as column from information_schema.columns
      where table_schema = 'public' and table_name = any($1)
        and (data_type like 'timestamp%' or data_type = 'date' or is_identity = 'YES'
             or (column_default is not null and column_default not in ('gen_random_uuid()', 'false', '''issued''::text')))
      order by 1`,
    [Object.keys(PRIVACY_COLUMNS)],
  )
  assert.deepEqual(ordering, [])
}

/** A row's position on disk (its ctid as text), and its rank in the order the seal wrote. */
interface Placed {
  tid: string
  rank: number
}

/** Within every page, the rows (given in ctid order) lie in the order the seal wrote them. */
function assertOrderedWithinPages(rows: readonly Placed[]): void {
  const pages = new Map<string, number[]>()
  for (const row of rows) {
    const [block = ''] = row.tid.replace(/[()]/g, '').split(',')
    pages.set(block, [...(pages.get(block) ?? []), row.rank])
  }
  for (const [block, ranks] of pages) {
    const ascending = ranks.every((rank, index) => index === 0 || rank > (ranks[index - 1] ?? Infinity))
    assert.ok(ascending, `page ${block} holds rows out of the order they were written: ${ranks.join(', ')}`)
  }
}

/**
 * After the seal: nothing in the round's rows tells which ballots one key
 * cast. Read as the owner, who sees everything the database holds.
 */
export async function assertUnlinkable(scenario: PrivacyScenario): Promise<void> {
  const boxes = scenario.contests.map((contest) => contest.boxId)
  await withClient(scenario.ownerUrl, async (client) => {
    await assertPrivacySchema(client)

    const { rows: [round] } = await client.query<{ state: string }>('select state from round where id = $1', [scenario.roundId])
    assert.equal(round?.state, 'closed')
    const { rows: [staged] } = await client.query<{ n: number }>('select count(*)::int as n from ballot_box where round_contest_id = any($1)', [boxes])
    assert.equal(staged?.n, 0, 'nothing stays staged')

    // The ballots' order on disk is the order of their random ids, not of
    // the votes: the seal writes them in id order into a table without
    // dead rows, so within a page they lie in that order; which page a row
    // lands on follows from the rows' sizes (a page that is full for a
    // long row still takes a short one later).
    const ballots = await client.query<Placed>(
      'select b.ctid::text as tid, row_number() over (order by b.id)::int as rank from ballot b where b.round_contest_id = any($1) order by b.ctid', [boxes],
    )
    const expected = scenario.credentialIds.length * boxes.length
    assert.equal(ballots.rows.length, expected, 'every voter cast a ballot in every contest')
    assertOrderedWithinPages(ballots.rows)
    // The entitlements were written again in credential order into the
    // space the votes left behind, among the dead versions written at
    // vote time, so where exactly each lies is PostgreSQL's choice; what
    // the seal guarantees is that the live rows no longer lie in the
    // order the votes used them up, as the versions written at vote time
    // did. Of the pairs of neighbours on disk, next to none were cast one
    // after the other.
    const entitlements = await client.query<{ credential_id: string, round_contest_id: string }>(
      'select credential_id, round_contest_id from credential_entitlement where round_contest_id = any($1) order by ctid', [boxes],
    )
    assert.equal(entitlements.rows.length, expected)
    assert.equal(scenario.castOrder.length, expected, 'the votes were cast through voteInterleaved')
    const castAt = new Map(scenario.castOrder.map((vote, index) => [`${vote.credentialId}/${vote.boxId}`, index]))
    const positions = entitlements.rows.map((row) => castAt.get(`${row.credential_id}/${row.round_contest_id}`) ?? -1)
    const consecutive = positions.filter((position, index) => index > 0 && position === (positions[index - 1] ?? -2) + 1).length
    assert.ok(consecutive <= 5, `${consecutive} neighbouring entitlements on disk were used up one after the other`)

    // Every live row of the round carries the seal's one transaction id, and
    // no vote's; the keys were never touched.
    const { rows: ballotXids } = await client.query<{ xid: string }>('select distinct xmin::text as xid from ballot where round_contest_id = any($1)', [boxes])
    const { rows: entitlementXids } = await client.query<{ xid: string }>('select distinct xmin::text as xid from credential_entitlement where round_contest_id = any($1)', [boxes])
    assert.equal(ballotXids.length, 1)
    assert.deepEqual(entitlementXids, ballotXids)
    assert.ok(scenario.voteXids.size >= expected, 'the caster recorded every vote')
    assert.equal(scenario.voteXids.has(ballotXids[0]?.xid ?? ''), false)
    const { rows: credentials } = await client.query<{ id: string, xmin: string }>('select id, xmin::text from credential where election_id = $1', [scenario.electionId])
    assert.deepEqual(new Map(credentials.map((row) => [row.id, row.xmin])), scenario.credentialXmins)

    // Everything that was voted is there, the tracked key's ballots included,
    // without anything that says which they are.
    const { rows: counts } = await client.query<{ box: string, ballots: number, used: number }>(
      `select rc.id as box, (select count(*) from ballot b where b.round_contest_id = rc.id)::int as ballots,
              (select count(*) from credential_entitlement e where e.round_contest_id = rc.id and e.consumed)::int as used
         from round_contest rc where rc.id = any($1)`,
      [boxes],
    )
    for (const row of counts) assert.equal(row.ballots, row.used, row.box)
    await inOrder(trackedVotes(scenario), async (vote) => {
      const { rowCount } = await client.query('select 1 from ballot where round_contest_id = $1 and kind = $2 and ranking = $3::uuid[]', [vote.boxId, vote.kind, vote.ranking])
      assert.ok((rowCount ?? 0) >= 1, `the tracked ${vote.kind} ballot is in its box`)
    })
  })
}
