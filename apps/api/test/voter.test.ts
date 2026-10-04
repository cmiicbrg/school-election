// The voter routes: a key redeemed once, the contests it may vote in and
// no other, one ballot each, every refusal, the test mode through the same
// door, the picture by content, and that a session that works leaves no
// trace in the log and no identity anywhere.

import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import type { InjectOptions, LightMyRequestResponse } from 'fastify'
import sharp from 'sharp'
import { generateKey, KEY_RANDOM_BYTES } from '@school-election/election-core'
import { AttemptLimiter } from '../lib/attempt-limiter.ts'
import { DB, withClient } from './helpers/db.ts'
import { CookieJar } from './helpers/fake-entra.ts'
import { ok, preparedElection, refused, type RouteSetup } from './helpers/round-routes.ts'
import { electionApp, signIn, ANNA, createElection, type ElectionApp } from './helpers/elections.ts'

const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' }

/** The school contest (three candidates) and the class contest (two); 1A votes in both with three keys, 2B in the school contest alone with two. */
const prepared = (t: TestContext): Promise<RouteSetup> => preparedElection(t, {
  contests: [
    { title: 'Schulsprecher/in', rulesetId: 'at-school-speaker-v1', candidates: [['Berger', 'Paula'], ['Huber', 'Quirin'], ['Wagner', 'Renate']] },
    { title: 'Klassensprecher/in 1A', rulesetId: 'at-representative-v1', candidates: [['Bauer', 'Lena'], ['Fuchs', 'Max']] },
  ],
  groups: [{ name: '1A', contests: [0, 1], keys: 3 }, { name: '2B', contests: [0], keys: 2 }],
})

interface VoterElection {
  title: string
  round: string
  remaining: number
  contests: { id: string, roundContestId: string, title: string, activeSlots: number, done: boolean, candidates: { id: string, surname: string, picture: string | null }[] }[]
}

/** A voter's browser: a cookie jar of its own, same-origin requests, no admin cookie unless a test adds one. */
function voterBrowser(s: ElectionApp) {
  const jar = new CookieJar()
  const request = async (method: InjectOptions['method'], url: string, body?: object, headers: Record<string, string> = {}): Promise<LightMyRequestResponse> => {
    const res = await s.app.inject({ method, url, headers: { ...SAME_ORIGIN, ...headers, cookie: jar.header() }, ...(body === undefined ? {} : { payload: body }) })
    jar.update(res)
    return res
  }
  return {
    jar,
    request,
    redeem: (key: string) => request('POST', '/api/voter/session', { key }),
    ballot: (roundContestId: string, ballot: object) => request('POST', '/api/voter/ballot', { roundContestId, ballot }),
    contests: () => request('GET', '/api/voter/contests'),
  }
}

const open = async (x: RouteSetup) => ok(await x.anna.request('POST', `${x.base}/rounds/regular/open`))
const unknownKey = () => generateKey(randomBytes(KEY_RANDOM_BYTES))

test('a key votes once in every contest it is entitled to and in no other; the last ballot ends the session', DB, async (t) => {
  const x = await prepared(t)
  await open(x)
  const [school, klass] = x.contests
  assert.ok(school && klass)
  const [schoolBox, classBox] = [x.boxes.get(school.id) ?? '', x.boxes.get(klass.id) ?? '']

  const voter = voterBrowser(x.s)
  const election = ok<VoterElection>(await voter.redeem(x.keys['1A']?.[0] ?? ''))
  assert.equal(election.round, 'open')
  assert.equal(election.remaining, 2)
  assert.deepEqual(election.contests.map((contest) => [contest.title, contest.roundContestId, contest.activeSlots, contest.done]), [['Klassensprecher/in 1A', classBox, 2, false], ['Schulsprecher/in', schoolBox, 3, false]])
  assert.deepEqual(election.contests[1]?.candidates.map((candidate) => candidate.surname), ['Berger', 'Huber', 'Wagner'])
  assert.ok(voter.jar.values.has('__Secure-voter-session'))

  const [paula, quirin, renate] = school.candidateIds
  assert.deepEqual(ok(await voter.ballot(schoolBox, { kind: 'ranking', ranking: [paula, quirin, renate] })), { done: false, remaining: 1 })
  refused(await voter.ballot(schoolBox, { kind: 'ranking', ranking: [renate, quirin, paula] }), 409, 'already_voted')
  assert.equal(ok<VoterElection>(await voter.contests()).contests.find((contest) => contest.roundContestId === schoolBox)?.done, true)
  const [lena, max] = klass.candidateIds
  assert.deepEqual(ok(await voter.ballot(classBox, { kind: 'ranking', ranking: [max, lena] })), { done: true, remaining: 0 })
  assert.equal(voter.jar.values.has('__Secure-voter-session'), false, 'the last ballot took the cookie with it')
  refused(await voter.contests(), 401, 'no_session')
  refused(await voter.ballot(classBox, { kind: 'ranking', ranking: [max, lena] }), 401, 'no_session')

  // A key of 2B votes in the school contest alone.
  const other = voterBrowser(x.s)
  const theirs = ok<VoterElection>(await other.redeem(x.keys['2B']?.[0] ?? ''))
  assert.deepEqual(theirs.contests.map((contest) => contest.roundContestId), [schoolBox])
  refused(await other.ballot(classBox, { kind: 'ranking', ranking: [lena, max] }), 409, 'not_entitled')
  assert.equal((await other.request('POST', '/api/voter/session/end')).statusCode, 204)
  refused(await other.contests(), 401, 'no_session')

  const { rows: [written] } = await withClient(x.s.ownerUrl, (client) => client.query<{ staged: number, used: number }>(
    'select (select count(*)::int from ballot_box) as staged, (select count(*)::int from credential_entitlement where consumed) as used',
  ))
  assert.deepEqual(written, { staged: 2, used: 2 })
})

test('a malformed key names its typo; an unknown key and a void batch\'s key get one and the same answer; a key before and after its round gets the lifecycle\'s', DB, async (t) => {
  const x = await prepared(t)
  const voter = voterBrowser(x.s)
  const [key] = x.keys['2B'] ?? []
  assert.ok(key)
  refused(await voter.redeem(key), 409, 'round_planned')
  assert.deepEqual((await voter.redeem('ABC')).json(), { error: 'invalid_key', problem: 'length' })
  assert.deepEqual((await voter.redeem(`${key.slice(0, 19)}${key[19] === 'A' ? 'B' : 'A'}`)).json(), { error: 'invalid_key', problem: 'check' })
  assert.deepEqual((await voter.redeem(key.replace(/[0-9A-Z]/, 'U'))).json(), { error: 'invalid_key', problem: 'symbol' })
  // Lower case, spaces and hyphens, O for 0: what a person types.
  const typed = key.toLowerCase().match(/.{1,4}/g)?.join(' - ')?.replaceAll('0', 'o') ?? ''
  refused(await voter.redeem(typed), 409, 'round_planned')

  await open(x)
  refused(await voter.redeem(unknownKey()), 404, 'unknown_key')
  // The 2B batch replaced: its keys are void and answer as unknown ones do.
  const { batches } = ok<{ batches: { id: string, voterGroupId: string, state: string }[] }>(await x.anna.request('GET', `${x.base}/batches`))
  const { voterGroups } = ok<{ voterGroups: { id: string, name: string }[] }>(await x.anna.request('GET', `${x.base}/configuration`))
  const g2b = voterGroups.find((group) => group.name === '2B')?.id
  assert.ok(g2b)
  await withClient(x.s.ownerUrl, (client) => client.query(`begin; set local session_replication_role = replica; update election set state = 'prepared'; update round set state = 'planned'; commit`))
  const batch = batches.find((entry) => entry.voterGroupId === g2b)
  assert.ok(batch)
  ok(await x.anna.request('POST', `${x.base}/batches/${batch.id}/replace`), 201)
  await open(x)
  refused(await voter.redeem(key), 404, 'unknown_key')
  ok(await voter.redeem(x.keys['1A']?.[0] ?? ''))
  const late = voterBrowser(x.s)
  ok(await late.redeem(x.keys['1A']?.[2] ?? ''))

  // Closing ends the sessions still open: the lifecycle's answer once, the cookie gone with it, and nothing after.
  ok(await x.anna.request('POST', `${x.base}/rounds/regular/close`))
  refused(await voterBrowser(x.s).redeem(x.keys['1A']?.[1] ?? ''), 409, 'round_closed')
  refused(await late.contests(), 409, 'round_closed')
  assert.equal(late.jar.values.has('__Secure-voter-session'), false, 'the answer took the cookie with it')
  const [school] = x.contests
  assert.ok(school)
  refused(await voter.ballot(x.boxes.get(school.id) ?? '', { kind: 'ranking', ranking: school.candidateIds }), 409, 'round_closed')
  refused(await voter.contests(), 401, 'no_session')
})

test('the contests come in the order of the configuration screens, numbers as numbers', DB, async (t) => {
  const x = await preparedElection(t, {
    contests: ['10A', '2A', '1B'].map((label) => ({ title: `Klassensprecher/in ${label}`, rulesetId: 'at-representative-v1' as const, candidates: [['Bauer', 'Lena'], ['Fuchs', 'Max']] })),
    groups: [{ name: 'Alle', contests: [0, 1, 2], keys: 1 }],
  })
  await open(x)
  const election = ok<VoterElection>(await voterBrowser(x.s).redeem(x.keys.Alle?.[0] ?? ''))
  assert.deepEqual(election.contests.map((contest) => contest.title), ['Klassensprecher/in 1B', 'Klassensprecher/in 2A', 'Klassensprecher/in 10A'])
})

test('every refusal of a ballot leaves the entitlement unused, and names positions, never a candidate', DB, async (t) => {
  const x = await prepared(t)
  await open(x)
  const [school] = x.contests
  assert.ok(school)
  const box = x.boxes.get(school.id) ?? ''
  const [paula, quirin, renate] = school.candidateIds
  const voter = voterBrowser(x.s)
  ok(await voter.redeem(x.keys['2B']?.[0] ?? ''))
  const stranger = '00000000-0000-4000-8000-000000000000'
  const cases: [object, number, string, string | undefined][] = [
    [{ kind: 'maybe' }, 400, 'FST_ERR_VALIDATION', undefined],
    [{ kind: 'ranking', ranking: [paula, quirin, renate], extra: true }, 400, 'FST_ERR_VALIDATION', undefined],
    [{ kind: 'ranking', ranking: [paula, stranger, renate] }, 400, 'invalid_ballot', 'unknown-candidate'],
    [{ kind: 'ranking', ranking: [paula, paula, renate] }, 400, 'invalid_ballot', 'duplicate-candidate'],
    [{ kind: 'ranking', ranking: [paula, quirin, renate, null] }, 400, 'invalid_ballot', 'inactive-slot'],
    [{ kind: 'ranking', ranking: [paula, quirin] }, 400, 'invalid_ballot', 'incomplete'],
    [{ kind: 'no' }, 400, 'invalid_ballot', 'no-not-offered'],
  ]
  for (const [ballot, status, error, kind] of cases) {
    const res = await voter.ballot(box, ballot)
    assert.equal(res.statusCode, status, res.body)
    const body = res.json<{ error: string, problem?: { kind: string }, message?: string }>()
    assert.equal(body.error, error)
    if (kind) assert.equal(body.problem?.kind, kind)
    for (const id of school.candidateIds) assert.ok(!res.body.includes(id), 'a refusal never names a candidate')
  }
  assert.equal(ok<VoterElection>(await voter.contests()).remaining, 1)
  // An incomplete ranking is a vote once the voter says so.
  assert.deepEqual(ok(await voter.ballot(box, { kind: 'ranking', ranking: [paula, null, null], confirmInvalid: true })), { done: true, remaining: 0 })
  const { rows: [staged] } = await withClient(x.s.ownerUrl, (client) => client.query<{ kind: string, n: number }>('select kind, cardinality(ranking)::int as n from ballot_box'))
  assert.deepEqual(staged, { kind: 'invalid', n: 0 })
})

test('two submissions of the same key at once cast exactly one ballot', DB, async (t) => {
  const x = await prepared(t)
  await open(x)
  const [school] = x.contests
  assert.ok(school)
  const box = x.boxes.get(school.id) ?? ''
  const [paula, quirin, renate] = school.candidateIds
  const voter = voterBrowser(x.s)
  ok(await voter.redeem(x.keys['2B']?.[0] ?? ''))
  const cookie = voter.jar.header()
  const submit = () => x.s.app.inject({ method: 'POST', url: '/api/voter/ballot', headers: { ...SAME_ORIGIN, cookie }, payload: { roundContestId: box, ballot: { kind: 'ranking', ranking: [paula, quirin, renate] } } })
  const answers = await Promise.all([submit(), submit(), submit()])
  assert.deepEqual(answers.map((res) => res.statusCode).sort(), [200, 409, 409])
  const { rows: [staged] } = await withClient(x.s.ownerUrl, (client) => client.query<{ n: number }>('select count(*)::int as n from ballot_box'))
  assert.equal(staged?.n, 1)
})

test('a tampered cookie or an administrator\'s is no voter session, and a cross-site post is refused before anything', DB, async (t) => {
  const x = await prepared(t)
  await open(x)
  const [school] = x.contests
  assert.ok(school)
  const box = x.boxes.get(school.id) ?? ''
  const voter = voterBrowser(x.s)
  ok(await voter.redeem(x.keys['2B']?.[0] ?? ''))
  const cookie = voter.jar.values.get('__Secure-voter-session') ?? ''
  const tampered = cookie.slice(0, 10) + (cookie[10] === 'A' ? 'B' : 'A') + cookie.slice(11)
  for (const value of [tampered, 'x', '']) {
    const res = await x.s.app.inject({ method: 'GET', url: '/api/voter/contests', headers: { ...SAME_ORIGIN, cookie: `__Secure-voter-session=${encodeURIComponent(value)}` } })
    assert.equal(res.statusCode, 401, value)
  }
  // Anna's admin cookie on the voter routes: nobody, as before, and her own routes still know her.
  const admin = await x.anna.request('GET', '/api/voter/contests')
  refused(admin, 401, 'no_session')
  ok(await x.anna.request('GET', x.base))
  // The voter's cookie on an admin route is never sent by a browser (its path), and means nothing if it were.
  const crossed = await x.s.app.inject({ method: 'GET', url: x.base, headers: { ...SAME_ORIGIN, cookie: voter.jar.header() } })
  assert.equal(crossed.statusCode, 401)
  const crossSite = await x.s.app.inject({ method: 'POST', url: '/api/voter/ballot', headers: { 'sec-fetch-site': 'cross-site', 'cookie': voter.jar.header() }, payload: { roundContestId: box, ballot: { kind: 'no' } } })
  assert.equal(crossSite.statusCode, 403)
})

test('the teacher\'s test runs through the same door: a key votes in the test, and again once the round has opened; a session from the test ends with it', DB, async (t) => {
  const x = await prepared(t)
  const [school] = x.contests
  assert.ok(school)
  const box = x.boxes.get(school.id) ?? ''
  const [paula, quirin, renate] = school.candidateIds
  const key = x.keys['2B']?.[0] ?? ''
  ok(await x.anna.request('POST', `${x.base}/rounds/regular/test`))
  const tester = voterBrowser(x.s)
  assert.equal(ok<VoterElection>(await tester.redeem(key)).round, 'testing')
  assert.deepEqual(ok(await tester.ballot(box, { kind: 'ranking', ranking: [paula, quirin, renate] })), { done: true, remaining: 0 })
  // Redeemed again while the test runs: the key has voted there already.
  assert.equal(ok<VoterElection>(await voterBrowser(x.s).redeem(key)).remaining, 0)
  // Three sessions of 1A keys from the test: one asks again after the test ended, one not before the next test, one not before the election has opened.
  const [idle, again, kept] = [voterBrowser(x.s), voterBrowser(x.s), voterBrowser(x.s)]
  ok(await idle.redeem(x.keys['1A']?.[0] ?? ''))
  ok(await again.redeem(x.keys['1A']?.[1] ?? ''))
  ok(await kept.redeem(x.keys['1A']?.[2] ?? ''))
  assert.deepEqual(ok<{ ballots: number, keys: number }>(await x.anna.request('POST', `${x.base}/rounds/regular/test/end`)), { election: 'prepared', round: 'planned', ballots: 1, keys: 1 })
  refused(await voterBrowser(x.s).redeem(key), 409, 'round_planned')
  refused(await idle.contests(), 409, 'round_planned')
  assert.equal(idle.jar.values.has('__Secure-voter-session'), false, 'the end of the test ended the session')
  // The next test is another phase of the round: a cookie from the first is no vote in it either.
  ok(await x.anna.request('POST', `${x.base}/rounds/regular/test`))
  refused(await again.ballot(box, { kind: 'ranking', ranking: [paula, quirin, renate] }), 401, 'no_session')
  const racer = voterBrowser(x.s)
  assert.equal(ok<VoterElection>(await racer.redeem(x.keys['1A']?.[1] ?? '')).remaining, 2, 'the key votes in the next test, redeemed again')
  // The end of this test and the start of the next, in one transaction held open while a ballot of this
  // test's session arrives: the ballot waits for the entitlements, finds the round in test mode again,
  // and is refused all the same, because the phase it was redeemed in is over.
  const roundId = (await withClient(x.s.ownerUrl, (client) => client.query<{ id: string }>(`select id from round where election_id = $1 and kind = 'regular'`, [x.id]))).rows[0]?.id ?? ''
  let commit: () => void = () => {}
  const held = new Promise<void>((resolve) => {
    commit = resolve
  })
  const transition = x.s.db.tx(async (client) => {
    const { rows: [ended] } = await client.query<{ ballots: number, keys: number }>('select ballots, keys from end_test($1)', [roundId])
    await client.query(`update round set state = 'testing' where id = $1`, [roundId])
    await held
    return ended
  })
  const waiting = () => withClient(x.s.ownerUrl, async (client) => (await client.query<{ n: number }>(
    `select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
  )).rows[0]?.n ?? 0)
  await sleep(50)
  const racing = racer.ballot(box, { kind: 'ranking', ranking: [paula, quirin, renate] })
  for (let i = 0; i < 200 && await waiting() === 0; i += 1) await sleep(25)
  assert.equal(await waiting(), 1, 'the ballot waits for the transition')
  commit()
  assert.deepEqual(await transition, { ballots: 0, keys: 0 })
  refused(await racing, 401, 'no_session')
  assert.equal(racer.jar.values.has('__Secure-voter-session'), false)
  assert.equal(ok<VoterElection>(await voterBrowser(x.s).redeem(x.keys['1A']?.[1] ?? '')).remaining, 2, 'the ballot was rolled back')
  assert.deepEqual(ok<{ ballots: number, keys: number }>(await x.anna.request('POST', `${x.base}/rounds/regular/test/end`)), { election: 'prepared', round: 'planned', ballots: 0, keys: 0 })
  await open(x)
  // A cookie from the test is no vote in the election: the key has to be redeemed again.
  refused(await kept.ballot(box, { kind: 'ranking', ranking: [paula, quirin, renate] }), 401, 'no_session')
  assert.equal(kept.jar.values.has('__Secure-voter-session'), false)
  refused(await kept.contests(), 401, 'no_session')
  const voter = voterBrowser(x.s)
  assert.equal(ok<VoterElection>(await voter.redeem(key)).round, 'open')
  assert.deepEqual(ok(await voter.ballot(box, { kind: 'ranking', ranking: [renate, quirin, paula] })), { done: true, remaining: 0 })
  assert.equal(ok<VoterElection>(await voterBrowser(x.s).redeem(x.keys['1A']?.[2] ?? '')).remaining, 2, 'the kept cookie cast nothing')
})

test('a candidate\'s picture reaches the voter by its content, for the voter\'s own contests only', DB, async (t) => {
  const x = await prepared(t)
  const [, klass] = x.contests
  assert.ok(klass)
  const [lena] = klass.candidateIds
  const photo = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#336699' } }).jpeg().toBuffer()
  const uploaded = ok<{ candidates: { id: string, picture: string | null }[] }>(await x.anna.request('PUT', `${x.base}/candidates/${lena}/picture`, { data: photo.toString('base64') }))
  const sha = uploaded.candidates.find((candidate) => candidate.id === lena)?.picture?.split('/').pop() ?? ''
  assert.match(sha, /^[0-9a-f]{64}$/)
  await open(x)
  const voter = voterBrowser(x.s)
  const election = ok<VoterElection>(await voter.redeem(x.keys['1A']?.[0] ?? ''))
  assert.equal(election.contests[0]?.candidates.find((candidate) => candidate.id === lena)?.picture, sha)
  const picture = await voter.request('GET', `/api/voter/picture/${sha}`)
  assert.equal(picture.statusCode, 200)
  assert.equal(picture.headers['content-type'], 'image/webp')
  assert.match(String(picture.headers['cache-control']), /immutable/)
  const again = await voter.request('GET', `/api/voter/picture/${sha}`, undefined, { 'if-none-match': String(picture.headers.etag) })
  assert.equal(again.statusCode, 304)
  const other = voterBrowser(x.s)
  ok(await other.redeem(x.keys['2B']?.[0] ?? ''))
  refused(await other.request('GET', `/api/voter/picture/${sha}`), 404, 'not_found')
})

test('a session that works leaves no log line, and the log never holds a key, an id or a cookie', DB, async (t) => {
  const x = await prepared(t)
  await open(x)
  const [school, klass] = x.contests
  assert.ok(school && klass)
  const before = x.s.logs().length
  const key = x.keys['1A']?.[0] ?? ''
  const voter = voterBrowser(x.s)
  const election = ok<VoterElection>(await voter.redeem(key))
  ok(await voter.contests())
  for (const contest of election.contests) {
    const ids = contest.candidates.map((candidate) => candidate.id)
    ok(await voter.ballot(contest.roundContestId, { kind: 'ranking', ranking: ids.slice(0, contest.activeSlots) }))
  }
  assert.equal((await voter.request('POST', '/api/voter/session/end')).statusCode, 204)
  assert.equal(x.s.logs().length, before, 'a session that works logs nothing')
  // Even the lines before it name none of what a voter sends or gets.
  const output = x.s.logs()
  for (const secret of [key, ...school.candidateIds, ...klass.candidateIds, ...x.boxes.values(), 'voter-session']) {
    assert.ok(!output.includes(secret), `log contains ${secret}`)
  }
  // No voter route has a parameter in its path but the picture's content hash.
  const voterRoutes = x.s.routes.filter((route) => route.url.startsWith('/api/voter')).map((route) => route.url)
  assert.deepEqual([...new Set(voterRoutes)].sort(), ['/api/voter/ballot', '/api/voter/contests', '/api/voter/picture/:sha256', '/api/voter/session', '/api/voter/session/end'])
})

test('an unknown key is answered after the limiter\'s wait, and refused when too many are waiting from one source', DB, async (t) => {
  const waits: number[] = []
  const limiter = new AttemptLimiter({ maxInFlight: 2 })
  const wait = async (ms: number) => {
    waits.push(ms)
  }
  const s = await electionApp(t, { voter: { limiter, wait } })
  const anna = await signIn(s, ANNA)
  await createElection(anna)
  const redeem = (ip: string) => s.app.inject({ method: 'POST', url: '/api/voter/session', remoteAddress: ip, headers: SAME_ORIGIN, payload: { key: unknownKey() } })
  for (const expected of [250, 500, 1000]) {
    const res = await redeem('198.51.100.7')
    assert.equal(res.statusCode, 404)
    assert.equal(waits.at(-1), expected)
  }
  // Two failing answers held up from one address: the third is refused at once, another address is not.
  // The wait reports when both answers are held, so the third never races them (and never hangs on the hold).
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let holding = 0
  let bothHeld: () => void = () => {}
  const twoHeld = new Promise<void>((resolve) => {
    bothHeld = resolve
  })
  const hold = (): Promise<void> => {
    holding += 1
    if (holding === 2) bothHeld()
    return held
  }
  const slow = await electionApp(t, { voter: { limiter: new AttemptLimiter({ maxInFlight: 2 }), wait: hold } })
  const pending = [redeemFrom(slow, '203.0.113.9'), redeemFrom(slow, '203.0.113.9')]
  await twoHeld
  const refusedNow = await redeemFrom(slow, '203.0.113.9')
  assert.equal(refusedNow.statusCode, 429)
  assert.deepEqual(refusedNow.json(), { error: 'rate_limited' })
  release()
  assert.deepEqual((await Promise.all(pending)).map((res) => res.statusCode), [404, 404])
  assert.equal((await redeemFrom(slow, '203.0.113.10')).statusCode, 404)
  assert.ok(!s.logs().includes('198.51.100.7') && !slow.logs().includes('203.0.113.9'), 'addresses are never logged')
})

function redeemFrom(s: ElectionApp, ip: string): Promise<LightMyRequestResponse> {
  return s.app.inject({ method: 'POST', url: '/api/voter/session', remoteAddress: ip, headers: SAME_ORIGIN, payload: { key: unknownKey() } })
}
