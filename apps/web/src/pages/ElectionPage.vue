<script setup lang="ts">
// One election, in sections: Einrichten, Mitglieder, Vorbereiten,
// Stimmkarten and Ablauf. The page reads everything it shows from the
// API, and again after every change a section reports; what each section
// may offer comes from the caller's permissions and the lifecycle.

import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import MembersSection from '../components/MembersSection.vue'
import PrepareSection from '../components/PrepareSection.vue'
import RunSection from '../components/RunSection.vue'
import SetupSection from '../components/SetupSection.vue'
import SheetsSection from '../components/SheetsSection.vue'
import { apiGet } from '../lib/api.ts'
import { errorMessage } from '../lib/api-rules.ts'
import { ROLE_LABELS, stateLabel } from '../lib/labels.ts'
import { usePageTitle } from '../lib/page-title.ts'
import { setupRules } from '../lib/setup-rules.ts'
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
/** Who leads the termin, for the members who do not. */
const lead = computed(() => {
  const owner = members.value?.find((member) => member.role === 'owner')
  return owner?.displayName ?? owner?.email ?? null
})

// Each load is numbered: a load that is no longer the newest, because the
// id changed or another change reloaded meanwhile, changes nothing.
let loads = 0

async function load(): Promise<void> {
  const current = ++loads
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
  } catch (err) {
    if (current === loads) error.value = errorMessage(err)
  }
}

function clear(): void {
  election.value = undefined
  configuration.value = undefined
  members.value = undefined
  preparation.value = undefined
  batches.value = undefined
  error.value = null
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
</script>

<template>
  <p
    v-if="error"
    class="message error"
    role="alert"
  >
    {{ error }}
  </p>
  <template v-else-if="election && configuration && members && preparation && batches && rules">
    <h1>{{ election.title }}</h1>
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
    <SetupSection
      :election="election"
      :configuration="configuration"
      :rules="rules"
      @changed="reload"
    />
    <MembersSection
      :election-id="election.id"
      :members="members"
      :witnesses="rules.witnesses"
      :co-admins="rules.coAdmins"
      :final="election.state === 'final'"
      @changed="reload"
    />
    <PrepareSection
      :election-id="election.id"
      :preparation="preparation"
      :configuration="configuration"
      :rules="rules"
      :prepared="election.state !== 'draft'"
      @changed="reload"
    />
    <SheetsSection
      :election-id="election.id"
      :configuration="configuration"
      :batches="batches"
      :rules="rules"
      :role="election.role"
      :lifecycle="election.lifecycle"
      @changed="reload"
    />
    <RunSection
      :election="election"
      :configuration="configuration"
      :batches="batches"
      @changed="reload"
    />
  </template>
  <p
    v-else
    class="muted"
  >
    Wird geladen …
  </p>
</template>

<style scoped>
.pages {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  margin: 0 0 10px;
}
</style>
