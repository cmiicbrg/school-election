<script setup lang="ts">
// One election, in sections: Einrichten, Mitglieder, Vorbereiten and
// Stimmkarten. The page reads everything it shows from the API, and
// again after every change a section reports; what each section may
// offer comes from the caller's permissions and the lifecycle.

import { computed, onMounted, ref, watch } from 'vue'
import MembersSection from '../components/MembersSection.vue'
import PrepareSection from '../components/PrepareSection.vue'
import SetupSection from '../components/SetupSection.vue'
import SheetsSection from '../components/SheetsSection.vue'
import { apiGet } from '../lib/api.ts'
import { errorMessage } from '../lib/api-rules.ts'
import { ROLE_LABELS, STATE_LABELS } from '../lib/labels.ts'
import { setupRules } from '../lib/setup-rules.ts'
import type { BatchSummary, Configuration, ElectionDetail, Member, Preparation } from '../lib/types.ts'

const props = defineProps<{ id: string }>()

const election = ref<ElectionDetail>()
const configuration = ref<Configuration>()
const members = ref<Member[]>()
const preparation = ref<Preparation>()
const batches = ref<BatchSummary[]>()
const error = ref<string | null>(null)

const rules = computed(() => election.value ? setupRules(election.value.lifecycle, election.value.permissions) : undefined)

async function load(): Promise<void> {
  const base = `/api/elections/${props.id}`
  try {
    const [detail, config, memberList, prep, batchList] = await Promise.all([
      apiGet<ElectionDetail>(base),
      apiGet<Configuration>(`${base}/configuration`),
      apiGet<Member[]>(`${base}/members`),
      apiGet<Preparation>(`${base}/preparation`),
      apiGet<{ batches: BatchSummary[] }>(`${base}/batches`),
    ])
    election.value = detail
    configuration.value = config
    members.value = memberList
    preparation.value = prep
    batches.value = batchList.batches
    error.value = null
  } catch (err) {
    error.value = errorMessage(err)
  }
}

onMounted(() => {
  void load()
})
watch(() => props.id, () => {
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
      {{ STATE_LABELS[election.state] }} · Ihre Rolle: {{ ROLE_LABELS[election.role] }}
    </p>
    <SetupSection
      :election="election"
      :configuration="configuration"
      :rules="rules"
      @changed="reload"
    />
    <MembersSection
      :election-id="election.id"
      :members="members"
      :manage="rules.members"
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
  </template>
  <p
    v-else
    class="muted"
  >
    Wird geladen …
  </p>
</template>
