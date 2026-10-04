<script setup lang="ts">
// Meine Wahlen: the elections the signed-in person is a member of, and
// for teachers the way to a new one.

import { onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { apiGet } from '../lib/api.ts'
import { errorMessage } from '../lib/api-rules.ts'
import { ROLE_LABELS, STATE_LABELS } from '../lib/labels.ts'
import { isTeacher } from '../lib/session.ts'
import type { ElectionSummary } from '../lib/types.ts'

const elections = ref<ElectionSummary[]>()
const error = ref<string | null>(null)

onMounted(async () => {
  try {
    elections.value = await apiGet<ElectionSummary[]>('/api/elections')
  } catch (err) {
    error.value = errorMessage(err)
  }
})
</script>

<template>
  <h1>Meine Wahlen</h1>
  <p
    v-if="error"
    class="message error"
    role="alert"
  >
    {{ error }}
  </p>
  <div
    v-if="isTeacher"
    class="actions"
  >
    <RouterLink
      to="/wahlen/neu"
      class="button"
    >
      Neue Wahl
    </RouterLink>
  </div>
  <ul
    v-if="elections && elections.length > 0"
    class="plain"
    aria-label="Wahlen"
  >
    <li
      v-for="election in elections"
      :key="election.id"
    >
      <RouterLink :to="`/wahlen/${election.id}`">
        {{ election.title }}
      </RouterLink>
      <span class="muted"> · {{ STATE_LABELS[election.state] }} · {{ ROLE_LABELS[election.role] }}</span>
    </li>
  </ul>
  <p
    v-else-if="elections"
    class="muted"
  >
    Sie sind noch bei keiner Wahl Mitglied.
  </p>
</template>
