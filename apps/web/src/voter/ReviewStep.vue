<script setup lang="ts">
// What would be sent, row by row, and election-core's say about it: a valid
// vote goes with "Abgeben"; an invalid one, rows left empty, says so, counts
// for nobody, and goes only with the voter's checkbox and the button that
// says what it does; "Nein" goes as it is. "Korrigieren" returns to the
// ballot as it was.

import { computed, ref } from 'vue'
import { review } from './ballot-state.ts'
import type { VoterBallot, VoterContest } from './voter-api.ts'
import { candidateName, emptyRowsText, pointsLabel, slotRows, yesOrNo } from './voter-rules.ts'

const props = defineProps<{
  contest: VoterContest
  ballot: VoterBallot
  busy: boolean
  message: string | null
}>()

const emit = defineEmits<{
  submit: [confirmInvalid: boolean]
  correct: []
}>()

const verdict = computed(() => review(props.contest, props.ballot))
const single = computed(() => yesOrNo(props.contest))
const confirmed = ref(false)
const lines = computed(() => {
  if (props.ballot.kind === 'no') return []
  const { ranking } = props.ballot
  return slotRows(props.contest).map((row) => {
    const id = ranking[row.rank - 1] ?? null
    const candidate = props.contest.candidates.find((entry) => entry.id === id)
    return { rank: row.rank, label: `${pointsLabel(row.points)} · ${row.label}`, name: candidate ? candidateName(candidate) : null }
  })
})
</script>

<template>
  <section
    class="review"
    aria-labelledby="voter-heading"
  >
    <h1
      id="voter-heading"
      tabindex="-1"
    >
      Prüfen: {{ contest.title }}
    </h1>
    <p v-if="ballot.kind === 'no'">
      Sie stimmen mit <strong>Nein</strong>.
    </p>
    <p v-else-if="single">
      Sie stimmen mit <strong>Ja</strong> für {{ lines[0]?.name }}.
    </p>
    <ul
      v-else
      class="plain lines"
      aria-label="Ihr Stimmzettel"
    >
      <li
        v-for="line in lines"
        :key="line.rank"
      >
        <span class="label">{{ line.label }}: </span>
        <span :class="{ empty: !line.name }">{{ line.name ?? 'leer' }}</span>
      </li>
    </ul>
    <p
      v-if="verdict.kind === 'valid'"
      class="message ok"
      role="status"
    >
      Gültige Stimme.
    </p>
    <p
      v-else-if="verdict.kind === 'invalid'"
      class="message warning"
      role="status"
    >
      Ungültige Stimme: {{ emptyRowsText(verdict.empty, verdict.of) }}. Eine ungültige Stimme zählt für niemanden.
    </p>
    <p
      v-if="message"
      class="message error"
      role="alert"
    >
      {{ message }}
    </p>
    <label
      v-if="verdict.kind === 'invalid'"
      class="option"
    >
      <input
        v-model="confirmed"
        type="checkbox"
        :disabled="busy"
      >
      Ich gebe meine Stimme absichtlich ungültig ab.
    </label>
    <div class="actions">
      <button
        v-if="verdict.kind === 'invalid'"
        type="button"
        class="danger"
        :disabled="busy || !confirmed"
        @click="emit('submit', true)"
      >
        Ungültig abgeben
      </button>
      <button
        v-else
        type="button"
        :disabled="busy"
        @click="emit('submit', false)"
      >
        Abgeben
      </button>
      <button
        type="button"
        class="secondary"
        :disabled="busy"
        @click="emit('correct')"
      >
        Korrigieren
      </button>
    </div>
  </section>
</template>

<style scoped>
.lines > li {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 8px;
  padding: 10px 0;
}

.label {
  color: var(--muted);
}

.empty {
  color: var(--warn);
  font-weight: 600;
}

.option {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin: 12px 0;
  font-weight: 500;
}

.option input {
  flex: none;
  width: 1.4rem;
  height: 1.4rem;
  margin-top: 2px;
}

.actions button {
  min-height: 44px;
}
</style>
