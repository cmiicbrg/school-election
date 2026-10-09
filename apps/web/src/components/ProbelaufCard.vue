<script setup lang="ts">
// Schritt 5, the Probelauf: a rehearsal on the real cards, whose ballots
// count for nothing and go when it ends; it can run more than once. While
// it runs the card is in the colour of a test, with the cards used and the
// interim count on request. It can be marked done or skipped, and
// collapses then, never while it runs (lib/steps.ts).

import { computed } from 'vue'
import LineIcon from './LineIcon.vue'
import StepSection from './StepSection.vue'
import TurnoutFigures from './TurnoutFigures.vue'
import type { ElectionDay } from '../lib/election-day.ts'
import { countsLine, firstPlacesLine } from '../lib/outcome-text.ts'

const props = defineProps<{
  day: ElectionDay
  /** A Probelauf runs now. */
  running: boolean
  /** Marked done or skipped; null while it runs, when nobody marks it. */
  collapsed: boolean | null
}>()

const emit = defineEmits<{ toggle: [] }>()

const INTRO = 'Der Probelauf nimmt Stimmen mit den echten Stimmkarten an. Sie zählen nicht, und beim Beenden wird alles verworfen; er kann mehrmals laufen.'

const notice = computed(() => props.day.noticeIn('probelauf'))
const error = computed(() => props.day.errorIn('probelauf'))
/** No dialog of the day is open: only then are its steps offered. */
const idle = computed(() => props.day.confirming === null && !props.day.finalizing)
</script>

<template>
  <StepSection
    id="probelauf"
    title="Probelauf"
    :number="5"
    :intro="INTRO"
    :running="running"
    :collapsed="collapsed"
    @toggle="emit('toggle')"
  >
    <template #summary>
      <p>Erledigt oder übersprungen.</p>
    </template>
    <div class="probelauf">
      <output
        v-if="notice"
        class="notice"
      >
        <LineIcon name="check" />
        <span>{{ notice }}</span>
      </output>
      <div
        v-if="idle && (day.rules.startTest || day.rules.endTest || day.rules.showTestResult)"
        class="actions"
      >
        <button
          v-if="day.rules.startTest"
          type="button"
          class="secondary"
          :disabled="day.busy"
          @click="day.startTest()"
        >
          <LineIcon name="flask" />Probelauf starten
        </button>
        <button
          v-if="day.rules.endTest"
          type="button"
          class="test"
          :disabled="day.busy"
          @click="day.endTest()"
        >
          <LineIcon name="stop" />Probelauf beenden
        </button>
        <button
          v-if="day.rules.showTestResult"
          type="button"
          class="secondary"
          :disabled="day.busy"
          @click="day.readTestResult()"
        >
          <LineIcon name="chart" />Zwischenstand
        </button>
      </div>
      <TurnoutFigures
        v-if="running && day.turnout?.kind === 'regular'"
        :turnout="day.turnout"
        :title="day.contestTitle"
        testing
      />
      <ul
        v-if="day.rules.showTestResult && day.testResult"
        class="interim"
        aria-label="Zwischenstand"
      >
        <li
          v-for="snapshot in day.testResult.contests"
          :key="snapshot.contestId"
        >
          <strong>{{ day.contestTitle(snapshot.contestId) }}</strong>: {{ countsLine(snapshot.result.statistics) }} {{ firstPlacesLine(day.rulesetOf(snapshot.contestId), snapshot.result.statistics, day.names) }}
        </li>
      </ul>
      <p
        v-if="error"
        class="message error"
        role="alert"
      >
        {{ error }}
      </p>
    </div>
  </StepSection>
</template>

<style scoped>
.probelauf {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.probelauf > .actions,
.probelauf > .message {
  margin: 0;
}

.interim {
  margin: 0;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--paper);
  list-style: none;
}

.interim > li {
  padding: 10px 14px;
  font-size: 0.9rem;
}

.interim > li + li {
  border-top: 1px solid var(--line);
}
</style>
