import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { effectScope, nextTick, reactive, ref } from 'vue'
import type { Lifecycle } from '@school-election/election-core'
import { useElectionDay, type DaySource } from '../src/lib/election-day.ts'
import type { Permission } from '../src/lib/setup-rules.ts'
import type { BatchSummary, ContestResult, ElectionDetail, ElectionResult } from '../src/lib/types.ts'

// The day's state against an API answered here: each request is looked up
// by its method and path, a number answers with that status and no body,
// a function with what it returns for the request's body.

const PREPARED: Lifecycle = { election: 'prepared', regular: 'planned', runoff: null }
const OWNER: Permission[] = ['view', 'view-results', 'configure', 'prepare', 'issue-keys', 'run-rounds', 'finalize']
const BASE = '/api/elections/e1'

/** The page's document, as far as the day's state reaches it: the focus given back after a dialog finds no step here. */
const NO_DOCUMENT = { querySelector: () => null }
Object.assign(globalThis, { document: NO_DOCUMENT })

let requests: { method: string, path: string, body: unknown }[] = []
let answers: Record<string, unknown> = {}
const realFetch = globalThis.fetch

beforeEach(() => {
  requests = []
  answers = {}
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined
    requests.push({ method, path, body })
    const answer = answers[`${method} ${path}`]
    if (answer === undefined) return new Response('{"error":"not_found"}', { status: 404 })
    if (typeof answer === 'number') return new Response('{"error":"unavailable"}', { status: answer })
    const value = typeof answer === 'function' ? (answer as (body: unknown) => unknown)(body) : answer
    return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
  }
})

afterEach(() => {
  globalThis.fetch = realFetch
})

/** Lets the requests on their way answer. */
async function settled(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
  await nextTick()
}

function election(lifecycle: Lifecycle, permissions: Permission[] = OWNER): ElectionDetail {
  return { id: 'e1', title: 'Schulsprecherwahl', description: '', state: lifecycle.election, role: 'owner', permissions, lifecycle }
}

const CONFIGURATION: DaySource['configuration'] = {
  contests: [
    { id: 'k', title: 'Klassensprecher/in 1A', rulesetId: 'at-representative-v1', activeSlots: 2, candidates: [{ id: 'm', surname: 'Fuchs', givenName: 'Max', picture: null }, { id: 'l', surname: 'Bauer', givenName: 'Lena', picture: '/api/elections/e1/candidates/l/picture/abc' }] },
    { id: 's', title: 'Schulsprecher/in', rulesetId: 'at-school-speaker-v1', activeSlots: 3, candidates: [{ id: 'p', surname: 'Berger', givenName: 'Paula', picture: null }, { id: 'r', surname: 'Wagner', givenName: 'Renate', picture: null }] },
  ],
  voterGroups: [{ id: 'g1', name: '1A', contestIds: ['k', 's'] }, { id: 'g2', name: '2B', contestIds: ['s'] }],
}

const batch = (id: string, voterGroupId: string, roundKind: 'regular' | 'runoff', keys: number, state: 'issued' | 'void' = 'issued'): BatchSummary => ({ id, voterGroupId, roundKind, state, keys })

/** The day's state for `lifecycle`, in a scope of its own, with what it reports as changed counted. */
function day(lifecycle: Lifecycle, batches: BatchSummary[] = [], permissions: Permission[] = OWNER) {
  const source = ref<DaySource>({ election: election(lifecycle, permissions), configuration: CONFIGURATION, batches })
  const changed = { count: 0 }
  const scope = effectScope()
  const state = scope.run(() => reactive(useElectionDay(() => source.value, () => {
    changed.count += 1
  })))
  if (!state) throw new Error('no state')
  return { state, source, changed, stop: () => scope.stop() }
}

const statistics = (figures: Record<string, number>) => ({
  validBallots: Object.values(figures).reduce((sum, n) => sum + n, 0),
  noBallots: 0,
  invalidBallots: 0,
  candidates: Object.entries(figures).map(([candidateId, firstPlaces]) => ({ candidateId, firstPlaces, rankCounts: [firstPlaces], points: firstPlaces })),
})
const snapshot = (contestId: string, figures: Record<string, number>) => ({ contestId, tallyVersion: 1, appVersion: '1', gitSha: 'x', result: { kind: 'ranked', statistics: statistics(figures) }, outcome: null })

test('before a run: where the day stands, and opening names the classes without cards, which then need a second yes', async () => {
  answers[`POST ${BASE}/rounds/regular/open`] = {}
  const { state, changed, stop } = day(PREPARED, [batch('b1', 'g1', 'regular', 25), batch('b2', 'g2', 'regular', 20, 'void')])
  assert.equal(state.stateLine, 'Vorbereitet. Sobald die Stimmkarten gedruckt sind, kann der 1. Wahlgang geöffnet werden.')
  assert.equal(state.rules.open, true)
  assert.deepEqual(state.regularCards.missing, ['2B'])
  state.ask('open')
  assert.equal(state.dialog?.title, '1. Wahlgang öffnen?')
  assert.deepEqual(state.dialog?.lines, [{ text: '1A: 25 Stimmkarten', missing: false }, { text: '2B: keine gültigen Stimmkarten für den 1. Wahlgang', missing: true }])
  assert.equal(state.dialog?.override, 'Trotzdem öffnen: 2B kann im 1. Wahlgang nicht wählen.')
  assert.equal(state.dialog?.danger, false)
  await state.confirm()
  assert.equal(state.confirming, null)
  assert.equal(state.noticeIn('wahltag'), 'Der 1. Wahlgang ist geöffnet.')
  assert.equal(state.noticeIn('probelauf'), null)
  assert.equal(changed.count, 1)
  assert.deepEqual(requests.filter((request) => request.method === 'POST').map((request) => request.path), [`${BASE}/rounds/regular/open`])
  stop()
})

test('the Probelauf: started, its count on request, ended with what went; a refusal shows in its card only', async () => {
  answers[`POST ${BASE}/rounds/regular/test`] = 409
  const { state, source, stop } = day(PREPARED)
  assert.equal(await state.startTest(), false)
  assert.ok(state.errorIn('probelauf'))
  assert.equal(state.errorIn('wahltag'), null)

  answers[`POST ${BASE}/rounds/regular/test`] = {}
  assert.equal(await state.startTest(), true)
  assert.equal(state.errorIn('probelauf'), null)
  assert.equal(state.noticeIn('probelauf'), 'Probelauf gestartet: Stimmen zählen nicht, und nichts bleibt.')

  const testing: Lifecycle = { election: 'prepared', regular: 'testing', runoff: null }
  answers[`GET ${BASE}/rounds/regular/turnout`] = { round: 'testing', keys: { issued: 25, used: 1 }, contests: [{ contestId: 's', issued: 25, used: 1 }] }
  answers[`GET ${BASE}/rounds/regular/test-result`] = 503
  source.value = { ...source.value, election: election(testing) }
  await settled()
  assert.equal(state.stateLine, 'Der Probelauf läuft: Stimmen zählen nicht, und nichts bleibt.')
  assert.equal(state.turnout?.kind, 'regular')
  assert.equal(state.turnout?.keys.used, 1)
  await state.readTestResult()
  assert.ok(state.errorIn('probelauf'))
  answers[`GET ${BASE}/rounds/regular/test-result`] = { round: 'testing', contests: [snapshot('s', { p: 1 })] }
  await state.readTestResult()
  assert.equal(state.errorIn('probelauf'), null)
  assert.equal(state.testResult?.contests.length, 1)

  answers[`POST ${BASE}/rounds/regular/test/end`] = { ballots: 3, keys: 1 }
  await state.endTest()
  assert.equal(state.noticeIn('probelauf'), 'Probelauf beendet: 3 Stimmzettel entfernt, 1 Code wieder frei.')
  assert.equal(state.testResult, null)
  stop()
})

test('while a round accepts ballots the turnout is read every five seconds, and a change elsewhere reloads the page', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const open: Lifecycle = { election: 'active', regular: 'open', runoff: null }
  let used = 0
  answers[`GET ${BASE}/rounds/regular/turnout`] = () => ({ round: 'open', keys: { issued: 25, used }, contests: [] })
  answers[`GET ${BASE}`] = election(open)
  const { state, changed, stop } = day(open)
  await settled()
  assert.equal(state.stateLine, 'Der 1. Wahlgang läuft.')
  assert.equal(state.turnout?.keys.used, 0)
  used = 4
  t.mock.timers.tick(5000)
  await settled()
  assert.equal(state.turnout?.keys.used, 4)
  assert.equal(changed.count, 0)
  answers[`GET ${BASE}`] = election({ election: 'active', regular: 'closed', runoff: null })
  t.mock.timers.tick(5000)
  await settled()
  assert.equal(changed.count, 1)

  // Closing names the cards left unused, from the turnout.
  state.ask('close-regular')
  assert.deepEqual(state.dialog?.lines, [{ text: '21 von 25 Stimmkarten wurden nicht verwendet.', missing: false }])
  assert.equal(state.dialog?.danger, true)
  state.cancel()
  assert.equal(state.dialog, null)
  stop()
})

const counted: Lifecycle = { election: 'active', regular: 'closed', runoff: null }
const contest = (contestId: string, outcome: ContestResult['outcome'], lots: ContestResult['lots'] = []): ContestResult =>
  ({ contestId, first: snapshot(contestId, { p: 2, r: 1 }), runoff: null, lots, outcome })

test('once counted: the result, a failed first read in its place until a later read takes it back', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  answers[`GET ${BASE}/rounds/regular/turnout`] = { round: 'closed', keys: { issued: 25, used: 4 }, contests: [] }
  answers[`GET ${BASE}`] = election(counted)
  answers[`GET ${BASE}/result`] = 503
  const { state, stop } = day(counted)
  await settled()
  assert.ok(state.errorIn('ergebnis'))
  assert.equal(state.result, null)
  const result: ElectionResult = { contests: [contest('k', { kind: 'final', positions: [], trace: [] })], finalized: null }
  answers[`GET ${BASE}/result`] = result
  t.mock.timers.tick(5000)
  await settled()
  assert.equal(state.errorIn('ergebnis'), null)
  assert.deepEqual(state.result, result)
  stop()
})

test('a runoff to activate: its pairs, the runoff cards per class, and the lot it waits for', async () => {
  const lot = { id: 'runoff-entry' as const, reason: 'runoff-entry' as const, candidates: ['p', 'r'], seats: 1, qualified: [] }
  answers[`GET ${BASE}/rounds/regular/turnout`] = { round: 'closed', keys: { issued: 25, used: 4 }, contests: [] }
  answers[`GET ${BASE}/result`] = { contests: [contest('k', { kind: 'lot-required', lots: [lot], positions: [], trace: [] }), contest('s', { kind: 'runoff-required', runoffCandidates: ['p', 'r'], trace: [] })], finalized: null }
  answers[`POST ${BASE}/rounds/runoff/activate`] = { contests: [], keys: 10 }
  const { state, stop } = day(counted, [batch('b3', 'g1', 'runoff', 10)])
  await settled()
  assert.deepEqual(state.runoff.waiting, ['k'])
  assert.deepEqual(state.runoff.pairs, [{ contestId: 's', pair: ['p', 'r'] }])
  assert.deepEqual(state.runoffSheets.map((entry) => [entry.group.name, entry.keys]), [['1A', 10], ['2B', 0]])
  assert.equal(state.printPath(batch('b3', 'g1', 'runoff', 10)), '/elections/e1/batches/b3/print')
  assert.deepEqual(state.undecided, ['Klassensprecher/in 1A: der Losentscheid fehlt', 'Schulsprecher/in: die Stichwahl fehlt'])
  assert.deepEqual(state.lotsOf(state.result?.contests[0] as ContestResult), [lot])
  assert.deepEqual(state.lotsOf(state.result?.contests[1] as ContestResult), [])
  assert.equal(state.names.candidate('p'), 'Paula Berger')
  assert.equal(state.names.candidate('x'), 'x')
  assert.equal(state.pictureOf('l'), '/api/elections/e1/candidates/l/picture/abc')
  assert.equal(state.pictureOf('m'), null)
  assert.equal(state.rulesetOf('k'), 'at-representative-v1')
  assert.equal(state.rulesetOf('x'), 'single-choice-v1')
  state.ask('activate')
  assert.equal(state.dialog?.override, 'Trotzdem aktivieren: 2B kann in der Stichwahl nicht wählen.')
  await state.confirm()
  assert.equal(state.noticeIn('wahltag'), 'Die Stichwahl läuft: 10 Stichwahl-Stimmkarten gelten jetzt.')
  stop()
})

test('a recorded lot reads the result again, and finalizing takes the reason trimmed and says what it did', async (t) => {
  // The toast's timer.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  answers[`GET ${BASE}/rounds/regular/turnout`] = { round: 'closed', keys: { issued: 25, used: 4 }, contests: [] }
  answers[`GET ${BASE}/result`] = { contests: [], finalized: null }
  answers[`POST ${BASE}/finalize`] = (body: unknown) => {
    assert.deepEqual(body, { reason: 'Ergebnis festgestellt' })
    return { state: 'final', contests: [], batchesVoided: 2 }
  }
  const { state, stop } = day(counted)
  await settled()
  const reads = requests.filter((request) => request.path === `${BASE}/result`).length
  state.lotRecorded('s')
  await settled()
  assert.equal(requests.filter((request) => request.path === `${BASE}/result`).length, reads + 1)
  state.askFinalize()
  assert.equal(state.finalizing, true)
  assert.equal(await state.finalize('  Ergebnis festgestellt '), true)
  assert.equal(state.finalizing, false)
  assert.equal(state.noticeIn('feststellen'), 'Das Ergebnis ist festgestellt. Nicht verwendete Stichwahl-Stimmkarten sind ungültig.')
  state.askFinalize()
  state.cancelFinalize()
  assert.equal(state.finalizing, false)
  stop()
})

test('a final termin: the declaration in the state line, and the export saved with its digest', async (t) => {
  // The toast's timer and the one that lets go of the file.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const final: Lifecycle = { election: 'final', regular: 'closed', runoff: 'closed' }
  answers[`GET ${BASE}/rounds/runoff/turnout`] = { round: 'closed', keys: { issued: 10, used: 3 }, contests: [] }
  answers[`GET ${BASE}/result`] = { contests: [], finalized: { reason: 'Ergebnis festgestellt', actorName: 'Anna Lehrerin', at: '2026-10-05T12:12:00Z' } }
  const { state, stop } = day(final)
  await settled()
  assert.match(state.stateLine, /^Ergebnis festgestellt am .* durch Anna Lehrerin: Ergebnis festgestellt$/)

  const clicked: string[] = []
  const document = { ...NO_DOCUMENT, createElement: () => ({ href: '', download: '', click: () => clicked.push('click'), remove: () => clicked.push('remove') }), body: { append: () => clicked.push('append') } }
  Object.assign(globalThis, { document })
  t.mock.method(URL, 'createObjectURL', () => 'blob:export')
  t.mock.method(URL, 'revokeObjectURL', () => undefined)
  globalThis.fetch = async () => new Response('{}', { status: 200, headers: { 'content-disposition': 'attachment; filename="wahl-e1.json"', 'x-export-sha256': 'abc' } })
  try {
    await state.download()
  } finally {
    Object.assign(globalThis, { document: NO_DOCUMENT })
  }
  assert.deepEqual(clicked, ['append', 'click', 'remove'])
  assert.deepEqual(state.exported, { name: 'wahl-e1.json', sha256: 'abc' })
  assert.equal(state.errorIn('feststellen'), null)
  stop()
})

test('a cancelled dialog gives the focus back to the step that asked', async () => {
  const asked: string[] = []
  Object.assign(globalThis, { document: { querySelector: (selector: string) => ({ focus: () => asked.push(selector) }) } })
  try {
    const { state, stop } = day(PREPARED)
    state.ask('open')
    await nextTick()
    state.cancel()
    await settled()
    state.askFinalize()
    await nextTick()
    state.cancelFinalize()
    await settled()
    assert.deepEqual(asked, ['[data-step="open"]', '[data-step="finalize"]'])
    stop()
  } finally {
    Object.assign(globalThis, { document: NO_DOCUMENT })
  }
})

test('a draft: nothing of the day yet', () => {
  const { state, stop } = day({ election: 'draft', regular: 'planned', runoff: null })
  assert.equal(state.stateLine, 'Der Wahltermin ist noch im Entwurf: zuerst vorbereiten.')
  assert.equal(state.rules.open, false)
  assert.equal(state.turnout, null)
  stop()
})
