<script setup lang="ts">
// The election and the contests the key may vote in, under the Wahlgang
// the card is for: each with its button to the ballot or, once cast, a
// check; what was just cast and how many are left, in the step's one
// status; and the way out, which ends the session. A card with nothing to
// vote now says so in that status.

import { computed } from 'vue'
import LineIcon from '../components/LineIcon.vue'
import { ROUND_LABELS } from '../lib/labels.ts'
import type { VoterContest, VoterElection } from './voter-api.ts'
import { castText, remainingText } from './voter-rules.ts'

const props = defineProps<{
  election: VoterElection
  message: string | null
  busy: boolean
  /** The title of the contest whose ballot was just cast, or null. */
  cast: string | null
}>()

const emit = defineEmits<{
  open: [contest: VoterContest]
  end: []
}>()

const allDone = computed(() => props.election.remaining === 0)
const status = computed(() => {
  if (props.election.contests.length === 0) return 'Mit dieser Stimmkarte gibt es gerade nichts zu wählen.'
  return props.cast === null ? remainingText(props.election.remaining) : castText(props.cast, props.election.remaining)
})
</script>

<template>
  <section aria-labelledby="voter-heading">
    <h1
      id="voter-heading"
      tabindex="-1"
    >
      {{ election.title }}
    </h1>
    <p class="round">
      {{ ROUND_LABELS[election.roundKind] }}
    </p>
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
    <template v-if="election.contests.length > 0">
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
          ><LineIcon
            name="check"
            :size="18"
          /> abgegeben</span>
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
    </template>
    <output class="status">
      {{ status }}
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
.round {
  margin-top: -6px;
  color: var(--ink2);
  font-weight: 600;
}

.status {
  display: block;
  margin: 12px 0 10px;
}

.contests > li {
  display: grid;
  gap: 8px;
  padding: 14px 0;
}

.title {
  font-weight: 600;
}

.contests button {
  width: 100%;
}

.done {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--ok);
  font-weight: 600;
}
</style>
