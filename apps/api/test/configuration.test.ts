import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { LightMyRequestResponse } from 'fastify'
import sharp from 'sharp'
import { verifyAuditChain, type AuditEvent } from '../lib/audit-chain.ts'
import { MAX_CANDIDATES } from '../lib/configuration.ts'
import { DB, withClient } from './helpers/db.ts'
import { ANNA, auditActions, BERND, CARLA, createElection, electionApp, forceElectionState, signIn, WANDA, type Browser } from './helpers/elections.ts'

interface Candidate { id: string, surname: string, givenName: string, picture: string | null }
interface Contest { id: string, title: string, rulesetId: string, activeSlots: number, candidates: Candidate[] }
interface VoterGroup { id: string, name: string, contestIds: string[] }

const ok = <T>(res: LightMyRequestResponse, status = 200): T => {
  assert.equal(res.statusCode, status, res.body)
  return res.json<T>()
}
const refusal = (res: LightMyRequestResponse) => [res.statusCode, res.json<{ error: string }>().error]

/** Small steps of the setup screens, as one browser takes them. */
function setup(browser: Browser, id: string) {
  const base = `/api/elections/${id}`
  return {
    contest: async (title: string, rulesetId: string) => ok<Contest>(await browser.request('POST', `${base}/contests`, { title, rulesetId }), 201),
    candidate: async (contestId: string, surname: string, givenName = '') => ok<Contest>(await browser.request('POST', `${base}/contests/${contestId}/candidates`, { surname, givenName }), 201),
    group: async (name: string, contestIds: string[] = []) => {
      const group = ok<VoterGroup>(await browser.request('POST', `${base}/voter-groups`, { name }), 201)
      return contestIds.length === 0 ? group : ok<VoterGroup>(await browser.request('PUT', `${base}/voter-groups/${group.id}/contests`, { contestIds }))
    },
    configuration: async () => ok<{ contests: Contest[], voterGroups: VoterGroup[] }>(await browser.request('GET', `${base}/configuration`)),
  }
}

async function auditEvents(owner: Browser, id: string): Promise<AuditEvent[]> {
  return ok<{ events: AuditEvent[] }>(await owner.request('GET', `/api/elections/${id}/audit`)).events
}

test('presets start an election with their contests and fixed rulesets, each contest recorded', DB, async (t) => {
  const s = await electionApp(t)
  const anna = await signIn(s, ANNA)
  const expected = {
    'school-speaker': [['Schulsprecher/in', 'at-school-speaker-v1']],
    'department-representative': [['Abteilungssprecher/in', 'at-representative-v1']],
    'class-representative': [['Klassensprecher/in', 'at-representative-v1']],
    'poll': [['Abstimmung', 'single-choice-v1']],
  }
  for (const [preset, contests] of Object.entries(expected)) {
    const id = ok<{ id: string }>(await anna.request('POST', '/api/elections', { title: `Wahl ${preset}`, preset }), 201).id
    const configuration = await setup(anna, id).configuration()
    assert.deepEqual(configuration.contests.map((c) => [c.title, c.rulesetId]), contests, preset)
    assert.deepEqual(configuration.voterGroups, [])
    const events = await auditEvents(anna, id)
    assert.deepEqual(events.map((e) => e.action), ['election.created', 'contest.created'])
    assert.deepEqual(events[1]?.metadata, { contest: configuration.contests[0]?.id, title: contests[0]?.[0], rulesetId: contests[0]?.[1] })
  }
  const empty = await createElection(anna)
  assert.deepEqual(await setup(anna, empty).configuration(), { contests: [], voterGroups: [] })
  assert.equal((await anna.request('POST', '/api/elections', { title: 'Wahl', preset: 'referendum' })).statusCode, 400)
})

test('a teacher defines and prepares a combined school, department and class election, then corrects a name without going back to draft', DB, async (t) => {
  const s = await electionApp(t)
  const anna = await signIn(s, ANNA)
  const id = ok<{ id: string }>(await anna.request('POST', '/api/elections', { title: 'Schülervertretung 2026/27', preset: 'school-speaker' }), 201).id
  const base = `/api/elections/${id}`
  const steps = setup(anna, id)
  const school = (await steps.configuration()).contests[0]
  assert.ok(school)
  const it = await steps.contest('Abteilungssprecher/in IT', 'at-representative-v1')
  const klasse = await steps.contest('Klassensprecher/in 3AHIT', 'at-representative-v1')
  for (const [surname, givenName] of [['Wagner', 'Paul'], ['Özdemir', 'Elif'], ['Berger', 'Jonas'], ['Huber', 'Lena']] as const) await steps.candidate(school.id, surname, givenName)
  for (const [surname, givenName] of [['Fuchs', 'Mia'], ['Bauer', 'Tim']] as const) await steps.candidate(it.id, surname, givenName)
  await steps.candidate(klasse.id, 'Steiner', 'Noah')
  const g3 = await steps.group('3AHIT', [school.id, it.id, klasse.id])
  const g10 = await steps.group('10AHIT', [klasse.id, school.id])
  const g4 = await steps.group('4AHIT', [it.id, school.id])
  // A witness invited but not yet signed in.
  assert.equal((await anna.request('POST', `${base}/members`, { email: WANDA.email, role: 'witness' })).statusCode, 201)

  const configuration = await steps.configuration()
  assert.deepEqual(configuration.contests.map((c) => c.title), ['Abteilungssprecher/in IT', 'Klassensprecher/in 3AHIT', 'Schulsprecher/in'])
  assert.deepEqual(configuration.contests.map((c) => c.activeSlots), [2, 1, 4])
  assert.deepEqual(configuration.contests[2]?.candidates.map((c) => c.surname), ['Berger', 'Huber', 'Özdemir', 'Wagner'])
  // Classes by name with numbers as numbers, each with its contests in contest order.
  assert.deepEqual(configuration.voterGroups.map((g) => [g.name, g.contestIds]), [
    ['3AHIT', [it.id, klasse.id, school.id]],
    ['4AHIT', [it.id, school.id]],
    ['10AHIT', [klasse.id, school.id]],
  ])

  const preview = ok<{ problems: unknown[], warnings: unknown[] }>(await anna.request('GET', `${base}/preparation`))
  assert.deepEqual(preview.problems, [])
  const prepared = ok<{ state: string, summary: unknown, warnings: unknown }>(await anna.request('POST', `${base}/prepare`))
  assert.equal(prepared.state, 'prepared')
  assert.deepEqual(prepared.warnings, [{ kind: 'no-co-admin' }, { kind: 'too-few-witnesses', witnesses: 0 }, { kind: 'pending-invitations', count: 1 }])
  assert.deepEqual(prepared.warnings, preview.warnings)
  assert.deepEqual(prepared.summary, {
    voterGroups: [
      { id: g3.id, name: '3AHIT', contests: [{ id: it.id, title: 'Abteilungssprecher/in IT' }, { id: klasse.id, title: 'Klassensprecher/in 3AHIT' }, { id: school.id, title: 'Schulsprecher/in' }] },
      { id: g4.id, name: '4AHIT', contests: [{ id: it.id, title: 'Abteilungssprecher/in IT' }, { id: school.id, title: 'Schulsprecher/in' }] },
      { id: g10.id, name: '10AHIT', contests: [{ id: klasse.id, title: 'Klassensprecher/in 3AHIT' }, { id: school.id, title: 'Schulsprecher/in' }] },
    ],
    contests: [
      { id: it.id, title: 'Abteilungssprecher/in IT', rulesetId: 'at-representative-v1', candidates: 2, activeSlots: 2 },
      { id: klasse.id, title: 'Klassensprecher/in 3AHIT', rulesetId: 'at-representative-v1', candidates: 1, activeSlots: 1 },
      { id: school.id, title: 'Schulsprecher/in', rulesetId: 'at-school-speaker-v1', candidates: 4, activeSlots: 4 },
    ],
  })
  assert.equal(ok<{ state: string }>(await anna.request('GET', base)).state, 'prepared')
  // The regular round, planned, with one ballot box per contest.
  const boxes = async () => withClient(s.ownerUrl, async (client) => (await client.query<{ round: string, state: string, contest: string }>(
    `select r.id as round, r.state, rc.contest_id as contest from round r join round_contest rc on rc.round_id = r.id
      where r.election_id = $1 and r.kind = 'regular' order by rc.contest_id`, [id])).rows)
  const before = await boxes()
  assert.deepEqual(before.map((b) => b.contest), [it.id, klasse.id, school.id].sort())
  assert.ok(before.every((b) => b.state === 'planned' && b.round === before[0]?.round))

  // Prepared: a misspelled name is corrected, a candidate added and one
  // withdrawn; each is recorded and the slots follow.
  const wagner = configuration.contests[2]?.candidates.find((c) => c.surname === 'Wagner')
  assert.ok(wagner)
  const renamed = ok<Contest>(await anna.request('PATCH', `${base}/candidates/${wagner.id}`, { surname: 'Wägner' }))
  assert.deepEqual(renamed.candidates.map((c) => `${c.givenName} ${c.surname}`), ['Jonas Berger', 'Lena Huber', 'Elif Özdemir', 'Paul Wägner'])
  assert.equal((await steps.candidate(school.id, 'Aigner', 'Sara')).activeSlots, 5)
  const withdrawn = ok<Contest>(await anna.request('DELETE', `${base}/candidates/${renamed.candidates[1]?.id}`))
  assert.deepEqual([withdrawn.activeSlots, withdrawn.candidates.map((c) => c.surname)], [4, ['Aigner', 'Berger', 'Özdemir', 'Wägner']])
  const title = ok<{ title: string, description: string }>(await anna.request('PATCH', base, { title: 'Schülervertretungswahl 2026/27', description: 'Am 12. Oktober im Turnsaal.' }))
  assert.deepEqual([title.title, title.description], ['Schülervertretungswahl 2026/27', 'Am 12. Oktober im Turnsaal.'])
  const summary = ok<{ summary: { contests: { candidates: number, activeSlots: number }[] } }>(await anna.request('GET', `${base}/preparation`)).summary
  assert.deepEqual(summary.contests.map((c) => [c.candidates, c.activeSlots]), [[2, 2], [1, 1], [4, 4]])

  // The structure is fixed: every change of it is refused with the reason.
  const eventsBefore = await auditActions(anna, id)
  for (const [method, path, body] of [
    ['POST', '/contests', { title: 'Tagessprecher/in', rulesetId: 'at-representative-v1' }],
    ['PATCH', `/contests/${it.id}`, { title: 'Abteilungssprecher/in Informatik' }],
    ['DELETE', `/contests/${klasse.id}`, undefined],
    ['POST', '/voter-groups', { name: '5AHIT' }],
    ['PATCH', `/voter-groups/${g4.id}`, { name: '4BHIT' }],
    ['DELETE', `/voter-groups/${g10.id}`, undefined],
    ['PUT', `/voter-groups/${g4.id}/contests`, { contestIds: [school.id] }],
    ['POST', '/prepare', undefined],
  ] as const) {
    assert.deepEqual(refusal(await anna.request(method, `${base}${path}`, body)), [409, 'not_draft'], `${method} ${path}`)
  }
  // A prepared contest keeps a candidate: without one it has no ballot.
  const steiner = configuration.contests[1]?.candidates[0]
  assert.ok(steiner)
  assert.deepEqual(refusal(await anna.request('DELETE', `${base}/candidates/${steiner.id}`)), [409, 'last_candidate'])
  assert.deepEqual(await auditActions(anna, id), eventsBefore)

  // Back to draft, a contest more, and prepared again: the round stays and
  // gains the new contest's ballot box.
  assert.deepEqual(ok(await anna.request('POST', `${base}/unprepare`)), { state: 'draft' })
  assert.deepEqual(refusal(await anna.request('POST', `${base}/unprepare`)), [409, 'not_prepared'])
  const day = await steps.contest('Tagessprecher/in', 'at-representative-v1')
  await steps.candidate(day.id, 'Lang', 'Eva')
  await anna.request('PUT', `${base}/voter-groups/${g4.id}/contests`, { contestIds: [it.id, school.id, day.id] })
  ok(await anna.request('POST', `${base}/prepare`))
  const after = await boxes()
  assert.deepEqual(after.map((b) => b.contest), [it.id, klasse.id, school.id, day.id].sort())
  assert.ok(after.every((b) => b.round === before[0]?.round))

  const events = await auditEvents(anna, id)
  assert.equal(verifyAuditChain(events).valid, true)
  assert.ok(events.every((e) => e.actor.oid === ANNA.oid))
  const actions = events.map((e) => e.action)
  for (const action of ['candidate.renamed', 'candidate.added', 'candidate.removed', 'election.updated', 'election.prepared', 'election.unprepared', 'voter-group.contest-added']) {
    assert.ok(actions.includes(action), action)
  }
  assert.deepEqual(events.find((e) => e.action === 'candidate.renamed')?.metadata, { candidate: wagner.id, surname: 'Wägner', givenName: 'Paul' })
  assert.deepEqual(events.find((e) => e.action === 'election.prepared')?.metadata, { contests: 3, voterGroups: 3, candidates: 7 })
  assert.deepEqual(events.filter((e) => e.action === 'election.prepared').map((e) => e.metadata.contests), [3, 4])
})

test('candidates are listed by surname, then given name, in German collation; names that compare equal are refused', DB, async (t) => {
  const s = await electionApp(t)
  const anna = await signIn(s, ANNA)
  const id = await createElection(anna)
  const steps = setup(anna, id)
  const contest = await steps.contest('Schulsprecher/in', 'at-school-speaker-v1')
  for (const [surname, givenName] of [
    ['Zöhrer', 'Anna'], ['Österreicher', 'Max'], ['Ofner', 'Lisa'], ['Oberhuber', 'Tom'], ['Müller', 'Anna'], ['Muller', 'Anna'],
    ['Mueller', 'Anna'], ['Müller', 'Andreas'], ['van Dyk', 'Ida'], ['Strauß', 'Eva'], ['Strauss', 'Eva'], ['Ja', ''],
  ] as const) await steps.candidate(contest.id, surname, givenName)
  const listed = (await steps.configuration()).contests[0]?.candidates.map((c) => `${c.surname}, ${c.givenName}`)
  assert.deepEqual(listed, [
    'Ja, ', 'Mueller, Anna', 'Muller, Anna', 'Müller, Andreas', 'Müller, Anna', 'Oberhuber, Tom', 'Ofner, Lisa', 'Österreicher, Max',
    'Strauss, Eva', 'Strauß, Eva', 'van Dyk, Ida', 'Zöhrer, Anna',
  ])

  const base = `/api/elections/${id}`
  const before = await auditActions(anna, id)
  // Case, decomposed umlauts and extra white space make no different name.
  for (const [surname, givenName] of [['müller', 'ANNA'], ['Müller', 'Anna'], ['  Müller ', '  Anna'], ['Van Dyk', 'Ida']]) {
    const res = await anna.request('POST', `${base}/contests/${contest.id}/candidates`, { surname, givenName })
    assert.deepEqual(refusal(res), [409, 'duplicate_candidate'], `${surname} ${givenName}`)
  }
  const ofner = (await steps.configuration()).contests[0]?.candidates.find((c) => c.surname === 'Ofner')
  assert.ok(ofner)
  assert.deepEqual(refusal(await anna.request('PATCH', `${base}/candidates/${ofner.id}`, { surname: 'oberhuber', givenName: 'tom' })), [409, 'duplicate_candidate'])
  assert.deepEqual(await auditActions(anna, id), before)

  // Names are stored cleaned: NFC, trimmed, single spaces.
  const cleaned = ok<Contest>(await anna.request('PATCH', `${base}/candidates/${ofner.id}`, { surname: '  Ofner  Gruber ', givenName: 'Lísa' }), 200)
  assert.ok(cleaned.candidates.some((c) => c.surname === 'Ofner Gruber' && c.givenName === 'Lísa'))
  // The same name in another contest is fine.
  const other = await steps.contest('Abstimmung', 'single-choice-v1')
  assert.equal((await steps.candidate(other.id, 'Müller', 'Anna')).candidates.length, 1)
  for (const body of [{ surname: '', givenName: 'Anna' }, { surname: '   ', givenName: '' }, { surname: 'A\nB', givenName: '' }, { surname: 'x'.repeat(101), givenName: '' }, { surname: 'Ok' }]) {
    assert.equal((await anna.request('POST', `${base}/contests/${contest.id}/candidates`, body)).statusCode, 400, JSON.stringify(body))
  }
  // 100 code points that NFC turns into 200 are too long once stored.
  const expanding = { surname: 'Huber', givenName: '\u0344'.repeat(100) }
  assert.deepEqual(refusal(await anna.request('POST', `${base}/contests/${contest.id}/candidates`, expanding)), [400, 'too_long'])
  assert.deepEqual(refusal(await anna.request('POST', `${base}/voter-groups`, { name: '\u0344'.repeat(100) })), [400, 'too_long'])
})

test('contest titles and voter group names are unique within an election; references stay within it', DB, async (t) => {
  const s = await electionApp(t)
  const anna = await signIn(s, ANNA)
  const id = await createElection(anna)
  const otherId = await createElection(anna, 'Andere Wahl')
  const base = `/api/elections/${id}`
  const steps = setup(anna, id)
  const contest = await steps.contest('Klassensprecher/in 2A', 'at-representative-v1')
  const foreign = await setup(anna, otherId).contest('Abstimmung', 'single-choice-v1')
  const group = await steps.group('2A')
  const before = await auditActions(anna, id)

  assert.deepEqual(refusal(await anna.request('POST', `${base}/contests`, { title: ' klassensprecher/IN 2a', rulesetId: 'at-representative-v1' })), [409, 'duplicate_title'])
  assert.deepEqual(refusal(await anna.request('POST', `${base}/voter-groups`, { name: '2a' })), [409, 'duplicate_name'])
  assert.equal((await anna.request('POST', `${base}/contests`, { title: 'Wahl', rulesetId: 'at-mayor-v1' })).statusCode, 400)
  assert.deepEqual(refusal(await anna.request('PUT', `${base}/voter-groups/${group.id}/contests`, { contestIds: [contest.id, foreign.id] })), [422, 'unknown_contest'])
  assert.equal((await anna.request('PUT', `${base}/voter-groups/${group.id}/contests`, { contestIds: [contest.id, contest.id] })).statusCode, 400)
  assert.deepEqual(refusal(await anna.request('PATCH', `${base}/contests/${foreign.id}`, { title: 'X' })), [404, 'not_found'])
  assert.deepEqual(refusal(await anna.request('DELETE', `${base}/contests/${foreign.id}`)), [404, 'not_found'])
  assert.deepEqual(refusal(await anna.request('POST', `${base}/contests/${foreign.id}/candidates`, { surname: 'X', givenName: '' })), [404, 'not_found'])
  assert.equal((await anna.request('PATCH', `${base}/contests/${contest.id}`, {})).statusCode, 400)
  assert.deepEqual(await auditActions(anna, id), before)

  // An unchanged value records nothing; a rename and a removal do, with their ids.
  ok(await anna.request('PATCH', `${base}/contests/${contest.id}`, { title: 'Klassensprecher/in 2A' }))
  ok(await anna.request('PATCH', `${base}/voter-groups/${group.id}`, { name: '2A' }))
  assert.deepEqual(await auditActions(anna, id), before)
  ok(await anna.request('PATCH', `${base}/contests/${contest.id}`, { rulesetId: 'at-school-speaker-v1' }))
  await steps.candidate(contest.id, 'Huber', 'Lena')
  ok(await anna.request('PUT', `${base}/voter-groups/${group.id}/contests`, { contestIds: [contest.id] }))
  assert.equal((await anna.request('DELETE', `${base}/contests/${contest.id}`)).statusCode, 204)
  assert.deepEqual((await steps.configuration()).voterGroups, [{ id: group.id, name: '2A', contestIds: [] }])
  assert.equal((await anna.request('DELETE', `${base}/voter-groups/${group.id}`)).statusCode, 204)
  const events = await auditEvents(anna, id)
  assert.deepEqual(events.slice(before.length).map((e) => [e.action, e.metadata]), [
    ['contest.updated', { contest: contest.id, title: 'Klassensprecher/in 2A', rulesetId: 'at-school-speaker-v1' }],
    ['candidate.added', { contest: contest.id, candidate: events.find((e) => e.action === 'candidate.added')?.metadata.candidate, surname: 'Huber', givenName: 'Lena' }],
    ['voter-group.contest-added', { group: group.id, contest: contest.id }],
    ['contest.removed', { contest: contest.id, title: 'Klassensprecher/in 2A', candidates: 1 }],
    ['voter-group.removed', { group: group.id, name: '2A' }],
  ])
})

test('prepare names what blocks it and changes nothing', DB, async (t) => {
  const s = await electionApp(t)
  const anna = await signIn(s, ANNA)
  const id = await createElection(anna)
  const base = `/api/elections/${id}`
  const steps = setup(anna, id)
  const notReady = async () => {
    const res = await anna.request('POST', `${base}/prepare`)
    assert.equal(res.statusCode, 409)
    const body = res.json<{ error: string, problems: unknown[] }>()
    assert.equal(body.error, 'not_ready')
    return body.problems
  }
  assert.deepEqual(await notReady(), [{ kind: 'no-contests' }, { kind: 'no-voter-groups' }])
  const contest = await steps.contest('Abstimmung', 'single-choice-v1')
  const group = await steps.group('Lehrkörper')
  assert.deepEqual(await notReady(), [
    { kind: 'contest-without-candidates', contestId: contest.id },
    { kind: 'contest-without-voter-groups', contestId: contest.id },
    { kind: 'voter-group-without-contests', voterGroupId: group.id },
  ])
  assert.deepEqual(ok<{ problems: unknown[] }>(await anna.request('GET', `${base}/preparation`)).problems.length, 3)
  assert.equal(ok<{ state: string }>(await anna.request('GET', base)).state, 'draft')
  assert.ok(!(await auditActions(anna, id)).includes('election.prepared'))
  // A poll with a single option and two witnesses and a co-admin who have signed in: no warnings.
  await steps.candidate(contest.id, 'Neue Hausordnung')
  await anna.request('PUT', `${base}/voter-groups/${group.id}/contests`, { contestIds: [contest.id] })
  for (const [person, role] of [[WANDA, 'witness'], [BERND, 'witness'], [CARLA, 'admin']] as const) {
    assert.equal((await anna.request('POST', `${base}/members`, { email: person.email, role })).statusCode, 201)
    await signIn(s, person)
  }
  const prepared = ok<{ warnings: unknown[], summary: { contests: unknown[] } }>(await anna.request('POST', `${base}/prepare`))
  assert.deepEqual(prepared.warnings, [])
  assert.deepEqual(prepared.summary.contests, [{ id: contest.id, title: 'Abstimmung', rulesetId: 'single-choice-v1', candidates: 1, activeSlots: 1 }])
})

test('witnesses read the configuration but change nothing; once voting has started or the election is final, nothing changes', DB, async (t) => {
  const s = await electionApp(t)
  const anna = await signIn(s, ANNA)
  const id = ok<{ id: string }>(await anna.request('POST', '/api/elections', { title: 'Klassensprecherwahl 3B', preset: 'class-representative' }), 201).id
  const base = `/api/elections/${id}`
  const steps = setup(anna, id)
  const contest = (await steps.configuration()).contests[0]
  assert.ok(contest)
  const candidate = (await steps.candidate(contest.id, 'Huber', 'Lena')).candidates[0]
  assert.ok(candidate)
  const group = await steps.group('3B', [contest.id])
  await anna.request('POST', `${base}/members`, { email: WANDA.email, role: 'witness' })
  const wanda = await signIn(s, WANDA)

  // Each change, and why it is refused once voting has started: the
  // structure was fixed by preparing, everything else by voting.
  const changes = [
    ['PATCH', '', { title: 'Wahl' }, 'voting_started'],
    ['POST', '/contests', { title: 'Wahl', rulesetId: 'single-choice-v1' }, 'not_draft'],
    ['PATCH', `/contests/${contest.id}`, { title: 'Wahl' }, 'not_draft'],
    ['DELETE', `/contests/${contest.id}`, undefined, 'not_draft'],
    ['POST', `/contests/${contest.id}/candidates`, { surname: 'Wagner', givenName: 'Paul' }, 'voting_started'],
    ['PATCH', `/candidates/${candidate.id}`, { surname: 'Hubert' }, 'voting_started'],
    ['DELETE', `/candidates/${candidate.id}`, undefined, 'voting_started'],
    ['POST', '/voter-groups', { name: '3C' }, 'not_draft'],
    ['PATCH', `/voter-groups/${group.id}`, { name: '3C' }, 'not_draft'],
    ['DELETE', `/voter-groups/${group.id}`, undefined, 'not_draft'],
    ['PUT', `/voter-groups/${group.id}/contests`, { contestIds: [] }, 'not_draft'],
    ['POST', '/prepare', undefined, 'not_draft'],
    ['POST', '/unprepare', undefined, 'voting_started'],
  ] as const
  const before = await auditActions(anna, id)
  for (const path of ['/configuration', '/preparation']) assert.equal((await wanda.request('GET', `${base}${path}`)).statusCode, 200, path)
  for (const [method, path, body] of changes) {
    assert.deepEqual(refusal(await wanda.request(method, `${base}${path}`, body)), [403, 'forbidden'], `${method} ${path}`)
  }
  assert.deepEqual(await auditActions(anna, id), before)
  ok(await anna.request('POST', `${base}/prepare`))

  // Voting has started (no route opens a round yet), then the election is final.
  for (const state of ['active', 'final'] as const) {
    await forceElectionState(s.ownerUrl, id, state)
    const recorded = await auditActions(anna, id)
    for (const [method, path, body, started] of changes) {
      const expected = state === 'final' ? 'election_final' : started
      assert.deepEqual(refusal(await anna.request(method, `${base}${path}`, body)), [409, expected], `${state}: ${method} ${path}`)
    }
    assert.deepEqual(await auditActions(anna, id), recorded)
  }
})

test('ids in uppercase work as in lowercase; titles are cleaned; a description is counted in code points', DB, async (t) => {
  const s = await electionApp(t)
  const anna = await signIn(s, ANNA)
  const id = ok<{ id: string, title: string }>(await anna.request('POST', '/api/elections', { title: '  Wahl \u00a0 2026 ' }), 201)
  assert.equal(id.title, 'Wahl 2026')
  const base = `/api/elections/${id.id}`
  const steps = setup(anna, id.id)
  const contest = await steps.contest('Schulsprecher/in', 'at-school-speaker-v1')
  const group = await steps.group('2a')
  const candidate = (await steps.candidate(contest.id, 'Huber', 'Lena')).candidates[0]
  assert.ok(candidate)
  const upper = (value: string) => value.toUpperCase()

  ok(await anna.request('PATCH', `${base}/contests/${upper(contest.id)}`, { rulesetId: 'at-representative-v1' }))
  assert.equal(ok<VoterGroup>(await anna.request('PATCH', `${base}/voter-groups/${upper(group.id)}`, { name: '2A' })).name, '2A')
  const renamed = ok<Contest>(await anna.request('PATCH', `${base}/candidates/${upper(candidate.id)}`, { givenName: 'LENA' }))
  assert.equal(renamed.candidates[0]?.givenName, 'LENA')
  const photo = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#468' } }).jpeg().toBuffer()
  for (let i = 0; i < 2; i++) {
    ok(await anna.request('PUT', `${base}/candidates/${upper(candidate.id)}/picture`, { data: photo.toString('base64') }))
  }
  ok(await anna.request('PATCH', base, { title: ' Wahl  2026 ' }))
  const description = `${'x'.repeat(1999)}🎉`
  assert.equal(ok<{ description: string }>(await anna.request('PATCH', base, { description })).description, description)
  await steps.candidate(contest.id, 'Wagner', 'Paul')
  assert.equal(ok<Contest>(await anna.request('DELETE', `${base}/candidates/${upper(candidate.id)}`)).candidates.length, 1)

  const events = await auditEvents(anna, id.id)
  assert.deepEqual(events.map((e) => e.action), [
    'election.created', 'contest.created', 'voter-group.created', 'candidate.added', 'contest.updated', 'voter-group.renamed',
    'candidate.renamed', 'candidate.picture-set', 'election.updated', 'candidate.added', 'candidate.removed',
  ])
  assert.deepEqual(events[0]?.metadata, { title: 'Wahl 2026' })
  assert.deepEqual(events.find((e) => e.action === 'candidate.renamed')?.metadata, { candidate: candidate.id, surname: 'Huber', givenName: 'LENA' })
  assert.equal(verifyAuditChain(events).valid, true)
})

test('a contest holds at most fifty candidates, which is what a lot among all of them can be recorded with', DB, async (t) => {
  const s = await electionApp(t)
  const anna = await signIn(s, ANNA)
  const id = await createElection(anna)
  const base = `/api/elections/${id}`
  const { id: contestId } = ok<{ id: string }>(await anna.request('POST', `${base}/contests`, { title: 'Alle', rulesetId: 'at-school-speaker-v1' }), 201)
  for (let n = 0; n < MAX_CANDIDATES; n++) {
    ok(await anna.request('POST', `${base}/contests/${contestId}/candidates`, { surname: `Nummer${String(n).padStart(2, '0')}`, givenName: 'K' }), 201)
  }
  assert.deepEqual(refusal(await anna.request('POST', `${base}/contests/${contestId}/candidates`, { surname: 'Einer zu viel', givenName: 'K' })), [409, 'too_many_candidates'])
})
