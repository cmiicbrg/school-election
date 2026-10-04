// The offline verifier: a genuine export passes every check, each
// tampering fails the check it breaks and names what differs, and the
// script runs on a file with no database and no server.

import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { ExportDocument } from '../lib/export-format.ts'
import { verifyExport, type Report } from '../lib/export-verify.ts'
import { DB } from './helpers/db.ts'
import { ok, preparedElection, runoffBoxOf, vote, voteByKey, type RouteSetup } from './helpers/round-routes.ts'

const prepared = (t: TestContext): Promise<RouteSetup> => preparedElection(t, {
  contests: [{ title: 'Schulsprecher/in', rulesetId: 'at-school-speaker-v1', candidates: [['Berger', 'Paula'], ['Huber', 'Quirin'], ['Wagner', 'Renate']] }],
  groups: [{ name: '1A', contests: [0], keys: 4, runoffKeys: 3 }],
})

interface Outcome {
  kind: string
  lots?: { id: string }[]
}

/** The lots flow of lots.test.ts: a lot for the runoff entry, the runoff, a lot for the deputies; the export afterwards. */
async function exportedElection(x: RouteSetup): Promise<{ text: string, document: ExportDocument }> {
  ok(await x.anna.request('POST', `${x.base}/rounds/regular/open`))
  const [paula, quirin, renate] = x.contest.candidateIds as [string, string, string]
  for (const [index, order] of [[paula, quirin, renate], [paula, renate, quirin], [quirin, renate, paula], [renate, quirin, paula]].entries()) {
    assert.deepEqual(await vote(x, x.credentialIds[index] ?? '', order), { cast: true })
  }
  ok(await x.anna.request('POST', `${x.base}/rounds/regular/close`))
  const outcomeOf = async (): Promise<Outcome> => ok<{ contests: { outcome: Outcome }[] }>(await x.anna.request('GET', `${x.base}/result`)).contests[0]?.outcome ?? assert.fail('no outcome')
  const entryLot = (await outcomeOf()).lots?.[0] ?? assert.fail('no entry lot')
  ok(await x.anna.request('POST', `${x.base}/lots`, { contestId: x.contest.id, lotId: entryLot.id, order: [renate, quirin], reason: 'Los am Nachmittag' }))
  ok(await x.anna.request('POST', `${x.base}/rounds/runoff/activate`))
  const box = await runoffBoxOf(x, x.contest.id)
  for (const [key, choice] of [[x.runoffKeys['1A']?.[0], renate], [x.runoffKeys['1A']?.[1], renate], [x.runoffKeys['1A']?.[2], paula]] as const) {
    ok((await voteByKey(x, key ?? '', box, { kind: 'ranking', ranking: [choice] })).cast ?? assert.fail('no ballot'))
  }
  ok(await x.anna.request('POST', `${x.base}/rounds/runoff/close`))
  const positionsLot = (await outcomeOf()).lots?.[0] ?? assert.fail('no positions lot')
  ok(await x.anna.request('POST', `${x.base}/lots`, { contestId: x.contest.id, lotId: positionsLot.id, order: [quirin, paula], reason: 'Zweites Los' }))
  const res = await x.wanda.request('POST', `${x.base}/export`)
  assert.equal(res.statusCode, 200, res.body)
  return { text: res.body, document: JSON.parse(res.body) as ExportDocument }
}

const failed = (report: Report): string[] => report.checks.filter((check) => !check.ok).map((check) => check.name)
const clone = (document: ExportDocument): ExportDocument => JSON.parse(JSON.stringify(document)) as ExportDocument

test('a genuine export passes every check, and the report names them', DB, async (t) => {
  const x = await prepared(t)
  const { document } = await exportedElection(x)
  const report = verifyExport(document)
  assert.deepEqual(report.checks.filter((check) => !check.ok), [])
  assert.equal(report.ok, true)
  const names = report.checks.map((check) => check.name)
  for (const expected of [
    'format', 'ballots: regular round, Schulsprecher/in', 'digest: regular round, Schulsprecher/in', 'result: regular round, Schulsprecher/in', 'outcome at close: regular round, Schulsprecher/in',
    'ballots: runoff round, Schulsprecher/in', 'digest: runoff round, Schulsprecher/in', 'result: runoff round, Schulsprecher/in', 'outcome at close: runoff round, Schulsprecher/in',
    'rows: regular round, Schulsprecher/in', 'order: regular round, Schulsprecher/in', 'snapshots: one per box',
    'outcome: Schulsprecher/in', 'outcomes: one per contest', 'audit chain of this election', 'audit chain', 'audit chain as exported',
    'event for the close of the regular round', 'event for the close of the runoff round', 'event for the activation of the runoff',
    'event for the result: regular round, Schulsprecher/in', 'event for the result: runoff round, Schulsprecher/in', 'no key', 'finalization', 'lifecycle',
  ]) {
    assert.ok(names.includes(expected), `${expected} among ${names.join('; ')}`)
  }
  assert.match(report.checks.find((check) => check.name === 'finalization')?.detail ?? '', /^not final/)
  assert.equal(names.filter((name) => name.startsWith('lot ')).length, 2, 'both lots against their events')
  assert.equal(names.filter((name) => /^event \d+ lot\.recorded/.test(name)).length, 2, 'both events against their lots')
  assert.equal(names.filter((name) => name.startsWith('batch ')).length, 2, 'both batches against their events')
  assert.ok(names.some((name) => /result\.computed: Schulsprecher/.test(name)))
  assert.ok(names.some((name) => /round\.closed: runoff/.test(name)))
  assert.ok(names.some((name) => /runoff\.pair: Schulsprecher/.test(name)))
  assert.equal(report.checks.find((check) => check.name === 'outcome: Schulsprecher/in')?.detail, 'final')
  assert.equal(report.checks.find((check) => check.name === 'outcome at close: runoff round, Schulsprecher/in')?.detail, 'lot-required', 'as it stood before the second lot')
})

test('each tampering fails the check it breaks, with what differs', DB, async (t) => {
  const x = await prepared(t)
  const { document } = await exportedElection(x)
  const [paula, quirin] = x.contest.candidateIds as [string, string]

  const ballot = clone(document)
  const first = ballot.rounds[0]?.boxes[0]?.ballots[0] ?? assert.fail('a ballot')
  first.ranking = [first.ranking[1] ?? '', first.ranking[0] ?? '', first.ranking[2] ?? '']
  const ballotReport = verifyExport(ballot)
  assert.ok(failed(ballotReport).includes('digest: regular round, Schulsprecher/in'), failed(ballotReport).join('; '))
  assert.match(ballotReport.checks.find((check) => check.name === 'digest: regular round, Schulsprecher/in')?.detail ?? '', /recomputed [0-9a-f]{64}, the snapshot says/)

  const snapshot = clone(document)
  const stored = snapshot.snapshots[0]?.result as { statistics: { candidates: { points: number }[] } }
  stored.statistics.candidates[0]!.points += 1
  assert.deepEqual(failed(verifyExport(snapshot)).filter((name) => name.startsWith('result:')), ['result: regular round, Schulsprecher/in'])

  const lot = clone(document)
  const second = lot.lots[1] ?? assert.fail('the positions lot')
  second.drawn = [paula, quirin]
  const lotReport = verifyExport(lot)
  assert.ok(failed(lotReport).includes('outcome: Schulsprecher/in'), 'the outcome as it stands no longer resolves to the file\'s')
  assert.ok(failed(lotReport).some((name) => name.startsWith(`lot ${second.lotId}`)), 'the event records another order')

  const audit = clone(document)
  const event = audit.audit.events[2] ?? assert.fail('an event')
  event.metadata = { ...event.metadata, title: 'Anders' }
  const chainReport = verifyExport(audit)
  assert.equal(chainReport.checks.find((check) => check.name === 'audit chain')?.ok, false)
  assert.match(chainReport.checks.find((check) => check.name === 'audit chain')?.detail ?? '', /broken at event 2: hash-mismatch/)

  const counts = clone(document)
  const box = counts.rounds[0]?.boxes[0] ?? assert.fail('a box')
  box.entitlements.used = 3
  assert.ok(failed(verifyExport(counts)).includes('ballots: regular round, Schulsprecher/in'))

  const version = clone(document) as unknown as { version: number }
  version.version = 1
  const formatReport = verifyExport(version)
  assert.deepEqual(formatReport.checks.map((check) => [check.name, check.ok]), [['format', false]])
  assert.match(formatReport.checks[0]?.detail ?? '', /version 1/)

  assert.equal(verifyExport('not an object').ok, false)
  assert.equal(verifyExport(null).ok, false)

  // The audit history stripped: the chain of nothing is no chain, and the events the rounds imply are missing.
  const stripped = clone(document)
  stripped.audit.events = []
  const strippedReport = verifyExport(stripped)
  assert.ok(failed(strippedReport).includes('audit chain'))
  assert.ok(failed(strippedReport).includes('audit chain as exported'))
  assert.ok(failed(strippedReport).includes('event for the close of the regular round'))
  assert.ok(failed(strippedReport).includes('event for the activation of the runoff'))
  assert.ok(failed(strippedReport).some((name) => name.startsWith('event for the result: regular round')))
  assert.ok(failed(strippedReport).some((name) => name.startsWith('lot ')), 'the lots have no events any more')

  // The outcomes left out: every contest needs its outcome.
  const noOutcomes = clone(document)
  noOutcomes.outcomes = []
  assert.ok(failed(verifyExport(noOutcomes)).includes('outcomes: one per contest'))

  // A lot's reason changed, and a lot left out while its event stays: both are caught, in both directions.
  const reason = clone(document)
  reason.lots[0]!.reason = 'Ein anderer Grund'
  assert.ok(failed(verifyExport(reason)).some((name) => name.startsWith(`lot ${reason.lots[0]?.lotId}`)))
  const suppressed = clone(document)
  suppressed.lots = suppressed.lots.slice(1)
  assert.ok(failed(verifyExport(suppressed)).some((name) => /^event \d+ lot\.recorded/.test(name)))

  // Another election's id on the file; a "Nein" naming someone; the rows out of content order; more used than issued.
  const other = clone(document)
  other.election.id = '00000000-0000-4000-8000-000000000000'
  assert.ok(failed(verifyExport(other)).includes('audit chain of this election'))
  const named = clone(document)
  const runoffBox = named.rounds[1]?.boxes[0] ?? assert.fail('the runoff box')
  runoffBox.ballots[0] = { kind: 'invalid', ranking: [paula] }
  assert.ok(failed(verifyExport(named)).includes('rows: runoff round, Schulsprecher/in'))
  const shuffled = clone(document)
  const rows = shuffled.rounds[0]?.boxes[0]?.ballots ?? assert.fail('the rows')
  rows.reverse()
  assert.ok(failed(verifyExport(shuffled)).includes('order: regular round, Schulsprecher/in'))
  assert.ok(!failed(verifyExport(shuffled)).includes('digest: regular round, Schulsprecher/in'), 'the digest sorts for itself; the order check is the one that sees it')
  const issued = clone(document)
  issued.rounds[0]!.boxes[0]!.entitlements.issued = 0
  assert.ok(failed(verifyExport(issued)).includes('ballots: regular round, Schulsprecher/in'))

  // A second snapshot for a box, with a false result; a batch's keys changed, its state flipped, a batch left out.
  const twice = clone(document)
  const falseSnapshot = clone(document).snapshots[0] ?? assert.fail('a snapshot')
  ;(falseSnapshot.result as { statistics: { validBallots: number } }).statistics.validBallots = 99
  twice.snapshots.push(falseSnapshot)
  assert.ok(failed(verifyExport(twice)).includes('snapshots: one per box'))
  const keys = clone(document)
  keys.batches[0]!.keys = 40
  assert.ok(failed(verifyExport(keys)).some((name) => name.startsWith(`batch ${keys.batches[0]?.id}`)))
  const state = clone(document)
  state.batches[0]!.state = 'void'
  assert.ok(failed(verifyExport(state)).some((name) => name.startsWith(`batch ${state.batches[0]?.id}`)))
  const dropped = clone(document)
  dropped.batches = dropped.batches.slice(1)
  assert.ok(failed(verifyExport(dropped)).some((name) => /^event \d+ credential-batch\.issued/.test(name)))

  // A lot's own time moved before the runoff's close, which the event's time, covered by the chain, denies.
  const backdated = clone(document)
  backdated.lots[1]!.recordedAt = '2000-01-01T00:00:00.000Z'
  const backdatedReport = verifyExport(backdated)
  assert.ok(failed(backdatedReport).some((name) => name.startsWith(`lot ${backdated.lots[1]?.lotId}`)))
  assert.ok(!failed(backdatedReport).includes('outcome at close: runoff round, Schulsprecher/in'), 'the ordering follows the event, not the row')
  // A round not closed with ballots in a box; a batch in a state the file does not know; a formatted key in a text; an extra property on a row.
  const open = clone(document)
  open.rounds[1]!.state = 'open'
  assert.ok(failed(verifyExport(open)).includes('runoff round, open'))
  const retired = clone(document)
  retired.batches[0]!.state = 'retired'
  assert.ok(failed(verifyExport(retired)).some((name) => name.startsWith(`batch ${retired.batches[0]?.id}`)))
  const leaked = clone(document)
  leaked.election.description = (x.keys['1A']?.[0] ?? '').toLowerCase().match(/.{1,4}/g)?.join(' - ') ?? ''
  assert.ok(failed(verifyExport(leaked)).includes('no key'))
  const extra = clone(document) as unknown as { rounds: { boxes: { ballots: Record<string, unknown>[] }[] }[] }
  extra.rounds[0]!.boxes[0]!.ballots[0]!.credential = 'x'
  assert.match(verifyExport(extra).checks[0]?.detail ?? '', /the rounds section/)

  // A damaged section is a named failure, never a crash.
  const damaged = clone(document) as unknown as { rounds: unknown[] }
  damaged.rounds = [{ kind: 'regular', state: 'closed', boxes: [null] }]
  const damagedReport = verifyExport(damaged)
  assert.equal(damagedReport.ok, false)
  assert.deepEqual(damagedReport.checks.map((check) => [check.name, check.ok]), [['format', false]])
  assert.match(damagedReport.checks[0]?.detail ?? '', /the rounds section/)
})

test('a finalized election\'s export passes, with the declaration checked; a declared outcome changed or left out, the event\'s counts changed, the event removed, a change after it, and a final state without the event each fail', DB, async (t) => {
  const x = await prepared(t)
  await exportedElection(x)
  ok(await x.anna.request('POST', `${x.base}/finalize`, { reason: 'Ergebnis festgestellt' }))
  const res = await x.wanda.request('POST', `${x.base}/export`)
  const document = JSON.parse(res.body) as ExportDocument
  const report = verifyExport(document)
  assert.deepEqual(report.checks.filter((check) => !check.ok), [])
  const names = report.checks.map((check) => check.name)
  for (const expected of ['finalization', 'final outcomes: one per contest', 'final outcome: Schulsprecher/in']) assert.ok(names.includes(expected), expected)
  assert.ok(names.some((name) => /^event \d+ election\.finalized$/.test(name)))
  assert.match(report.checks.find((check) => check.name === 'finalization')?.detail ?? '', /^declared at .* by Anna Lehrerin, exports only since$/)
  assert.match(report.checks.find((check) => check.name === 'final outcome: Schulsprecher/in')?.detail ?? '', /^final, declared with tally version \d+ by dev \(unknown\)$/)
  assert.match(report.checks.find((check) => /election\.finalized$/.test(check.name))?.detail ?? '', /^1 resolved, 0 unresolved; reason: Ergebnis festgestellt$/)

  const changed = clone(document)
  const stored = changed.finalOutcomes[0]?.outcome as unknown as { positions: { candidateId: string }[] }
  stored.positions.reverse()
  assert.deepEqual(failed(verifyExport(changed)), ['final outcome: Schulsprecher/in'])
  assert.match(verifyExport(changed).checks.find((check) => check.name === 'final outcome: Schulsprecher/in')?.detail ?? '', /differs from the one resolved now/)
  const kind = clone(document)
  kind.finalOutcomes[0]!.kind = 'tie'
  assert.ok(failed(verifyExport(kind)).includes('final outcome: Schulsprecher/in'))
  const none = clone(document)
  none.finalOutcomes = []
  assert.ok(failed(verifyExport(none)).includes('final outcomes: one per contest'))
  assert.ok(failed(verifyExport(none)).some((name) => /election\.finalized$/.test(name)), 'the event counts one resolved, the file declares none')
  const counts = clone(document)
  const declaration = counts.audit.events.find((event) => event.action === 'election.finalized') ?? assert.fail('the declaration')
  declaration.metadata = { ...declaration.metadata, resolved: 0, unresolved: 1 }
  assert.ok(failed(verifyExport(counts)).some((name) => /election\.finalized$/.test(name)))
  assert.ok(failed(verifyExport(counts)).includes('audit chain'), 'the chain covers the counts')
  const removed = clone(document)
  removed.audit.events = removed.audit.events.filter((event) => event.action !== 'election.finalized')
  assert.ok(failed(verifyExport(removed)).includes('finalization'))
  assert.match(verifyExport(removed).checks.find((check) => check.name === 'finalization')?.detail ?? '', /0 election\.finalized events for a final election/)
  const later = clone(document)
  const last = later.audit.events.at(-1) ?? assert.fail('an event')
  later.audit.events.push({ ...last, seq: last.seq + 1, action: 'lot.recorded', prevHash: last.hash })
  assert.match(verifyExport(later).checks.find((check) => check.name === 'finalization')?.detail ?? '', /changed after the declaration: lot\.recorded/)
  const notFinal = clone(document)
  notFinal.election.state = 'active'
  notFinal.election.lifecycle = { ...notFinal.election.lifecycle, election: 'active' }
  assert.match(verifyExport(notFinal).checks.find((check) => check.name === 'finalization')?.detail ?? '', /an election\.finalized event, but the election is not final/)
  const disagreeing = clone(document)
  disagreeing.election.state = 'active'
  assert.match(verifyExport(disagreeing).checks.find((check) => check.name === 'lifecycle')?.detail ?? '', /^the lifecycle says final, closed, closed; the file active/)
  const declaredEarly = clone(document)
  declaredEarly.election.state = 'active'
  declaredEarly.audit.events = declaredEarly.audit.events.filter((event) => event.action !== 'election.finalized')
  assert.match(verifyExport(declaredEarly).checks.find((check) => check.name === 'finalization')?.detail ?? '', /declared outcomes, but the election is not final/)
})

test('the script verifies a file from a checkout, with no database and no server, and exits 1 on a tampered one', DB, async (t) => {
  const x = await prepared(t)
  const { text, document } = await exportedElection(x)
  const dir = await mkdtemp(path.join(tmpdir(), 'school-election-export-'))
  const file = path.join(dir, 'wahl.json')
  await writeFile(file, text)
  const tampered = clone(document)
  tampered.rounds[0]!.boxes[0]!.entitlements.used = 1
  const bad = path.join(dir, 'tampered.json')
  await writeFile(bad, JSON.stringify(tampered))
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/verify.ts')
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/DATABASE|PG|SESSION|ENTRA/.test(key)))
  const run = promisify(execFile)
  const good = await run(process.execPath, [script, file], { env })
  assert.match(good.stdout, /sha256: [0-9a-f]{64}/)
  assert.match(good.stdout, /OK: every check passed/)
  await assert.rejects(run(process.execPath, [script, bad], { env }), (err: { code?: number, stdout?: string }) => err.code === 1 && /FAIL ballots: regular round/.test(err.stdout ?? '') && /FAILED: 1 of/.test(err.stdout ?? ''))
  await assert.rejects(run(process.execPath, [script], { env }), (err: { code?: number }) => err.code === 2)
})
