<script setup lang="ts">
// One election, in its steps: Einrichten, Mitglieder, Vorbereiten,
// Stimmkarten and the Wahltag with its Probelauf, each a section, and the
// result on its own page. The steps' navigation under the title says which
// is done and which is now; a step marked done collapses to one line that
// says what it holds (lib/steps.ts). The page reads everything it shows
// from the API, and again after every change a section reports; what each
// section may offer comes from the caller's permissions and the lifecycle.

import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import DeleteElection from '../components/DeleteElection.vue'
import MembersSection from '../components/MembersSection.vue'
import PrepareSection from '../components/PrepareSection.vue'
import RunSection from '../components/RunSection.vue'
import SetupSection from '../components/SetupSection.vue'
import SheetsSection from '../components/SheetsSection.vue'
import StepNav from '../components/StepNav.vue'
import StepSection from '../components/StepSection.vue'
import { apiGet } from '../lib/api.ts'
import { errorMessage, isTransient, retryDelay } from '../lib/api-rules.ts'
import { ROLE_LABELS, ROUND_LABELS, stateLabel } from '../lib/labels.ts'
import { usePageTitle } from '../lib/page-title.ts'
import { setupRules } from '../lib/setup-rules.ts'
import { collapsed, stepStates, useStepMarks, type Markable } from '../lib/steps.ts'
import type { BatchSummary, Configuration, ElectionDetail, Member, Preparation } from '../lib/types.ts'

const props = defineProps<{ id: string }>()

const election = ref<ElectionDetail>()
usePageTitle(() => election.value?.title ?? 'Wahltermin')
const configuration = ref<Configuration>()
const members = ref<Member[]>()
const preparation = ref<Preparation>()
const batches = ref<BatchSummary[]>()
const error = ref<string | null>(null)

const rules = computed(() => election.value ? setupRules(election.value.lifecycle, election.value.permissions) : undefined)
const { marks, mark } = useStepMarks(() => props.id)
const states = computed(() => election.value ? stepStates(election.value.lifecycle, marks.value) : undefined)
const isCollapsed = (step: Markable): boolean => election.value !== undefined && collapsed(step, election.value.lifecycle, marks.value)
const toggle = (step: Markable): void => mark(step, !isCollapsed(step))

const plural = (n: number, one: string, many: string): string => (n === 1 ? `1 ${one}` : `${n} ${many}`)
const nameOf = (member: Member): string => member.displayName ?? member.email ?? ''
/** Everyone of the termin with their role, for the members' collapsed section. */
const membersSummary = computed(() => (members.value ?? []).map((member) => `${nameOf(member)} (${ROLE_LABELS[member.role]})`).join(', '))

/** What the setup holds, for its collapsed section: each Wahl with its candidates, and the classes. */
const setupSummary = computed(() => [
  ...(configuration.value?.contests ?? []).map((contest) => {
    const counted = `${contest.title} (${plural(contest.candidates.length, 'Kandidat:in', 'Kandidat:innen')})`
    const names = contest.candidates.map((candidate) => `${candidate.givenName} ${candidate.surname}`).join(', ')
    return names === '' ? counted : `${counted}: ${names}`
  }),
  `Klassen und Gruppen: ${(configuration.value?.voterGroups ?? []).map((group) => group.name).join(', ') || 'keine'}`,
])
/** The valid cards per class of each Wahlgang that has any, for the cards' collapsed section. */
const cardsSummary = computed(() => (['regular', 'runoff'] as const).flatMap((kind) => {
  const perClass = (configuration.value?.voterGroups ?? [])
    .map((group) => ({ name: group.name, keys: (batches.value ?? []).filter((batch) => batch.voterGroupId === group.id && batch.roundKind === kind && batch.state === 'issued').reduce((sum, batch) => sum + batch.keys, 0) }))
    .filter((entry) => entry.keys > 0)
  const listed = perClass.map((entry) => `${entry.name} ${entry.keys}`).join(', ')
  return perClass.length === 0 ? [] : [`${ROUND_LABELS[kind]}: ${listed} Stimmkarten`]
}))

/** Who leads the termin, for the members who do not. */
const lead = computed(() => {
  const owner = members.value?.find((member) => member.role === 'owner')
  return owner?.displayName ?? owner?.email ?? null
})

// Each load is numbered: a load that is no longer the newest, because the
// id changed or another change reloaded meanwhile, changes nothing.
let loads = 0

// A load that fails for the connection or the server is tried again after
// a growing pause, and what the page showed stays meanwhile, marked as not
// current: an election day's page does not go blank for a dropped
// connection. A refusal ends the page as before.
const offline = ref(false)
let attempts = 0
let retry: ReturnType<typeof setTimeout> | undefined

function stopRetrying(): void {
  clearTimeout(retry)
  retry = undefined
  attempts = 0
  offline.value = false
}

async function load(): Promise<void> {
  const current = ++loads
  clearTimeout(retry)
  const base = `/api/elections/${props.id}`
  try {
    const [detail, config, memberList, prep, batchList] = await Promise.all([
      apiGet<ElectionDetail>(base),
      apiGet<Configuration>(`${base}/configuration`),
      apiGet<Member[]>(`${base}/members`),
      apiGet<Preparation>(`${base}/preparation`),
      apiGet<{ batches: BatchSummary[] }>(`${base}/batches`),
    ])
    if (current !== loads) return
    election.value = detail
    configuration.value = config
    members.value = memberList
    preparation.value = prep
    batches.value = batchList.batches
    error.value = null
    stopRetrying()
  } catch (err) {
    if (current !== loads) return
    if (isTransient(err)) {
      offline.value = true
      retry = setTimeout(() => void load(), retryDelay(attempts++))
    } else {
      stopRetrying()
      error.value = errorMessage(err)
    }
  }
}

function clear(): void {
  election.value = undefined
  configuration.value = undefined
  members.value = undefined
  preparation.value = undefined
  batches.value = undefined
  error.value = null
  stopRetrying()
}

onMounted(() => {
  void load()
})
// Another election under the same page: nothing of the previous one stays
// on view, so no click can reach it while the new one loads.
watch(() => props.id, () => {
  clear()
  void load()
})

function reload(): void {
  void load()
}

// Leaving the page ends its loads: one still on its way changes nothing
// and schedules no retry when it fails.
onUnmounted(() => {
  loads++
  clearTimeout(retry)
})
</script>

<template>
  <p
    v-if="error"
    class="message error"
    role="alert"
  >
    {{ error }}
  </p>
  <template v-else-if="election && configuration && members && preparation && batches && rules && states">
    <h1>{{ election.title }}</h1>
    <output
      v-if="offline"
      class="message warning"
    >
      Verbindung unterbrochen – neuer Versuch … Was hier steht, ist der letzte Stand.
    </output>
    <p class="muted">
      {{ stateLabel(election.lifecycle) }} · Ihre Rolle: {{ ROLE_LABELS[election.role] }}<template v-if="lead && election.role !== 'owner'">
        · {{ ROLE_LABELS.owner }}: {{ lead }}
      </template>
    </p>
    <nav
      aria-label="Seiten des Wahltermins"
      class="pages"
    >
      <RouterLink
        v-if="election.lifecycle.regular === 'closed'"
        :to="`/wahlen/${election.id}/ergebnis`"
      >
        Ergebnis und Herleitung
      </RouterLink>
      <RouterLink :to="`/wahlen/${election.id}/protokoll`">
        Protokoll
      </RouterLink>
      <RouterLink to="/hilfe/wahltag">
        Ablauf am Wahltag
      </RouterLink>
    </nav>
    <StepNav
      :election-id="election.id"
      :states="states"
      :result-ready="election.lifecycle.regular === 'closed'"
    />
    <StepSection
      id="einrichten"
      title="Einrichten"
      :collapsed="isCollapsed('einrichten')"
      @toggle="toggle('einrichten')"
    >
      <template #summary>
        <ul class="lines">
          <li
            v-for="line in setupSummary"
            :key="line"
          >
            {{ line }}
          </li>
        </ul>
      </template>
      <SetupSection
        :election="election"
        :configuration="configuration"
        :rules="rules"
        @changed="reload"
      />
    </StepSection>
    <StepSection
      id="mitglieder"
      title="Mitglieder"
      :collapsed="isCollapsed('mitglieder')"
      @toggle="toggle('mitglieder')"
    >
      <template #summary>
        <p>{{ membersSummary }}</p>
      </template>
      <MembersSection
        :election-id="election.id"
        :members="members"
        :witnesses="rules.witnesses"
        :co-admins="rules.coAdmins"
        :lead="rules.lead"
        :final="election.state === 'final'"
        @changed="reload"
      />
    </StepSection>
    <StepSection
      id="vorbereiten"
      title="Vorbereiten"
      :collapsed="isCollapsed('vorbereiten')"
      @toggle="toggle('vorbereiten')"
    >
      <template #summary>
        <p>{{ election.state === 'draft' ? 'Noch nicht vorbereitet.' : 'Vorbereitet: welche Klassen in welchen Wahlen wählen, steht fest.' }}</p>
      </template>
      <PrepareSection
        :election-id="election.id"
        :preparation="preparation"
        :configuration="configuration"
        :rules="rules"
        :prepared="election.state !== 'draft'"
        @changed="reload"
      />
    </StepSection>
    <StepSection
      id="stimmkarten"
      title="Stimmkarten"
      :collapsed="isCollapsed('stimmkarten')"
      @toggle="toggle('stimmkarten')"
    >
      <template #summary>
        <ul class="lines">
          <li
            v-for="line in cardsSummary"
            :key="line"
          >
            {{ line }}
          </li>
          <li v-if="cardsSummary.length === 0">
            Noch keine Stimmkarten.
          </li>
        </ul>
      </template>
      <SheetsSection
        :election-id="election.id"
        :configuration="configuration"
        :batches="batches"
        :rules="rules"
        :role="election.role"
        :lifecycle="election.lifecycle"
        @changed="reload"
      />
    </StepSection>
    <StepSection
      id="wahltag"
      title="Wahltag"
      :collapsed="null"
    >
      <RunSection
        :election="election"
        :configuration="configuration"
        :batches="batches"
        :probelauf-done="isCollapsed('probelauf')"
        @changed="reload"
        @probelauf="(done) => mark('probelauf', done)"
      />
    </StepSection>
    <DeleteElection
      v-if="rules.remove"
      :election-id="election.id"
      :title="election.title"
    />
  </template>
  <p
    v-else
    class="muted"
  >
    {{ offline ? 'Verbindung unterbrochen – neuer Versuch …' : 'Wird geladen …' }}
  </p>
</template>

<style scoped>
.lines {
  padding-left: 1.2em;
}

.pages {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  margin: 0 0 10px;
}
</style>
