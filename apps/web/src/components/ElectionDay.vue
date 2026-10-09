<script setup lang="ts">
// The election day as cards of the termin's page: the Probelauf (Schritt
// 5) while one can run or runs, the Wahltag (Schritt 6), the result once
// the 1. Wahlgang is counted, and "Ergebnis feststellen" (Schritt 7). They
// share the day's state (lib/election-day.ts) and stand side by side in
// the page's list of cards, which places them as one (lib/steps.ts,
// sectionOrder); before a run, the Probelauf and the Wahltag stand next to
// each other (the class `paired`, which the page lays out).

import { computed, reactive } from 'vue'
import { RouterLink } from 'vue-router'
import ContestResultCard from './ContestResultCard.vue'
import FinalizeCard from './FinalizeCard.vue'
import ProbelaufCard from './ProbelaufCard.vue'
import WahltagCard from './WahltagCard.vue'
import { useElectionDay } from '../lib/election-day.ts'
import type { BatchSummary, Configuration, ElectionDetail } from '../lib/types.ts'

const props = defineProps<{
  election: ElectionDetail
  configuration: Configuration
  batches: BatchSummary[]
  /** The Probelauf is marked done or skipped (lib/steps.ts): its card is collapsed. */
  probelaufDone: boolean
}>()

const emit = defineEmits<{ changed: [], probelauf: [done: boolean] }>()

const day = reactive(useElectionDay(() => ({ election: props.election, configuration: props.configuration, batches: props.batches }), () => emit('changed')))

const testing = computed(() => props.election.lifecycle.regular === 'testing')
const probelauf = computed(() => day.rules.startTest || day.rules.endTest || day.rules.showTestResult)
/** Before a run: the Probelauf, unless marked done, and the opening side by side. */
const paired = computed(() => probelauf.value && !testing.value && !props.probelaufDone && props.election.lifecycle.regular === 'planned')
/** Why the result could not be read: shown in its place, also when no result was read before, since a final termin reads it only once. */
const errorInResult = computed(() => day.errorIn('ergebnis'))
</script>

<template>
  <ProbelaufCard
    v-if="probelauf"
    :class="{ paired }"
    :day="day"
    :running="testing"
    :collapsed="testing ? null : probelaufDone"
    @toggle="emit('probelauf', !probelaufDone)"
  />
  <WahltagCard
    :class="{ paired }"
    :day="day"
    :election="election"
    :locked="election.state === 'draft'"
  />
  <section
    v-if="day.rules.showResult && (day.result || errorInResult)"
    id="ergebnis"
    class="results"
    aria-labelledby="ergebnis-heading"
  >
    <div class="results-head">
      <h2 id="ergebnis-heading">
        Ergebnis
      </h2>
      <p>
        In Worten; die Zahlen und jeden Schritt zeigt die Seite
        <RouterLink :to="`/wahlen/${election.id}/ergebnis`">
          Ergebnis und Herleitung
        </RouterLink>.
      </p>
    </div>
    <p
      v-if="errorInResult"
      class="message error"
      role="alert"
    >
      {{ errorInResult }}
    </p>
    <ContestResultCard
      v-for="contest in day.result?.contests ?? []"
      :key="contest.contestId"
      :day="day"
      :contest="contest"
    />
  </section>
  <FinalizeCard
    v-if="day.rules.finalize || day.rules.exportFile"
    :day="day"
    :final="election.state === 'final'"
  />
</template>

<style scoped>
.results {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.results-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 4px 12px;
  padding: 4px 4px 0;
}

.results-head h2 {
  margin: 0;
  padding: 0;
  border: 0;
  font-size: 1.3rem;
}

.results-head p {
  margin: 0;
  color: var(--muted);
  font-size: 0.85rem;
}

.results > .message {
  margin: 0;
}
</style>
