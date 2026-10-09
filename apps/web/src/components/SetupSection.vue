<script setup lang="ts">
// Einrichten: the election's title and description, its contests, each a
// panel of candidate cards with the picture on top and the form to add one
// as the last card, and the classes and groups as a grid, a row each and a
// column per contest, ticked where the class votes. Classes are added one
// or a pasted list at a time, a whole column is ticked at once, and a
// termin without classes is offered one group for everyone. What may change now comes from the rules
// (lib/setup-rules.ts): everything in a draft, candidates and the title
// until voting starts, nothing for a witness. Every change goes to its
// route and the page reads the configuration again.
//
// Each form keeps its own state, keyed by what it edits: while it saves,
// only its own controls wait; a refusal shows next to it; a form whose
// fields differ from what the server said last says "Nicht gespeichert",
// and one saved since its last edit says "Gespeichert". A change that went
// through is confirmed by a toast.
//
// Fields save themselves: a text field when it is left (blur, which unlike
// change also fires for a value put back after an Enter) or Enter is
// pressed, a choice when it is made, and only when the form differs from
// what the server said last. Creating something and removing it stay
// explicit. The buttons that ask before a removal stay enabled while
// their form saves, since leaving a field for them starts that save and a
// disabled button would drop the focus; their "Ja, entfernen" waits. Removing anything asks first, in place,
// naming what goes with it.

import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, useId, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router'
import { RULESET_IDS, type RulesetId } from '@school-election/election-core'
import CandidatePicture from './CandidatePicture.vue'
import LineIcon from './LineIcon.vue'
import SaveState from './SaveState.vue'
import { apiDelete, apiPatch, apiPost, apiPut } from '../lib/api.ts'
import { withBase } from '../lib/base.ts'
import { ApiError, errorMessage } from '../lib/api-rules.ts'
import { lockedText, RULESET_LABELS } from '../lib/labels.ts'
import type { PreparedPicture } from '../lib/picture.ts'
import { toBase64, uploadMessage } from '../lib/picture-rules.ts'
import type { SetupRules } from '../lib/setup-rules.ts'
import { notify } from '../lib/toast.ts'
import type { Candidate, Configuration, Contest, ElectionDetail, VoterGroup } from '../lib/types.ts'

const props = defineProps<{
  election: ElectionDetail
  configuration: Configuration
  rules: SetupRules
}>()

const emit = defineEmits<{ changed: [] }>()

const base = computed(() => `/api/elections/${props.election.id}`)
const ids = { title: useId(), description: useId(), pictureHint: useId(), contestTitle: useId(), contestRuleset: useId(), groupName: useId(), groupHint: useId() }

/** The forms whose change is on its way, by key ("election", "contest:<id>", "candidate:<id>", ...). */
const pending = reactive(new Set<string>())
/** Why a form's last change was refused, by key, until its next attempt. */
const errors = reactive<Record<string, string>>({})
/** The forms saved since their last edit. */
const saved = reactive(new Set<string>())
/** The removal waiting for its confirmation, by key; a change of what may change closes it. */
const confirming = ref<string | null>(null)
watch([() => props.rules.structure, () => props.rules.candidates], () => {
  confirming.value = null
})

// What is being edited, taken from the election and its configuration
// when the page reads them again, unless the person has changed it since:
// a draft that still equals what the server said last keeps following
// the server, a draft someone typed into stays until they save it. Saving
// makes it follow the server again, which may have trimmed what was typed.
const draft = reactive({ title: '', description: '' })
const contestDrafts = reactive<Record<string, { title: string, rulesetId: RulesetId }>>({})
const candidateDrafts = reactive<Record<string, { surname: string, givenName: string }>>({})
const groupDrafts = reactive<Record<string, string>>({})
/** Each group's contests as the page knows them: changed at once on a click, so a second click builds on the first. */
const votes = reactive<Record<string, string[]>>({})
const newContest = reactive<{ title: string, rulesetId: RulesetId }>({ title: '', rulesetId: 'at-representative-v1' })
const newCandidates = reactive<Record<string, { surname: string, givenName: string }>>({})
const newGroup = ref('')
/** What the server said last, to tell an untouched draft from a typed one. */
const served = reactive<{
  election: { title: string, description: string }
  contests: Record<string, { title: string, rulesetId: RulesetId }>
  candidates: Record<string, { surname: string, givenName: string }>
  groups: Record<string, string>
}>({ election: { title: '', description: '' }, contests: {}, candidates: {}, groups: {} })

const same = (a: Record<string, string> | undefined, b: Record<string, string> | undefined) =>
  a !== undefined && b !== undefined && Object.keys(a).every((key) => a[key] === b[key])

watch(() => props.election, (election) => {
  if (draft.title === served.election.title) draft.title = election.title
  if (draft.description === served.election.description) draft.description = election.description
  served.election = { title: election.title, description: election.description }
}, { immediate: true })

watch(() => props.configuration, (configuration) => {
  for (const contest of configuration.contests) {
    const next = { title: contest.title, rulesetId: contest.rulesetId }
    if (same(contestDrafts[contest.id], served.contests[contest.id]) || !contestDrafts[contest.id]) contestDrafts[contest.id] = { ...next }
    served.contests[contest.id] = next
    newCandidates[contest.id] ??= { surname: '', givenName: '' }
    for (const candidate of contest.candidates) {
      const name = { surname: candidate.surname, givenName: candidate.givenName }
      if (same(candidateDrafts[candidate.id], served.candidates[candidate.id]) || !candidateDrafts[candidate.id]) candidateDrafts[candidate.id] = { ...name }
      served.candidates[candidate.id] = name
    }
  }
  for (const group of configuration.voterGroups) {
    if (groupDrafts[group.id] === served.groups[group.id] || groupDrafts[group.id] === undefined) groupDrafts[group.id] = group.name
    served.groups[group.id] = group.name
    // A reload another form started must not undo boxes whose own save is
    // still on its way: the next click would send a list without them.
    if (!pending.has(`votes:${group.id}`)) votes[group.id] = [...group.contestIds]
  }
}, { immediate: true })

const locked = computed(() => lockedText(props.election.state))

const electionDirty = () => draft.title !== served.election.title || draft.description !== served.election.description
const contestDirty = (id: string) => !same(contestDrafts[id], served.contests[id])
const candidateDirty = (id: string) => !same(candidateDrafts[id], served.candidates[id])
const groupDirty = (id: string) => groupDrafts[id] !== served.groups[id]

/** What a form says about its fields: waiting, unsaved or saved; nothing while it is untouched or refused. */
function saveState(key: string, dirty: boolean): string {
  if (pending.has(key)) return 'Wird gespeichert …'
  if (errors[key]) return ''
  if (dirty) return 'Nicht gespeichert'
  return saved.has(key) ? 'Gespeichert' : ''
}

/** Typed or saving and not yet stored: leaving the page would lose it. */
const unsaved = computed(() => {
  if (!props.rules.candidates) return false
  if (pending.size > 0 || electionDirty()) return true
  if (newContest.title.trim() !== '' || newGroup.value.trim() !== '') return true
  return props.configuration.contests.some((contest) =>
    contestDirty(contest.id)
    || Object.values(newCandidates[contest.id] ?? {}).some((value) => value.trim() !== '')
    || contest.candidates.some((candidate) => candidateDirty(candidate.id)))
  || props.configuration.voterGroups.some((group) => groupDirty(group.id))
})

const LEAVE_QUESTION = 'Es gibt Änderungen, die noch nicht gespeichert sind. Seite trotzdem verlassen?'
function onBeforeUnload(event: BeforeUnloadEvent): void {
  if (unsaved.value) event.preventDefault()
}
onMounted(() => window.addEventListener('beforeunload', onBeforeUnload))
onBeforeUnmount(() => window.removeEventListener('beforeunload', onBeforeUnload))
onBeforeRouteLeave(() => !unsaved.value || window.confirm(LEAVE_QUESTION))
// Another termin on the same page (the browser's history can jump there) reuses this page and clears it.
onBeforeRouteUpdate((to, from) => to.params.id === from.params.id || !unsaved.value || window.confirm(LEAVE_QUESTION))

/** The save to repeat for a form whose last save was refused, offered as "Noch einmal". */
const retries = reactive(new Map<string, () => void>())
/** Forms changed again while their save was on its way: saved once more when it is done. */
const again = new Set<string>()
/** What a form's refused save sent: leaving a field does not send it again, a change or "Noch einmal" does. */
const refusedValues = new Map<string, string>()

/**
 * Saves a form if its fields differ from what the server said last: one
 * save at a time per form, and a change made meanwhile is looked at again
 * right after it, even one that puts the form back, since the save on its
 * way may store what it undid. A form put back to what is stored has
 * nothing to save, and an earlier refusal no longer applies to it.
 */
async function autoSave(key: string, dirty: () => boolean, save: () => Promise<void>, values: () => string, retry = false): Promise<void> {
  if (pending.has(key)) {
    again.add(key)
    return
  }
  if (!dirty()) {
    delete errors[key]
    retries.delete(key)
    refusedValues.delete(key)
    return
  }
  const sending = values()
  if (!retry && errors[key] && refusedValues.get(key) === sending) return
  retries.delete(key)
  await save()
  if (errors[key]) {
    refusedValues.set(key, sending)
    retries.set(key, () => void autoSave(key, dirty, save, values, true))
  } else {
    refusedValues.delete(key)
  }
  // A change made meanwhile goes next, after a refusal as well: it may be the correction.
  if (again.delete(key)) await autoSave(key, dirty, save, values)
}

// A saved name can move its row to its alphabetical place, which takes the
// focus out of whatever in the row had it; it is given back. The rows are
// keyed, so the element itself moves and stays the same.
watch(() => props.configuration, () => {
  const focused = document.activeElement
  if (!(focused instanceof HTMLElement) || focused === document.body) return
  void nextTick(() => {
    if (focused.isConnected && document.activeElement !== focused) focused.focus()
  })
})

/** Enter saves a candidate's names, except while an input method is still composing them. */
function enterSaves(event: KeyboardEvent, candidate: Candidate): void {
  if (event.isComposing) return
  event.preventDefault()
  void saveCandidateField(candidate)
}

/** Runs a form's change; a change that went through is confirmed with `done` and the page reads everything again. */
async function run(key: string, action: () => Promise<unknown>, done: () => string): Promise<void> {
  pending.add(key)
  delete errors[key]
  retries.delete(key)
  try {
    await action()
    saved.add(key)
    notify(done())
    emit('changed')
  } catch (err) {
    errors[key] = errorMessage(err)
  } finally {
    pending.delete(key)
  }
}

// Each save sends a copy of the form as it is now and records that copy as
// stored: what is typed while it is on its way stays unsaved, and is saved
// next if its field was left meanwhile, or else when it is (autoSave).
const saveElection = () => {
  const entered = { title: draft.title, description: draft.description }
  return run('election', async () => {
    await apiPatch(base.value, entered)
    served.election = entered
  }, () => 'Titel und Beschreibung gespeichert.')
}
const addContest = () => {
  const title = newContest.title
  return run('new-contest', async () => {
    await apiPost(`${base.value}/contests`, { title, rulesetId: newContest.rulesetId })
    newContest.title = ''
  }, () => `Wahl „${title}“ hinzugefügt.`)
}
const saveContest = (contest: Contest) => {
  const entered = { ...(contestDrafts[contest.id] ?? { title: contest.title, rulesetId: contest.rulesetId }) }
  return run(`contest:${contest.id}`, async () => {
    await apiPatch(`${base.value}/contests/${contest.id}`, entered)
    served.contests[contest.id] = entered
  }, () => `Wahl „${entered.title}“ gespeichert.`)
}
const removeContest = (contest: Contest) =>
  run(`contest:${contest.id}`, () => apiDelete(`${base.value}/contests/${contest.id}`), () => `Wahl „${contest.title}“ entfernt.`)
const addCandidate = (contest: Contest) => {
  const entered = { ...(newCandidates[contest.id] ?? { surname: '', givenName: '' }) }
  return run(`new-candidate:${contest.id}`, async () => {
    await apiPost(`${base.value}/contests/${contest.id}/candidates`, entered)
    newCandidates[contest.id] = { surname: '', givenName: '' }
  }, () => `${joined(entered)} hinzugefügt.`)
}
const saveCandidate = (candidate: Candidate) => {
  const entered = { ...(candidateDrafts[candidate.id] ?? { surname: candidate.surname, givenName: candidate.givenName }) }
  return run(`candidate:${candidate.id}`, async () => {
    await apiPatch(`${base.value}/candidates/${candidate.id}`, entered)
    served.candidates[candidate.id] = entered
  }, () => `Name gespeichert: ${joined(entered)}.`)
}
const removeCandidate = (candidate: Candidate) =>
  run(`candidate:${candidate.id}`, () => apiDelete(`${base.value}/candidates/${candidate.id}`), () => `${fullName(candidate)} entfernt.`)
/** The names in the field: one per line, as a pasted class list gives them, blank lines left out. */
const typedNames = (text: string): string[] => text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')

/**
 * Adds the classes the field names, one after another. A refused one stays
 * in the field with the ones after it, and the field says why; the ones
 * before it are added and confirmed.
 */
async function addGroups(): Promise<void> {
  const names = typedNames(newGroup.value)
  if (names.length === 0 || pending.has('new-group')) return
  pending.add('new-group')
  delete errors['new-group']
  const added: string[] = []
  try {
    for (const [index, name] of names.entries()) {
      try {
        await apiPost(`${base.value}/voter-groups`, { name })
        added.push(name)
      } catch (err) {
        errors['new-group'] = names.length > 1 ? `„${name}“: ${errorMessage(err)}` : errorMessage(err)
        newGroup.value = names.slice(index).join('\n')
        return
      }
    }
    newGroup.value = ''
  } finally {
    pending.delete('new-group')
    if (added.length > 0) {
      notify(added.length === 1 ? `„${added[0] ?? ''}“ hinzugefügt.` : `${added.length} Klassen oder Gruppen hinzugefügt.`)
      emit('changed')
    }
  }
}

/** Enter adds what the field names, except while an input method composes; Shift+Enter starts another line. */
function enterAdds(event: KeyboardEvent): void {
  if (event.isComposing || event.shiftKey) return
  event.preventDefault()
  void addGroups()
}

/** The group a termin gets where everyone votes in every Wahl, on the teacher's choice. */
const ONE_FOR_ALL = 'Alle Wahlberechtigten'

async function addOneForAll(): Promise<void> {
  if (pending.has('new-group')) return
  pending.add('new-group')
  delete errors['new-group']
  let created = false
  try {
    const group = await apiPost<VoterGroup>(`${base.value}/voter-groups`, { name: ONE_FOR_ALL })
    created = true
    await apiPut(`${base.value}/voter-groups/${group.id}/contests`, { contestIds: props.configuration.contests.map((contest) => contest.id) })
    notify(`„${ONE_FOR_ALL}“ angelegt; sie wählt in allen Wahlen.`)
  } catch (err) {
    errors['new-group'] = errorMessage(err)
  } finally {
    pending.delete('new-group')
    if (created) emit('changed')
  }
}
const saveGroup = (group: VoterGroup) => {
  const entered = groupDrafts[group.id] ?? ''
  return run(`group:${group.id}`, async () => {
    await apiPatch(`${base.value}/voter-groups/${group.id}`, { name: entered })
    served.groups[group.id] = entered
  }, () => `Name gespeichert: „${entered}“.`)
}
const saveElectionField = () => autoSave('election', electionDirty, saveElection, () => JSON.stringify(draft))
const saveContestField = (contest: Contest) =>
  autoSave(`contest:${contest.id}`, () => contestDirty(contest.id), () => saveContest(contest), () => JSON.stringify(contestDrafts[contest.id]))
const saveCandidateField = (candidate: Candidate) =>
  autoSave(`candidate:${candidate.id}`, () => candidateDirty(candidate.id), () => saveCandidate(candidate), () => JSON.stringify(candidateDrafts[candidate.id]))
const saveGroupField = (group: VoterGroup) =>
  autoSave(`group:${group.id}`, () => groupDirty(group.id), () => saveGroup(group), () => JSON.stringify(groupDrafts[group.id]))
const removeGroup = (group: VoterGroup) =>
  run(`group:${group.id}`, () => apiDelete(`${base.value}/voter-groups/${group.id}`), () => `„${group.name}“ entfernt.`)

/** Ticks or clears one box and saves the class's Wahlen; whether it went through, with a refusal shown in the class's row. */
async function putVotes(group: VoterGroup, contest: Contest, checked: boolean): Promise<boolean> {
  const before = votes[group.id] ?? [...group.contestIds]
  const after = checked ? [...new Set([...before, contest.id])] : before.filter((id) => id !== contest.id)
  votes[group.id] = after
  const key = `votes:${group.id}`
  pending.add(key)
  delete errors[key]
  try {
    await apiPut(`${base.value}/voter-groups/${group.id}/contests`, { contestIds: after })
    saved.add(key)
    return true
  } catch (err) {
    votes[group.id] = before
    errors[key] = errorMessage(err)
    return false
  } finally {
    pending.delete(key)
  }
}

async function setVotes(group: VoterGroup, contest: Contest, checked: boolean): Promise<void> {
  if (!await putVotes(group, contest, checked)) return
  notify(checked ? `„${group.name}“ wählt jetzt in „${contest.title}“.` : `„${group.name}“ wählt nicht mehr in „${contest.title}“.`)
  emit('changed')
}

/** A whole column is being saved: every box waits, so no class's own save can overtake the column's. */
const columnSaving = ref(false)

/**
 * Every class votes in `contest`, or none: the classes whose box differs,
 * one after another, confirmed once. Where some were refused, the toast
 * says how many changed, and the refused rows say why.
 */
async function setAll(contest: Contest, checked: boolean): Promise<void> {
  const changing = props.configuration.voterGroups.filter((group) => votesIn(group, contest.id) !== checked)
  columnSaving.value = true
  let done = 0
  try {
    for (const group of changing) {
      if (await putVotes(group, contest, checked)) done += 1
    }
  } finally {
    columnSaving.value = false
  }
  if (done === 0) return
  if (done < changing.length) notify(`Nur ${done} von ${changing.length} Klassen oder Gruppen geändert; bei den übrigen steht, warum nicht.`)
  else notify(checked ? `Alle Klassen und Gruppen wählen jetzt in „${contest.title}“.` : `Keine Klasse oder Gruppe wählt mehr in „${contest.title}“.`)
  emit('changed')
}

/**
 * A click on a column's box: ticks the Wahl for every class unless all are
 * ticked, else clears it, as the grid stands, not as the click left the box.
 * Afterwards the box shows the column as it is: a column only partly saved
 * stays mixed, which Vue would not redraw, the bound value being unchanged.
 */
async function toggleColumn(event: Event, contest: Contest): Promise<void> {
  const box = event.target as HTMLInputElement
  await setAll(contest, column(contest) !== 'all')
  box.checked = column(contest) === 'all'
  box.indeterminate = column(contest) === 'some'
}

/** How a column stands: every class ticked, none, or some. */
function column(contest: Contest): 'all' | 'none' | 'some' {
  const ticked = props.configuration.voterGroups.filter((group) => votesIn(group, contest.id)).length
  if (ticked === 0) return 'none'
  return ticked === props.configuration.voterGroups.length ? 'all' : 'some'
}

/** The boxes that tick a whole column wait while any class's Wahlen are being saved, so the column never overtakes a class's own save. */
const votesPending = computed(() => [...pending].some((key) => key.startsWith('votes:')))

async function picture(candidate: Candidate, action: () => Promise<unknown>, done: string): Promise<void> {
  const key = `picture:${candidate.id}`
  pending.add(key)
  delete errors[key]
  try {
    await action()
    notify(done)
    emit('changed')
  } catch (err) {
    errors[key] = uploadMessage(err instanceof ApiError ? err.code : 'request_failed')
  } finally {
    pending.delete(key)
  }
}

const setPicture = (candidate: Candidate, prepared: PreparedPicture) =>
  picture(candidate, () => apiPut(`${base.value}/candidates/${candidate.id}/picture`, { data: toBase64(prepared.bytes) }), `Bild von ${fullName(candidate)} gespeichert.`)
const removePicture = (candidate: Candidate) =>
  picture(candidate, () => apiDelete(`${base.value}/candidates/${candidate.id}/picture`), `Bild von ${fullName(candidate)} entfernt.`)

function joined(name: { surname: string, givenName: string }): string {
  return [name.givenName, name.surname].filter((part) => part !== '').join(' ')
}

function fullName(candidate: Candidate): string {
  return joined(candidate)
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? `1 ${one}` : `${n} ${many}`)

/** What goes with a removal, as its confirmation asks. */
function contestRemoval(contest: Contest): string {
  const pictures = contest.candidates.filter((candidate) => candidate.picture !== null).length
  const withWhat = [contest.candidates.length > 0 ? plural(contest.candidates.length, 'Kandidat:in', 'Kandidat:innen') : '', pictures > 0 ? plural(pictures, 'Foto', 'Fotos') : '']
    .filter((part) => part !== '')
  return withWhat.length > 0 ? `Wahl „${contest.title}“ mit ${withWhat.join(' und ')} entfernen?` : `Wahl „${contest.title}“ entfernen?`
}
function candidateRemoval(candidate: Candidate): string {
  return candidate.picture === null ? `${fullName(candidate)} entfernen?` : `${fullName(candidate)} mit Foto entfernen?`
}

// The confirmation takes the place of the button that asked for it, and
// focus moves to its "Abbrechen"; cancelling gives it back to that button.
async function ask(key: string): Promise<void> {
  confirming.value = key
  await nextTick()
  document.querySelector<HTMLButtonElement>(`[data-confirm="${CSS.escape(key)}"] .cancel`)?.focus()
}
async function cancel(): Promise<void> {
  const key = confirming.value
  confirming.value = null
  if (key === null) return
  await nextTick()
  document.querySelector<HTMLButtonElement>(`[data-remove="${CSS.escape(key)}"]`)?.focus()
}
async function confirmed(removal: () => Promise<void>): Promise<void> {
  confirming.value = null
  await removal()
}

function checked(event: Event): boolean {
  return (event.target as HTMLInputElement).checked
}

function votesIn(group: VoterGroup, contestId: string): boolean {
  return (votes[group.id] ?? group.contestIds).includes(contestId)
}
</script>

<template>
  <div class="setup">
    <p
      v-if="locked"
      class="message warning"
    >
      {{ locked }}
    </p>

    <div class="part">
      <h3>Wahltermin</h3>
      <form
        v-if="rules.candidates"
        @submit.prevent="saveElectionField"
      >
        <div class="pair">
          <div>
            <label :for="ids.title">Titel</label>
            <input
              :id="ids.title"
              v-model="draft.title"
              type="text"
              required
              maxlength="200"
              @blur="saveElectionField"
            >
          </div>
          <div>
            <label :for="ids.description">Beschreibung</label>
            <textarea
              :id="ids.description"
              v-model="draft.description"
              rows="2"
              maxlength="2000"
              @blur="saveElectionField"
            />
          </div>
        </div>
        <SaveState :state="saveState('election', electionDirty())" />
        <p
          v-if="errors.election"
          class="message error"
          role="alert"
        >
          {{ errors.election }}
          <button
            v-if="retries.has('election')"
            type="button"
            class="link"
            @click="retries.get('election')?.()"
          >
            Noch einmal
          </button>
        </p>
      </form>
      <template v-else>
        <p>{{ election.title }}</p>
        <p
          v-if="election.description"
          class="description"
        >
          {{ election.description }}
        </p>
      </template>
    </div>

    <div class="part">
      <div class="part-head">
        <h3>Wahlen an diesem Termin</h3>
        <p
          v-if="rules.candidates"
          :id="ids.pictureHint"
          class="hint"
        >
          Fotos auf das Bild einer Karte ziehen oder dort mit Strg+V einfügen. Jedes Foto passt: Größe und Ausrichtung werden automatisch angepasst.
        </p>
      </div>
      <article
        v-for="contest in configuration.contests"
        :key="contest.id"
        class="contest"
        :aria-label="contest.title"
      >
        <div class="contest-head">
          <form
            v-if="rules.structure && contestDrafts[contest.id]"
            class="fields"
            @submit.prevent="saveContestField(contest)"
          >
            <div class="grow">
              <label :for="`contest-title-${contest.id}`">Titel der Wahl</label>
              <input
                :id="`contest-title-${contest.id}`"
                v-model="contestDrafts[contest.id]!.title"
                type="text"
                required
                maxlength="200"
                @blur="saveContestField(contest)"
              >
            </div>
            <div class="grow-more">
              <label :for="`contest-ruleset-${contest.id}`">Regeln</label>
              <select
                :id="`contest-ruleset-${contest.id}`"
                v-model="contestDrafts[contest.id]!.rulesetId"
                @change="saveContestField(contest)"
              >
                <option
                  v-for="rulesetId in RULESET_IDS"
                  :key="rulesetId"
                  :value="rulesetId"
                >
                  {{ RULESET_LABELS[rulesetId] }}
                </option>
              </select>
            </div>
            <SaveState :state="saveState(`contest:${contest.id}`, contestDirty(contest.id))" />
            <button
              v-if="confirming !== `contest:${contest.id}`"
              type="button"
              class="danger"
              :aria-label="`Wahl entfernen: ${contest.title}`"
              :data-remove="`contest:${contest.id}`"
              @click="ask(`contest:${contest.id}`)"
            >
              <LineIcon name="trash" />Wahl entfernen
            </button>
          </form>
          <template v-else>
            <h4>{{ contest.title }}</h4>
            <p class="muted">
              {{ RULESET_LABELS[contest.rulesetId] }}
            </p>
          </template>
          <fieldset
            v-if="rules.structure && confirming === `contest:${contest.id}`"
            class="confirm"
            :aria-label="`Entfernen bestätigen: ${contest.title}`"
            :data-confirm="`contest:${contest.id}`"
          >
            <span>{{ contestRemoval(contest) }}</span>
            <button
              type="button"
              class="danger"
              :disabled="pending.has(`contest:${contest.id}`)"
              @click="confirmed(() => removeContest(contest))"
            >
              Ja, entfernen
            </button>
            <button
              type="button"
              class="secondary cancel"
              @click="cancel"
            >
              Abbrechen
            </button>
          </fieldset>
          <p
            v-if="errors[`contest:${contest.id}`]"
            class="message error"
            role="alert"
          >
            {{ errors[`contest:${contest.id}`] }}
            <button
              v-if="retries.has(`contest:${contest.id}`)"
              type="button"
              class="link"
              @click="retries.get(`contest:${contest.id}`)?.()"
            >
              Noch einmal
            </button>
          </p>
        </div>

        <div class="cards">
          <!-- The list's items and the form to add one share the grid of cards. -->
          <ul
            class="candidates"
            :aria-label="`Kandidat:innen: ${contest.title}`"
          >
            <li
              v-for="candidate in contest.candidates"
              :key="candidate.id"
              class="candidate"
              :aria-label="fullName(candidate)"
            >
              <CandidatePicture
                v-if="rules.candidates"
                :name="fullName(candidate)"
                :hint="ids.pictureHint"
                :src="candidate.picture === null ? null : withBase(candidate.picture)"
                :busy="pending.has(`picture:${candidate.id}`)"
                :error="errors[`picture:${candidate.id}`] ?? null"
                @select="(prepared) => setPicture(candidate, prepared)"
                @remove="removePicture(candidate)"
              />
              <div
                v-else
                class="portrait"
              >
                <img
                  v-if="candidate.picture !== null"
                  :src="withBase(candidate.picture)"
                  :alt="`Bild von ${fullName(candidate)}`"
                >
                <span v-else>Kein Bild</span>
              </div>
              <form
                v-if="rules.candidates && candidateDrafts[candidate.id]"
                class="names"
                @submit.prevent="saveCandidateField(candidate)"
              >
                <div>
                  <label :for="`candidate-surname-${candidate.id}`">Nachname</label>
                  <input
                    :id="`candidate-surname-${candidate.id}`"
                    v-model="candidateDrafts[candidate.id]!.surname"
                    type="text"
                    required
                    maxlength="100"
                    @blur="saveCandidateField(candidate)"
                    @keydown.enter="enterSaves($event, candidate)"
                  >
                </div>
                <div>
                  <label :for="`candidate-given-${candidate.id}`">Vorname</label>
                  <input
                    :id="`candidate-given-${candidate.id}`"
                    v-model="candidateDrafts[candidate.id]!.givenName"
                    type="text"
                    maxlength="100"
                    @blur="saveCandidateField(candidate)"
                    @keydown.enter="enterSaves($event, candidate)"
                  >
                </div>
                <div class="card-foot">
                  <SaveState :state="saveState(`candidate:${candidate.id}`, candidateDirty(candidate.id))" />
                  <button
                    v-if="(rules.structure || contest.candidates.length > 1) && confirming !== `candidate:${candidate.id}`"
                    type="button"
                    class="ghost danger small"
                    :aria-label="`Entfernen: ${fullName(candidate)}`"
                    :data-remove="`candidate:${candidate.id}`"
                    @click="ask(`candidate:${candidate.id}`)"
                  >
                    <LineIcon name="trash" />Entfernen
                  </button>
                </div>
              </form>
              <p
                v-else
                class="name"
              >
                {{ fullName(candidate) }}
              </p>
              <fieldset
                v-if="rules.candidates && confirming === `candidate:${candidate.id}`"
                class="confirm in-card"
                :aria-label="`Entfernen bestätigen: ${fullName(candidate)}`"
                :data-confirm="`candidate:${candidate.id}`"
              >
                <span>{{ candidateRemoval(candidate) }}</span>
                <button
                  type="button"
                  class="danger"
                  :disabled="pending.has(`candidate:${candidate.id}`)"
                  @click="confirmed(() => removeCandidate(candidate))"
                >
                  Ja, entfernen
                </button>
                <button
                  type="button"
                  class="secondary cancel"
                  @click="cancel"
                >
                  Abbrechen
                </button>
              </fieldset>
              <p
                v-if="errors[`candidate:${candidate.id}`]"
                class="message error in-card"
                role="alert"
              >
                {{ errors[`candidate:${candidate.id}`] }}
                <button
                  v-if="retries.has(`candidate:${candidate.id}`)"
                  type="button"
                  class="link"
                  @click="retries.get(`candidate:${candidate.id}`)?.()"
                >
                  Noch einmal
                </button>
              </p>
            </li>
          </ul>
          <p
            v-if="contest.candidates.length === 0"
            class="muted empty"
          >
            Noch keine Kandidat:innen.
          </p>
          <form
            v-if="rules.candidates && newCandidates[contest.id]"
            class="add-card"
            :aria-label="`Kandidat:in hinzufügen: ${contest.title}`"
            @submit.prevent="addCandidate(contest)"
          >
            <div>
              <label :for="`new-surname-${contest.id}`">Nachname</label>
              <input
                :id="`new-surname-${contest.id}`"
                v-model="newCandidates[contest.id]!.surname"
                type="text"
                required
                maxlength="100"
                autocomplete="off"
              >
            </div>
            <div>
              <label :for="`new-given-${contest.id}`">Vorname</label>
              <input
                :id="`new-given-${contest.id}`"
                v-model="newCandidates[contest.id]!.givenName"
                type="text"
                maxlength="100"
                autocomplete="off"
              >
            </div>
            <p
              v-if="errors[`new-candidate:${contest.id}`]"
              class="message error"
              role="alert"
            >
              {{ errors[`new-candidate:${contest.id}`] }}
            </p>
            <button
              type="submit"
              :disabled="pending.has(`new-candidate:${contest.id}`)"
            >
              <LineIcon name="plus" />Kandidat:in hinzufügen
            </button>
          </form>
        </div>
      </article>
      <form
        v-if="rules.structure"
        class="new-contest fields"
        aria-label="Wahl hinzufügen"
        @submit.prevent="addContest"
      >
        <div class="grow">
          <label :for="ids.contestTitle">Titel der neuen Wahl</label>
          <input
            :id="ids.contestTitle"
            v-model="newContest.title"
            type="text"
            required
            maxlength="200"
            autocomplete="off"
          >
        </div>
        <div class="grow-more">
          <label :for="ids.contestRuleset">Regeln</label>
          <select
            :id="ids.contestRuleset"
            v-model="newContest.rulesetId"
          >
            <option
              v-for="rulesetId in RULESET_IDS"
              :key="rulesetId"
              :value="rulesetId"
            >
              {{ RULESET_LABELS[rulesetId] }}
            </option>
          </select>
        </div>
        <button
          type="submit"
          class="secondary"
          :disabled="pending.has('new-contest')"
        >
          <LineIcon name="plus" />Wahl hinzufügen
        </button>
      </form>
      <p
        v-if="errors['new-contest']"
        class="message error"
        role="alert"
      >
        {{ errors['new-contest'] }}
      </p>
    </div>

    <div class="part">
      <div class="part-head">
        <h3>Klassen und Gruppen</h3>
        <p
          v-if="configuration.voterGroups.length > 0 && configuration.contests.length > 0"
          class="hint"
        >
          Ein Häkchen heißt: diese Klasse wählt in dieser Wahl.
        </p>
      </div>
      <p
        v-if="rules.structure"
        class="explain"
      >
        Jede Klasse oder Gruppe bekommt einen eigenen Stapel Stimmkarten und wählt in den Wahlen, die für sie angehakt sind. Eigene Gruppen braucht es nur, wo Gruppen in verschiedenen Wahlen wählen oder wo die Stimmkarten je Klasse ausgeteilt werden. Wählt die ganze Oberstufe nur die Schulsprecher/in, genügt eine Gruppe „Oberstufe“.
      </p>
      <div
        v-if="configuration.voterGroups.length > 0"
        class="table-box"
      >
        <table class="grid">
          <thead>
            <tr>
              <th scope="col">
                Klasse / Gruppe
              </th>
              <th
                v-for="contest in configuration.contests"
                :key="contest.id"
                scope="col"
                class="tick"
              >
                <span class="contest-name">{{ contest.title }}</span>
                <label
                  v-if="rules.structure"
                  class="check all"
                >
                  <input
                    type="checkbox"
                    :checked="column(contest) === 'all'"
                    :indeterminate="column(contest) === 'some'"
                    :disabled="votesPending"
                    :aria-label="`Alle Klassen und Gruppen wählen in ${contest.title}`"
                    @change="toggleColumn($event, contest)"
                  >
                  Alle
                </label>
              </th>
              <th
                v-if="rules.structure"
                scope="col"
              >
                <span class="visually-hidden">Aktionen</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <template
              v-for="group in configuration.voterGroups"
              :key="group.id"
            >
              <tr>
                <th
                  scope="row"
                  class="group-cell"
                >
                  <form
                    v-if="rules.structure"
                    @submit.prevent="saveGroupField(group)"
                  >
                    <input
                      :id="`group-name-${group.id}`"
                      v-model="groupDrafts[group.id]"
                      type="text"
                      required
                      maxlength="100"
                      :aria-label="`Name von ${group.name}`"
                      @blur="saveGroupField(group)"
                    >
                  </form>
                  <template v-else>
                    {{ group.name }}
                  </template>
                </th>
                <td
                  v-for="contest in configuration.contests"
                  :key="contest.id"
                  class="tick"
                >
                  <input
                    v-if="rules.structure"
                    type="checkbox"
                    :checked="votesIn(group, contest.id)"
                    :disabled="columnSaving || pending.has(`votes:${group.id}`)"
                    :aria-label="`${group.name} wählt in ${contest.title}`"
                    @change="setVotes(group, contest, checked($event))"
                  >
                  <template v-else-if="votesIn(group, contest.id)">
                    <LineIcon name="check" /><span class="visually-hidden">wählt in {{ contest.title }}</span>
                  </template>
                  <span
                    v-else
                    class="muted"
                  >–<span class="visually-hidden"> wählt nicht in {{ contest.title }}</span></span>
                </td>
                <td
                  v-if="rules.structure"
                  class="end"
                >
                  <SaveState :state="saveState(`group:${group.id}`, groupDirty(group.id))" />
                  <SaveState :state="saveState(`votes:${group.id}`, false)" />
                  <button
                    v-if="confirming !== `group:${group.id}`"
                    type="button"
                    class="ghost danger small"
                    :aria-label="`Entfernen: ${group.name}`"
                    :data-remove="`group:${group.id}`"
                    @click="ask(`group:${group.id}`)"
                  >
                    <LineIcon name="trash" />Entfernen
                  </button>
                </td>
              </tr>
              <tr
                v-if="(rules.structure && confirming === `group:${group.id}`) || errors[`group:${group.id}`] || errors[`votes:${group.id}`]"
                class="note-row"
              >
                <td :colspan="configuration.contests.length + 2">
                  <fieldset
                    v-if="rules.structure && confirming === `group:${group.id}`"
                    class="confirm"
                    :aria-label="`Entfernen bestätigen: ${group.name}`"
                    :data-confirm="`group:${group.id}`"
                  >
                    <span>Klasse oder Gruppe „{{ group.name }}“ entfernen?</span>
                    <button
                      type="button"
                      class="danger"
                      :disabled="pending.has(`group:${group.id}`)"
                      @click="confirmed(() => removeGroup(group))"
                    >
                      Ja, entfernen
                    </button>
                    <button
                      type="button"
                      class="secondary cancel"
                      @click="cancel"
                    >
                      Abbrechen
                    </button>
                  </fieldset>
                  <p
                    v-if="errors[`group:${group.id}`]"
                    class="message error"
                    role="alert"
                  >
                    {{ errors[`group:${group.id}`] }}
                    <button
                      v-if="retries.has(`group:${group.id}`)"
                      type="button"
                      class="link"
                      @click="retries.get(`group:${group.id}`)?.()"
                    >
                      Noch einmal
                    </button>
                  </p>
                  <p
                    v-if="errors[`votes:${group.id}`]"
                    class="message error"
                    role="alert"
                  >
                    {{ errors[`votes:${group.id}`] }}
                  </p>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
      <p
        v-else-if="!rules.structure"
        class="muted"
      >
        Noch keine Klassen oder Gruppen.
      </p>
      <form
        v-if="rules.structure"
        class="add-groups"
        aria-label="Klasse oder Gruppe hinzufügen"
        @submit.prevent="addGroups"
      >
        <div class="grow">
          <label :for="ids.groupName">Name der Klasse oder Gruppe</label>
          <textarea
            :id="ids.groupName"
            v-model="newGroup"
            :rows="Math.min(Math.max(newGroup.split('\n').length, 1), 8)"
            required
            autocomplete="off"
            :aria-describedby="ids.groupHint"
            @keydown.enter="enterAdds"
          />
          <p
            :id="ids.groupHint"
            class="field-hint"
          >
            Mehrere auf einmal: eine pro Zeile, etwa aus einer Klassenliste kopiert.
          </p>
        </div>
        <button
          type="submit"
          class="secondary"
          :disabled="pending.has('new-group')"
        >
          <LineIcon name="plus" />Klasse oder Gruppe hinzufügen
        </button>
        <button
          v-if="configuration.voterGroups.length === 0 && configuration.contests.length > 0"
          type="button"
          class="secondary"
          :disabled="pending.has('new-group')"
          @click="addOneForAll"
        >
          Eine Gruppe für alle anlegen
        </button>
      </form>
      <p
        v-if="errors['new-group']"
        class="message error"
        role="alert"
      >
        {{ errors['new-group'] }}
      </p>
    </div>
  </div>
</template>

<style scoped>
.setup {
  display: flex;
  flex-direction: column;
  gap: 36px;
}

.part {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.part h3 {
  margin: 0;
  font-size: 1rem;
}

.part-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 4px 12px;
}

.hint {
  margin: 0;
  color: var(--muted);
  font-size: 0.8rem;
}

.message {
  margin: 0;
}

.pair {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 16px;
}

.pair input,
.pair textarea {
  max-width: none;
}

.pair textarea {
  min-height: 0;
  resize: vertical;
}

.description {
  white-space: pre-line;
}

/* A Wahl: its fields in a grey head, its candidates as cards beneath. */
.contest {
  border: 1px solid var(--line);
  border-radius: 12px;
}

.contest-head {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px;
  border-bottom: 1px solid var(--line);
  border-radius: 12px 12px 0 0;
  background: var(--soft);
}

.contest-head .confirm {
  margin: 0;
}

.fields {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 12px;
}

.grow {
  flex: 1 1 220px;
}

.grow-more {
  flex: 2 1 320px;
}

.fields input,
.fields select {
  max-width: none;
}

.fields > .save-state {
  min-height: 40px;
  line-height: 40px;
}

h4 {
  margin: 0;
  font-size: 1.05rem;
}

.contest-head p {
  margin: 0;
}

/* The candidates' cards and the card that adds one, in one grid. */
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 16px;
  padding: 16px;
}

/* The list lends its items to the grid; it stays a list for screen readers. */
.candidates {
  display: contents;
  list-style: none;
}

.candidate {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--paper);
}

/* A picture that no longer changes: the place the picture shows, without
   its buttons. */
.portrait {
  display: grid;
  place-items: center;
  height: 132px;
  overflow: hidden;
  border-bottom: 1px solid var(--line);
  background: var(--soft);
  color: var(--muted);
  font-size: 0.85rem;
}

.portrait img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: 50% 25%;
}

.names {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
}

.names input,
.add-card input {
  max-width: none;
}

.card-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 4px 8px;
  margin-top: auto;
  font-size: 0.8rem;
}

.card-foot button {
  margin-left: auto;
}

.name {
  margin: 0;
  padding: 12px;
  font-weight: 600;
}

.in-card {
  margin: 0 12px 12px;
}

.empty {
  margin: 0;
  align-self: center;
}

.add-card {
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  gap: 10px;
  padding: 14px;
  border: 1.5px dashed var(--line2);
  border-radius: 12px;
}

.new-contest {
  padding: 16px;
  border: 1.5px dashed var(--line2);
  border-radius: 12px;
}

/* The classes: a grid, a row per class and a column per Wahl. */
.explain {
  max-width: 72ch;
  margin: 0;
  color: var(--ink2);
  font-size: 0.85rem;
}

.grid {
  min-width: 480px;
}

.grid .tick {
  text-align: center;
}

.contest-name {
  display: block;
}

.check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  color: var(--ink);
  font-size: 0.9rem;
  font-weight: 400;
}

.check.all {
  margin-top: 4px;
  color: var(--muted);
  font-size: 0.75rem;
  letter-spacing: 0;
  text-transform: none;
}

.grid input[type='checkbox'] {
  width: 18px;
  height: 18px;
  margin: 0;
  accent-color: var(--accent);
}

/* A row's head is the class's name: a field while it can change. */
.group-cell {
  background: none;
  color: var(--ink);
  font-size: 0.9rem;
  letter-spacing: 0;
  text-transform: none;
}

.group-cell input {
  max-width: 160px;
  font-weight: 400;
}

.end {
  white-space: nowrap;
  text-align: right;
}

.end > * + * {
  margin-left: 8px;
}

.end :deep(.save-state) {
  font-size: 0.8rem;
}

.note-row td {
  padding-top: 0;
}

.note-row .confirm,
.note-row .message {
  margin: 0;
  white-space: normal;
}

.add-groups {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 10px;
  padding: 12px 16px;
  border-radius: 12px;
  background: var(--soft);
}

.add-groups .grow {
  flex: 0 1 280px;
}

.add-groups textarea {
  min-height: 40px;
  resize: vertical;
}

.field-hint {
  margin: 4px 0 0;
  color: var(--muted);
  font-size: 0.75rem;
}
</style>
