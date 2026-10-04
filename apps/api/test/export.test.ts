// The export through the API: who takes it and when, what the file is
// (canonical JSON with one digest, which the event records), exactly which
// keys it has, and that nothing in it names a key, a credential, an
// entitlement, a session or an address.

import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { canonicalJson } from '../lib/canonical-json.ts'
import { EXPORT_FORMAT, EXPORT_VERSION, type ExportDocument } from '../lib/export.ts'
import { DB, withClient } from './helpers/db.ts'
import { auditActions } from './helpers/elections.ts'
import { ok, preparedElection, refused, runoffBoxOf, vote, voteByKey, type RouteSetup } from './helpers/round-routes.ts'

const prepared = (t: TestContext): Promise<RouteSetup> => preparedElection(t, {
  contests: [{ title: 'Schulsprecher/in', rulesetId: 'at-school-speaker-v1', candidates: [['Berger', 'Paula'], ['Huber', 'Quirin'], ['Wagner', 'Renate']] }],
  groups: [{ name: '1A', contests: [0], keys: 5, runoffKeys: 3 }, { name: '2B', contests: [0] }],
})

/** The first round voted so that it needs a runoff, closed; the runoff voted and closed: Paula wins it. */
async function wholeElection(x: RouteSetup): Promise<void> {
  ok(await x.anna.request('POST', `${x.base}/rounds/regular/open`))
  const [paula, quirin, renate] = x.contest.candidateIds as [string, string, string]
  const orders = [[paula, quirin, renate], [paula, renate, quirin], [quirin, paula, renate], [quirin, renate, paula], [renate, paula, quirin]]
  for (const [index, order] of orders.entries()) assert.deepEqual(await vote(x, x.credentialIds[index] ?? '', order), { cast: true })
  ok(await x.anna.request('POST', `${x.base}/rounds/regular/close`))
  ok(await x.anna.request('POST', `${x.base}/rounds/runoff/activate`))
  const box = await runoffBoxOf(x, x.contest.id)
  for (const [key, choice] of [[x.runoffKeys['1A']?.[0], paula], [x.runoffKeys['1A']?.[1], paula], [x.runoffKeys['1A']?.[2], quirin]] as const) {
    assert.deepEqual(ok((await voteByKey(x, key ?? '', box, { kind: 'ranking', ranking: [choice] })).cast ?? assert.fail('no ballot')), { done: true, remaining: 0 })
  }
  ok(await x.anna.request('POST', `${x.base}/rounds/runoff/close`))
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

test('every member exports once the regular round has closed and no round is open: the file is canonical JSON with one digest, which the event records', DB, async (t) => {
  const x = await prepared(t)
  for (const by of [x.anna, x.carla, x.wanda]) refused(await by.request('POST', `${x.base}/export`), 409, 'round_planned')
  ok(await x.anna.request('POST', `${x.base}/rounds/regular/open`))
  refused(await x.wanda.request('POST', `${x.base}/export`), 409, 'round_open')
  const [paula, quirin, renate] = x.contest.candidateIds as [string, string, string]
  const orders = [[paula, quirin, renate], [paula, renate, quirin], [quirin, paula, renate], [quirin, renate, paula], [renate, paula, quirin]]
  for (const [index, order] of orders.entries()) assert.deepEqual(await vote(x, x.credentialIds[index] ?? '', order), { cast: true })
  ok(await x.anna.request('POST', `${x.base}/rounds/regular/close`))

  // Between the rounds: the first round's file, by a witness.
  const first = await x.wanda.request('POST', `${x.base}/export`)
  assert.equal(first.statusCode, 200, first.body)
  assert.match(String(first.headers['content-type']), /application\/json/)
  assert.match(String(first.headers['content-disposition']), /attachment; filename="wahl-[0-9a-f-]{36}\.json"/)
  assert.equal(first.headers['cache-control'], 'no-store')
  const document = JSON.parse(first.body) as ExportDocument
  assert.equal(canonicalJson(document), first.body, 'the file is canonical JSON')
  assert.equal(first.headers['x-export-sha256'], sha256(first.body))
  assert.equal(document.format, EXPORT_FORMAT)
  assert.equal(document.version, EXPORT_VERSION)
  assert.deepEqual(document.election.lifecycle, { election: 'active', regular: 'closed', runoff: null })
  assert.deepEqual(document.rounds.map((round) => [round.kind, round.state, round.boxes[0]?.ballots.length]), [['regular', 'closed', 5]])
  assert.equal(document.outcomes[0]?.outcome.kind, 'runoff-required')
  assert.deepEqual((await auditActions(x.anna, x.id)).slice(-1), ['export.generated'])
  const { rows: [event] } = await withClient(x.s.ownerUrl, (client) => client.query<{ metadata: Record<string, unknown> }>(
    `select metadata from audit_event where election_id = $1 and action = 'export.generated'`, [x.id],
  ))
  assert.deepEqual(event?.metadata, { sha256: first.headers['x-export-sha256'], bytes: Buffer.byteLength(first.body, 'utf8') })

  ok(await x.anna.request('POST', `${x.base}/rounds/runoff/activate`))
  refused(await x.carla.request('POST', `${x.base}/export`), 409, 'round_open')
  const box = await runoffBoxOf(x, x.contest.id)
  for (const [key, choice] of [[x.runoffKeys['1A']?.[0], paula], [x.runoffKeys['1A']?.[1], paula], [x.runoffKeys['1A']?.[2], quirin]] as const) {
    ok((await voteByKey(x, key ?? '', box, { kind: 'ranking', ranking: [choice] })).cast ?? assert.fail('no ballot'))
  }
  ok(await x.anna.request('POST', `${x.base}/rounds/runoff/close`))

  // After the runoff: both rounds, the outcome final, and the first export's event in the log.
  const second = await x.carla.request('POST', `${x.base}/export`)
  assert.equal(second.statusCode, 200, second.body)
  const whole = JSON.parse(second.body) as ExportDocument
  assert.deepEqual(whole.rounds.map((round) => [round.kind, round.state, round.boxes[0]?.ballots.length, round.boxes[0]?.runoffPair]), [['regular', 'closed', 5, null], ['runoff', 'closed', 3, [paula, quirin]]])
  assert.deepEqual(whole.snapshots.map((snapshot) => snapshot.round), ['regular', 'runoff'])
  assert.equal(whole.outcomes[0]?.outcome.kind, 'final')
  assert.deepEqual(whole.audit.events.filter((event) => event.action === 'export.generated').map((event) => event.metadata.sha256), [first.headers['x-export-sha256']])
  assert.equal(whole.audit.chain.valid, true)
  assert.notEqual(second.headers['x-export-sha256'], first.headers['x-export-sha256'])
})

test('the file has exactly the keys of the allow-list, ballots without ids in content order, counts for keys and entitlements, and nothing of a key, a credential, a session or an address', DB, async (t) => {
  const x = await prepared(t)
  await wholeElection(x)
  const res = await x.anna.request('POST', `${x.base}/export`)
  const document = JSON.parse(res.body) as ExportDocument
  assert.deepEqual(Object.keys(document).sort(), ['app', 'audit', 'batches', 'contests', 'election', 'exportedAt', 'format', 'lots', 'outcomes', 'rounds', 'snapshots', 'version', 'voterGroups'])
  assert.deepEqual(Object.keys(document.app).sort(), ['gitSha', 'tallyVersion', 'version'])
  assert.deepEqual(Object.keys(document.election).sort(), ['description', 'id', 'lifecycle', 'state', 'title'])
  for (const contest of document.contests) {
    assert.deepEqual(Object.keys(contest).sort(), ['candidates', 'id', 'rulesetId', 'title'])
    for (const candidate of contest.candidates) assert.deepEqual(Object.keys(candidate).sort(), ['givenName', 'id', 'surname'])
  }
  for (const group of document.voterGroups) assert.deepEqual(Object.keys(group).sort(), ['contestIds', 'id', 'name'])
  for (const batch of document.batches) assert.deepEqual(Object.keys(batch).sort(), ['id', 'keys', 'roundKind', 'state', 'voterGroupId'])
  assert.deepEqual(document.batches.map((batch) => [batch.roundKind, batch.state, batch.keys]), [['regular', 'issued', 5], ['runoff', 'issued', 3]])
  for (const round of document.rounds) {
    assert.deepEqual(Object.keys(round).sort(), ['boxes', 'kind', 'state'])
    for (const box of round.boxes) {
      assert.deepEqual(Object.keys(box).sort(), ['ballots', 'contestId', 'entitlements', 'id', 'runoffPair'])
      assert.deepEqual(Object.keys(box.entitlements).sort(), ['issued', 'used'])
      for (const ballot of box.ballots) assert.deepEqual(Object.keys(ballot).sort(), ['kind', 'ranking'])
    }
  }
  for (const snapshot of document.snapshots) assert.deepEqual(Object.keys(snapshot).sort(), ['appVersion', 'contestId', 'gitSha', 'inputSha256', 'outcome', 'result', 'round', 'tallyVersion'])
  for (const lot of document.lots) assert.deepEqual(Object.keys(lot).sort(), ['actorName', 'candidates', 'contestId', 'drawn', 'id', 'lotId', 'reason', 'recordedAt'])
  for (const outcome of document.outcomes) assert.deepEqual(Object.keys(outcome).sort(), ['contestId', 'outcome'])
  assert.deepEqual(Object.keys(document.audit).sort(), ['chain', 'events'])
  for (const event of document.audit.events) assert.deepEqual(Object.keys(event).sort(), ['action', 'actor', 'at', 'electionId', 'hash', 'metadata', 'prevHash', 'seq'])
  // Ballots in content order: the first round's five by the ballot's positions, the runoff's three by the choice.
  const [regular, runoff] = document.rounds
  const [paula, quirin, renate] = x.contest.candidateIds as [string, string, string]
  assert.deepEqual(regular?.boxes[0]?.ballots.map((ballot) => ballot.ranking), [[paula, quirin, renate], [paula, renate, quirin], [quirin, paula, renate], [quirin, renate, paula], [renate, paula, quirin]])
  assert.deepEqual(runoff?.boxes[0]?.ballots.map((ballot) => ballot.ranking), [[paula], [paula], [quirin]])
  assert.deepEqual(regular?.boxes[0]?.entitlements, { issued: 5, used: 5 })
  assert.deepEqual(runoff?.boxes[0]?.entitlements, { issued: 3, used: 3 })
  // Nothing that names a key or a credential: every key of the election is searched for, and every credential id.
  const { rows } = await withClient(x.s.ownerUrl, (client) => client.query<{ key: string, id: string }>('select key, id from credential where election_id = $1', [x.id]))
  for (const secret of [...rows.map((row) => row.key), ...rows.map((row) => row.id), 'consumed', 'credential_id', 'voter-session', '127.0.0.1', 'picture']) {
    assert.ok(!res.body.includes(secret), `the export holds ${secret}`)
  }
})
