<script setup lang="ts">
// Einrichten: the election's title and description, its contests with
// their candidates and pictures, and the classes and groups with the
// contests each votes in. What may change now comes from the rules
// (lib/setup-rules.ts): everything in a draft, candidates and the title
// until voting starts, nothing for a witness. Every change goes to its
// route and the page reads the configuration again.

import { computed, reactive, ref, useId, watch } from 'vue'
import { RULESET_IDS, type RulesetId } from '@school-election/election-core'
import CandidatePicture from './CandidatePicture.vue'
import { apiDelete, apiPatch, apiPost, apiPut } from '../lib/api.ts'
import { ApiError, errorMessage } from '../lib/api-rules.ts'
import { lockedText, RULESET_LABELS } from '../lib/labels.ts'
import type { PreparedPicture } from '../lib/picture.ts'
import { toBase64, uploadMessage } from '../lib/picture-rules.ts'
import type { SetupRules } from '../lib/setup-rules.ts'
import type { Candidate, Configuration, Contest, ElectionDetail, VoterGroup } from '../lib/types.ts'

const props = defineProps<{
  election: ElectionDetail
  configuration: Configuration
  rules: SetupRules
}>()

const emit = defineEmits<{ changed: [] }>()

const base = computed(() => `/api/elections/${props.election.id}`)
const ids = { title: useId(), description: useId(), contestTitle: useId(), contestRuleset: useId(), groupName: useId() }

const busy = ref(false)
const error = ref<string | null>(null)
const pictureBusy = ref<string | null>(null)
const pictureErrors = reactive<Record<string, string>>({})

// What is being edited, taken from the election and its configuration
// when the page reads them again, unless the person has changed it since:
// a draft that still equals what the server said last keeps following
// the server, a draft someone typed into stays until they save it.
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
const served = {
  election: { title: '', description: '' },
  contests: {} as Record<string, { title: string, rulesetId: RulesetId }>,
  candidates: {} as Record<string, { surname: string, givenName: string }>,
  groups: {} as Record<string, string>,
}

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
    votes[group.id] = [...group.contestIds]
  }
}, { immediate: true })

const locked = computed(() => lockedText(props.election.state))

async function run(action: () => Promise<unknown>): Promise<void> {
  busy.value = true
  error.value = null
  try {
    await action()
    emit('changed')
  } catch (err) {
    error.value = errorMessage(err)
  } finally {
    busy.value = false
  }
}

const saveElection = () => run(() => apiPatch(base.value, { title: draft.title, description: draft.description }))
const addContest = () => run(async () => {
  await apiPost(`${base.value}/contests`, { title: newContest.title, rulesetId: newContest.rulesetId })
  newContest.title = ''
})
const saveContest = (contest: Contest) => run(() => apiPatch(`${base.value}/contests/${contest.id}`, contestDrafts[contest.id]))
const removeContest = (contest: Contest) => run(() => apiDelete(`${base.value}/contests/${contest.id}`))
const addCandidate = (contest: Contest) => run(async () => {
  const entered = newCandidates[contest.id] ?? { surname: '', givenName: '' }
  await apiPost(`${base.value}/contests/${contest.id}/candidates`, { surname: entered.surname, givenName: entered.givenName })
  newCandidates[contest.id] = { surname: '', givenName: '' }
})
const saveCandidate = (candidate: Candidate) => run(() => apiPatch(`${base.value}/candidates/${candidate.id}`, candidateDrafts[candidate.id]))
const removeCandidate = (candidate: Candidate) => run(() => apiDelete(`${base.value}/candidates/${candidate.id}`))
const addGroup = () => run(async () => {
  await apiPost(`${base.value}/voter-groups`, { name: newGroup.value })
  newGroup.value = ''
})
const saveGroup = (group: VoterGroup) => run(() => apiPatch(`${base.value}/voter-groups/${group.id}`, { name: groupDrafts[group.id] }))
const removeGroup = (group: VoterGroup) => run(() => apiDelete(`${base.value}/voter-groups/${group.id}`))
async function setVotes(group: VoterGroup, contestId: string, checked: boolean): Promise<void> {
  const before = votes[group.id] ?? [...group.contestIds]
  const after = checked ? [...new Set([...before, contestId])] : before.filter((id) => id !== contestId)
  votes[group.id] = after
  busy.value = true
  error.value = null
  try {
    await apiPut(`${base.value}/voter-groups/${group.id}/contests`, { contestIds: after })
    emit('changed')
  } catch (err) {
    votes[group.id] = before
    error.value = errorMessage(err)
  } finally {
    busy.value = false
  }
}

async function picture(candidate: Candidate, action: () => Promise<unknown>): Promise<void> {
  pictureBusy.value = candidate.id
  delete pictureErrors[candidate.id]
  try {
    await action()
    emit('changed')
  } catch (err) {
    pictureErrors[candidate.id] = uploadMessage(err instanceof ApiError ? err.code : 'request_failed')
  } finally {
    pictureBusy.value = null
  }
}

const setPicture = (candidate: Candidate, prepared: PreparedPicture) =>
  picture(candidate, () => apiPut(`${base.value}/candidates/${candidate.id}/picture`, { data: toBase64(prepared.bytes) }))
const removePicture = (candidate: Candidate) => picture(candidate, () => apiDelete(`${base.value}/candidates/${candidate.id}/picture`))

function fullName(candidate: Candidate): string {
  return [candidate.givenName, candidate.surname].filter((part) => part !== '').join(' ')
}

function checked(event: Event): boolean {
  return (event.target as HTMLInputElement).checked
}

function votesIn(group: VoterGroup, contestId: string): boolean {
  return (votes[group.id] ?? group.contestIds).includes(contestId)
}
</script>

<template>
  <section aria-labelledby="setup-heading">
    <h2 id="setup-heading">
      Einrichten
    </h2>
    <p
      v-if="locked"
      class="message warning"
    >
      {{ locked }}
    </p>

    <h3>Titel und Beschreibung</h3>
    <form
      v-if="rules.candidates"
      @submit.prevent="saveElection"
    >
      <label :for="ids.title">Titel</label>
      <input
        :id="ids.title"
        v-model="draft.title"
        type="text"
        required
        maxlength="200"
      >
      <label :for="ids.description">Beschreibung</label>
      <textarea
        :id="ids.description"
        v-model="draft.description"
        maxlength="2000"
      />
      <div class="actions">
        <button
          type="submit"
          :disabled="busy"
        >
          Titel und Beschreibung speichern
        </button>
      </div>
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

    <h3>Wahlgänge</h3>
    <article
      v-for="contest in configuration.contests"
      :key="contest.id"
      class="card-box"
      :aria-label="contest.title"
    >
      <form
        v-if="rules.structure && contestDrafts[contest.id]"
        class="row"
        @submit.prevent="saveContest(contest)"
      >
        <div>
          <label :for="`contest-title-${contest.id}`">Titel des Wahlgangs</label>
          <input
            :id="`contest-title-${contest.id}`"
            v-model="contestDrafts[contest.id]!.title"
            type="text"
            required
            maxlength="200"
          >
        </div>
        <div>
          <label :for="`contest-ruleset-${contest.id}`">Regeln</label>
          <select
            :id="`contest-ruleset-${contest.id}`"
            v-model="contestDrafts[contest.id]!.rulesetId"
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
          :disabled="busy"
        >
          Speichern
        </button>
        <button
          type="button"
          class="danger"
          :disabled="busy"
          :aria-label="`Wahlgang entfernen: ${contest.title}`"
          @click="removeContest(contest)"
        >
          Wahlgang entfernen
        </button>
      </form>
      <template v-else>
        <h4>{{ contest.title }}</h4>
        <p class="muted">
          {{ RULESET_LABELS[contest.rulesetId] }}
        </p>
      </template>

      <ul
        class="plain candidates"
        :aria-label="`Kandidat:innen: ${contest.title}`"
      >
        <li
          v-for="candidate in contest.candidates"
          :key="candidate.id"
          class="candidate"
        >
          <CandidatePicture
            :name="fullName(candidate)"
            :src="candidate.picture"
            :disabled="!rules.candidates"
            :busy="pictureBusy === candidate.id"
            :error="pictureErrors[candidate.id] ?? null"
            @select="(prepared) => setPicture(candidate, prepared)"
            @remove="removePicture(candidate)"
          />
          <form
            v-if="rules.candidates && candidateDrafts[candidate.id]"
            class="row"
            @submit.prevent="saveCandidate(candidate)"
          >
            <div>
              <label :for="`candidate-surname-${candidate.id}`">Nachname</label>
              <input
                :id="`candidate-surname-${candidate.id}`"
                v-model="candidateDrafts[candidate.id]!.surname"
                type="text"
                required
                maxlength="100"
              >
            </div>
            <div>
              <label :for="`candidate-given-${candidate.id}`">Vorname</label>
              <input
                :id="`candidate-given-${candidate.id}`"
                v-model="candidateDrafts[candidate.id]!.givenName"
                type="text"
                maxlength="100"
              >
            </div>
            <button
              type="submit"
              class="secondary"
              :disabled="busy"
              :aria-label="`Speichern: ${fullName(candidate)}`"
            >
              Speichern
            </button>
            <button
              v-if="rules.structure || contest.candidates.length > 1"
              type="button"
              class="danger"
              :disabled="busy"
              :aria-label="`Entfernen: ${fullName(candidate)}`"
              @click="removeCandidate(candidate)"
            >
              Entfernen
            </button>
          </form>
          <p v-else>
            {{ fullName(candidate) }}
          </p>
        </li>
      </ul>
      <p
        v-if="contest.candidates.length === 0"
        class="muted"
      >
        Noch keine Kandidat:innen.
      </p>
      <form
        v-if="rules.candidates && newCandidates[contest.id]"
        class="row"
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
        <button
          type="submit"
          :disabled="busy"
        >
          Kandidat:in hinzufügen
        </button>
      </form>
    </article>
    <form
      v-if="rules.structure"
      class="card-box row"
      aria-label="Wahlgang hinzufügen"
      @submit.prevent="addContest"
    >
      <div>
        <label :for="ids.contestTitle">Titel des neuen Wahlgangs</label>
        <input
          :id="ids.contestTitle"
          v-model="newContest.title"
          type="text"
          required
          maxlength="200"
          autocomplete="off"
        >
      </div>
      <div>
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
        :disabled="busy"
      >
        Wahlgang hinzufügen
      </button>
    </form>

    <h3>Klassen und Gruppen</h3>
    <article
      v-for="group in configuration.voterGroups"
      :key="group.id"
      class="card-box"
      :aria-label="group.name"
    >
      <form
        v-if="rules.structure"
        class="row"
        @submit.prevent="saveGroup(group)"
      >
        <div>
          <label :for="`group-name-${group.id}`">Name</label>
          <input
            :id="`group-name-${group.id}`"
            v-model="groupDrafts[group.id]"
            type="text"
            required
            maxlength="100"
          >
        </div>
        <button
          type="submit"
          class="secondary"
          :disabled="busy"
          :aria-label="`Speichern: ${group.name}`"
        >
          Speichern
        </button>
        <button
          type="button"
          class="danger"
          :disabled="busy"
          :aria-label="`Entfernen: ${group.name}`"
          @click="removeGroup(group)"
        >
          Entfernen
        </button>
      </form>
      <h4 v-else>
        {{ group.name }}
      </h4>
      <fieldset v-if="rules.structure">
        <legend>Wählt in</legend>
        <label
          v-for="contest in configuration.contests"
          :key="contest.id"
          class="check"
        >
          <input
            type="checkbox"
            :checked="votesIn(group, contest.id)"
            :disabled="busy"
            @change="setVotes(group, contest.id, checked($event))"
          >
          {{ contest.title }}
        </label>
        <p
          v-if="configuration.contests.length === 0"
          class="muted"
        >
          Zuerst Wahlgänge anlegen.
        </p>
      </fieldset>
      <p
        v-else
        class="muted"
      >
        Wählt in: {{ configuration.contests.filter((contest) => group.contestIds.includes(contest.id)).map((contest) => contest.title).join(', ') || '–' }}
      </p>
    </article>
    <form
      v-if="rules.structure"
      class="card-box row"
      aria-label="Klasse oder Gruppe hinzufügen"
      @submit.prevent="addGroup"
    >
      <div>
        <label :for="ids.groupName">Name der Klasse oder Gruppe</label>
        <input
          :id="ids.groupName"
          v-model="newGroup"
          type="text"
          required
          maxlength="100"
          autocomplete="off"
        >
      </div>
      <button
        type="submit"
        :disabled="busy"
      >
        Klasse oder Gruppe hinzufügen
      </button>
    </form>

    <p
      v-if="error"
      class="message error"
      role="alert"
    >
      {{ error }}
    </p>
  </section>
</template>

<style scoped>
h4 {
  margin: 0 0 4px;
  font-size: 1.05rem;
}

.description {
  white-space: pre-line;
}

.candidates > li {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 12px;
  align-items: start;
}

fieldset {
  border: 1px solid var(--line);
  border-radius: var(--radius);
  margin: 8px 0 0;
  padding: 6px 12px;
}

.check {
  font-weight: 400;
  margin: 4px 0;
}

@media (width <= 600px) {
  .candidates > li {
    grid-template-columns: 1fr;
  }
}
</style>
