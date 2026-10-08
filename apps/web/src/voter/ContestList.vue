<script setup lang="ts">
// The election and the contests the key may vote in: each with whether it
// is done and, while not, the button to its ballot; how many are left; and
// the way out, which ends the session.

import { computed } from 'vue'
import type { VoterContest, VoterElection } from './voter-api.ts'
import { remainingText } from './voter-rules.ts'

const props = defineProps<{
  election: VoterElection
  message: string | null
  busy: boolean
}>()

const emit = defineEmits<{
  open: [contest: VoterContest]
  end: []
}>()

const allDone = computed(() => props.election.remaining === 0)
</script>

<template>
  <section aria-labelledby="voter-heading">
    <h1
      id="voter-heading"
      tabindex="-1"
    >
      {{ election.title }}
    </h1>
    <p
      v-if="election.round === 'testing'"
      class="message warning"
    >
      Probelauf: Diese Stimmen zählen nicht.
    </p>
    <p
      v-if="message"
      class="message error"
      role="alert"
    >
      {{ message }}
    </p>
    <h2>Ihre Wahlen</h2>
    <ul
      class="plain contests"
      aria-label="Wahlen"
    >
      <li
        v-for="contest in election.contests"
        :key="contest.id"
      >
        <span class="title">{{ contest.title }}</span>
        <span
          v-if="contest.done"
          class="done"
        >abgegeben</span>
        <button
          v-else
          type="button"
          :disabled="busy"
          :aria-label="`Stimmzettel ausfüllen: ${contest.title}`"
          @click="emit('open', contest)"
        >
          Stimmzettel ausfüllen
        </button>
      </li>
    </ul>
    <output class="status">
      {{ remainingText(election.remaining) }}
    </output>
    <div class="actions">
      <button
        type="button"
        :class="{ secondary: !allDone }"
        :disabled="busy"
        @click="emit('end')"
      >
        {{ allDone ? 'Fertig' : 'Beenden' }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.status {
  display: block;
  margin: 0 0 10px;
}

.contests > li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 12px;
  padding: 12px 0;
}

.title {
  font-weight: 600;
}

.done {
  color: var(--ok);
  font-weight: 600;
}
</style>
