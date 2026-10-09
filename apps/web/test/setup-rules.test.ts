import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NEW_ELECTION, type Lifecycle } from '@school-election/election-core'
import { ERROR_MESSAGES, errorMessage, loginUrl, ApiError } from '../src/lib/api-rules.ts'
import { lockedText, MEMBER_STATUS_LABELS, problemText, ROLE_LABELS, ROUND_LABELS, RULESET_LABELS, STATE_LABELS, stateLabel, warningText } from '../src/lib/labels.ts'
import { isPresetId, PRESETS } from '../src/lib/presets.ts'
import { mayReadKeys, setupRules, type Permission } from '../src/lib/setup-rules.ts'

const OWNER: Permission[] = ['view', 'view-results', 'configure', 'prepare', 'issue-keys', 'run-rounds', 'manage-witnesses', 'manage-co-admins', 'transfer-lead', 'finalize']
const ADMIN: Permission[] = OWNER.filter((permission) => permission !== 'manage-co-admins' && permission !== 'transfer-lead' && permission !== 'finalize')
const WITNESS: Permission[] = ['view', 'view-results']

const DRAFT: Lifecycle = NEW_ELECTION
const PREPARED: Lifecycle = { election: 'prepared', regular: 'planned', runoff: null }
const ACTIVE: Lifecycle = { election: 'active', regular: 'open', runoff: null }
const CLOSED: Lifecycle = { election: 'active', regular: 'closed', runoff: null }
const FINAL: Lifecycle = { election: 'final', regular: 'closed', runoff: null }

test('the owner may change the structure in a draft only, candidates until voting starts, witnesses and co-admins until final, and keys from prepared until the round opens', () => {
  const draft = setupRules(DRAFT, OWNER)
  assert.deepEqual(draft, {
    structure: true, candidates: true, witnesses: true, coAdmins: true, lead: true, prepare: true, unprepare: false,
    issue: { regular: false, runoff: false }, replace: { regular: false, runoff: false },
  })
  const prepared = setupRules(PREPARED, OWNER)
  assert.deepEqual(prepared, {
    structure: false, candidates: true, witnesses: true, coAdmins: true, lead: true, prepare: false, unprepare: true,
    issue: { regular: true, runoff: true }, replace: { regular: true, runoff: true },
  })
  const active = setupRules(ACTIVE, OWNER)
  assert.deepEqual(active, {
    structure: false, candidates: false, witnesses: true, coAdmins: true, lead: true, prepare: false, unprepare: false,
    issue: { regular: false, runoff: true }, replace: { regular: false, runoff: true },
  })
  assert.deepEqual(setupRules(CLOSED, OWNER).issue, { regular: false, runoff: true })
  assert.deepEqual(setupRules(FINAL, OWNER), {
    structure: false, candidates: false, witnesses: false, coAdmins: false, lead: false, prepare: false, unprepare: false,
    issue: { regular: false, runoff: false }, replace: { regular: false, runoff: false },
  })
})

test('a co-admin may do everything but manage co-admins and hand over the lead; a witness may do nothing', () => {
  const admin = setupRules(PREPARED, ADMIN)
  assert.equal(admin.witnesses, true)
  assert.deepEqual({ ...admin, coAdmins: true, lead: true }, setupRules(PREPARED, OWNER))
  assert.equal(setupRules(FINAL, ADMIN).witnesses, false)
  for (const lifecycle of [DRAFT, PREPARED, ACTIVE, FINAL]) {
    assert.deepEqual(setupRules(lifecycle, WITNESS), {
      structure: false, candidates: false, witnesses: false, coAdmins: false, lead: false, prepare: false, unprepare: false,
      issue: { regular: false, runoff: false }, replace: { regular: false, runoff: false },
    })
  }
})

test('a witness reads keys once the batch\'s round has closed or the election is final; the owner and co-admins any time', () => {
  assert.equal(mayReadKeys('witness', PREPARED, 'regular'), false)
  assert.equal(mayReadKeys('witness', ACTIVE, 'regular'), false)
  assert.equal(mayReadKeys('witness', CLOSED, 'regular'), true)
  assert.equal(mayReadKeys('witness', CLOSED, 'runoff'), false)
  assert.equal(mayReadKeys('witness', { election: 'active', regular: 'closed', runoff: 'closed' }, 'runoff'), true)
  assert.equal(mayReadKeys('witness', FINAL, 'runoff'), true, 'the voided runoff keys of an election that held no runoff')
  assert.equal(mayReadKeys('owner', DRAFT, 'regular'), true)
  assert.equal(mayReadKeys('admin', ACTIVE, 'runoff'), true)
})

test('every state, role, ruleset, round kind and member status has its German word, and the lifecycle\'s every refusal its sentence', () => {
  assert.deepEqual(Object.keys(STATE_LABELS).sort(), ['active', 'draft', 'final', 'prepared'])
  assert.deepEqual(Object.keys(ROLE_LABELS).sort(), ['admin', 'owner', 'witness'])
  assert.deepEqual(Object.keys(RULESET_LABELS).sort(), ['at-representative-v1', 'at-school-speaker-v1', 'single-choice-v1'])
  assert.deepEqual(Object.keys(ROUND_LABELS).sort(), ['regular', 'runoff'])
  assert.deepEqual(Object.keys(MEMBER_STATUS_LABELS).sort(), ['bound', 'pending'])
  for (const code of ['election_final', 'not_draft', 'not_prepared', 'voting_started', 'round_planned', 'round_open', 'round_closed', 'round_testing', 'no_runoff', 'runoff_activated']) {
    assert.ok(ERROR_MESSAGES[code], code)
  }
  assert.equal(errorMessage(new ApiError(409, 'voting_started')), 'Die Stimmabgabe hat bereits begonnen.')
  assert.equal(errorMessage(new ApiError(418, 'something_new')), ERROR_MESSAGES.request_failed)
  assert.equal(errorMessage(new TypeError('network')), ERROR_MESSAGES.request_failed)
  assert.equal(lockedText('draft'), '')
  assert.ok(lockedText('prepared').includes('zurück zum Entwurf'))
})

test('the state line names the Wahlgang that runs or is counted, not just that the termin is active', () => {
  const at = (election: Lifecycle['election'], regular: Lifecycle['regular'], runoff: Lifecycle['runoff'] = null): string => stateLabel({ election, regular, runoff })
  assert.equal(at('draft', 'planned'), 'Entwurf')
  assert.equal(at('prepared', 'planned'), 'Vorbereitet')
  assert.equal(at('prepared', 'testing'), 'Probelauf')
  assert.equal(at('active', 'open'), '1. Wahlgang läuft')
  assert.equal(at('active', 'closed'), '1. Wahlgang ausgezählt')
  assert.equal(at('active', 'closed', 'open'), 'Stichwahl läuft')
  assert.equal(at('active', 'closed', 'closed'), 'Stichwahl ausgezählt')
  assert.equal(at('final', 'closed', 'closed'), 'Abgeschlossen')
  assert.equal(STATE_LABELS.active, 'Stimmabgabe begonnen', 'a list knows only the state of the termin, and says nothing a closed round would contradict')
})

test('what preparing reports is told in German with the names of the contest or group', () => {
  const names = { contest: (id: string) => `Wahl ${id}`, group: (id: string) => `Klasse ${id}` }
  assert.equal(problemText({ kind: 'contest-without-candidates', contestId: '1' }, names), 'Die Wahl „Wahl 1“ hat noch keine Kandidat:innen.')
  assert.equal(problemText({ kind: 'voter-group-without-contests', voterGroupId: '2' }, names), 'Die Klasse oder Gruppe „Klasse 2“ wählt in keiner Wahl.')
  assert.ok(problemText({ kind: 'no-contests' }, names).length > 0)
  assert.ok(problemText({ kind: 'no-voter-groups' }, names).length > 0)
  assert.ok(problemText({ kind: 'contest-without-voter-groups', contestId: '1' }, names).includes('Wahl 1'))
  assert.ok(warningText({ kind: 'too-few-witnesses', witnesses: 0 }).includes('niemand'))
  assert.ok(warningText({ kind: 'too-few-witnesses', witnesses: 1 }).includes('erst eine'))
  assert.ok(warningText({ kind: 'pending-invitations', count: 1 }).startsWith('Eine Einladung'))
  assert.ok(warningText({ kind: 'pending-invitations', count: 3 }).startsWith('3 Einladungen'))
  assert.ok(warningText({ kind: 'no-co-admin' }).includes('Co-Admin'))
})

test('the presets are the API\'s four, each with a label, and sign-in goes to Entra and back to a path of this app', () => {
  assert.deepEqual(PRESETS.map((preset) => preset.id), ['school-speaker', 'department-representative', 'class-representative', 'poll'])
  assert.ok(PRESETS.every((preset) => preset.label.length > 0 && preset.description.length > 0))
  assert.equal(isPresetId('poll'), true)
  assert.equal(isPresetId('ballot'), false)
  assert.equal(loginUrl('/wahlen/1'), '/api/auth/login?returnTo=%2Fwahlen%2F1')
  assert.equal(loginUrl('https://evil.example/'), '/api/auth/login?returnTo=%2F')
})
