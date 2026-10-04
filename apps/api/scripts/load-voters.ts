// A load run of the voter routes against a running server: seeds an
// election through the owner connection, as the test fixtures do, opens
// its round, and drives one voter session per key over HTTP, all at once,
// each redeeming its key and casting one ballot; then reports latencies
// and errors and checks, through the owner connection, that exactly one
// ballot per key is staged and one entitlement per key used up. No
// dependency but pg; CI runs it against the built image. The owner
// connection comes from the environment, as the migrator's does.
//
//   DATABASE_URL=postgres://postgres:...@127.0.0.1:5432/school_election node apps/api/scripts/load-voters.ts --url http://127.0.0.1:3000 --keys 500

import { randomBytes } from 'node:crypto'
import { parseArgs } from 'node:util'
import pg from 'pg'
import { generateKey, KEY_RANDOM_BYTES } from '@school-election/election-core'

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://127.0.0.1:3000' },
    keys: { type: 'string', default: '500' },
    concurrency: { type: 'string', default: '100' },
  },
})
const url = values.url.replace(/\/$/, '')
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  console.error('DATABASE_URL must name the owner connection, as the migrator uses it')
  process.exit(2)
}
const keyCount = Number(values.keys)
const concurrency = Number(values.concurrency)

const owner = new pg.Client({ connectionString: databaseUrl })
await owner.connect()

interface Seeded {
  electionId: string
  boxId: string
  candidateIds: string[]
  keys: string[]
}

/** The election: one contest with three candidates, one class, the keys, the round open. */
async function seed(): Promise<Seeded> {
  const keys = Array.from({ length: keyCount }, () => generateKey(randomBytes(KEY_RANDOM_BYTES)))
  await owner.query('begin')
  const { rows: [election] } = await owner.query<{ id: string }>(`insert into election (title) values ('Lasttest ' || now()::text) returning id`)
  const electionId = election!.id
  const { rows: [contest] } = await owner.query<{ id: string }>(
    `insert into contest (election_id, title, ruleset_id) values ($1, 'Klassensprecher/in', 'at-representative-v1') returning id`, [electionId],
  )
  const { rows: candidates } = await owner.query<{ id: string }>(
    `insert into candidate (election_id, contest_id, surname, given_name)
     values ($1, $2, 'Berger', 'Paula'), ($1, $2, 'Huber', 'Quirin'), ($1, $2, 'Wagner', 'Renate') returning id`,
    [electionId, contest!.id],
  )
  const { rows: [group] } = await owner.query<{ id: string }>(`insert into voter_group (election_id, name) values ($1, '1A') returning id`, [electionId])
  await owner.query('insert into voter_group_contest (election_id, voter_group_id, contest_id) values ($1, $2, $3)', [electionId, group!.id, contest!.id])
  const { rows: [round] } = await owner.query<{ id: string }>(`insert into round (election_id, kind) values ($1, 'regular') returning id`, [electionId])
  const { rows: [box] } = await owner.query<{ id: string }>(
    'insert into round_contest (election_id, round_id, contest_id) values ($1, $2, $3) returning id', [electionId, round!.id, contest!.id],
  )
  await owner.query(`update election set state = 'prepared' where id = $1`, [electionId])
  const { rows: [batch] } = await owner.query<{ id: string }>(
    `insert into credential_batch (election_id, voter_group_id, round_kind) values ($1, $2, 'regular') returning id`, [electionId, group!.id],
  )
  await owner.query('insert into credential (election_id, batch_id, key) select $1, $2, k from unnest($3::text[]) as k', [electionId, batch!.id, keys])
  await owner.query('insert into credential_entitlement (election_id, credential_id, round_contest_id) select election_id, id, $2 from credential where batch_id = $1', [batch!.id, box!.id])
  await owner.query(`update election set state = 'active' where id = $1`, [electionId])
  await owner.query(`update round set state = 'open' where id = $1`, [round!.id])
  await owner.query('commit')
  return { electionId, boxId: box!.id, candidateIds: candidates.map((row) => row.id), keys }
}

interface Outcome {
  ms: number
  error?: string
}

/** One voter: redeems the key, casts a ranking of two of the three candidates, in the order the key's position suggests. */
async function voter(seeded: Seeded, key: string, index: number): Promise<Outcome> {
  const started = performance.now()
  const headers = { 'content-type': 'application/json', 'origin': url, 'sec-fetch-site': 'same-origin' }
  try {
    const session = await fetch(`${url}/api/voter/session`, { method: 'POST', headers, body: JSON.stringify({ key }) })
    if (session.status !== 200) return { ms: performance.now() - started, error: `session ${session.status}` }
    const cookie = session.headers.getSetCookie().map((line) => line.split(';')[0]).join('; ')
    const [a, b, c] = seeded.candidateIds
    const ranking = [[a, b], [b, c], [c, a]][index % 3] ?? []
    const ballot = await fetch(`${url}/api/voter/ballot`, {
      method: 'POST',
      headers: { ...headers, cookie },
      body: JSON.stringify({ roundContestId: seeded.boxId, ballot: { kind: 'ranking', ranking } }),
    })
    if (ballot.status !== 200) return { ms: performance.now() - started, error: `ballot ${ballot.status}` }
    return { ms: performance.now() - started }
  } catch (err) {
    return { ms: performance.now() - started, error: err instanceof Error ? err.message : String(err) }
  }
}

/** One worker: takes the next key, votes, and goes on until the keys are used up. */
async function work(seeded: Seeded, outcomes: Outcome[], next: { index: number }): Promise<void> {
  const index = next.index
  if (index >= seeded.keys.length) return
  next.index += 1
  outcomes[index] = await voter(seeded, seeded.keys[index] ?? '', index)
  await work(seeded, outcomes, next)
}

async function drive(seeded: Seeded): Promise<Outcome[]> {
  const outcomes: Outcome[] = []
  const next = { index: 0 }
  await Promise.all(Array.from({ length: Math.min(concurrency, seeded.keys.length) }, () => work(seeded, outcomes, next)))
  return outcomes
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((x, y) => x - y)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? 0
}

const seeded = await seed()
const started = performance.now()
const outcomes = await drive(seeded)
const elapsed = performance.now() - started
const errors = outcomes.filter((outcome) => outcome.error)
const latencies = outcomes.map((outcome) => outcome.ms)
const { rows: [written] } = await owner.query<{ staged: number, used: number }>(
  `select (select count(*)::int from ballot_box where round_contest_id = $1) as staged,
          (select count(*)::int from credential_entitlement where round_contest_id = $1 and consumed) as used`,
  [seeded.boxId],
)
await owner.end()

console.log(`${keyCount} voters, ${concurrency} at a time: ${Math.round(elapsed)} ms in all, `
  + `p50 ${Math.round(percentile(latencies, 0.5))} ms, p95 ${Math.round(percentile(latencies, 0.95))} ms, max ${Math.round(Math.max(...latencies))} ms; `
  + `${errors.length} errors; ${written?.staged} ballots staged, ${written?.used} entitlements used`)
const byError = new Map<string, number>()
for (const outcome of errors) byError.set(outcome.error ?? '', (byError.get(outcome.error ?? '') ?? 0) + 1)
for (const [error, count] of byError) console.log(`  ${count} × ${error}`)
if (errors.length > 0 || written?.staged !== keyCount || written?.used !== keyCount) {
  console.error('the load run failed')
  process.exit(1)
}
