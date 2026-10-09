<script setup lang="ts">
// The termin's steps under its title, in order, each done, the current
// one or still to come (lib/steps.ts). A step leads to its section on the
// page; the result to its own page once the 1. Wahlgang is counted.

import { RouterLink } from 'vue-router'
import { STEP_LABELS, STEPS, type Step, type StepState } from '../lib/steps.ts'

defineProps<{
  electionId: string
  states: Record<Step, StepState>
  /** The 1. Wahlgang is counted: the result page has something to show. */
  resultReady: boolean
}>()

const MARKS: Readonly<Record<StepState, { symbol: string, text: string }>> = {
  done: { symbol: '✓', text: 'erledigt' },
  current: { symbol: '●', text: 'jetzt' },
  open: { symbol: '○', text: 'noch offen' },
}

/**
 * To the step's section, with the focus on its heading, so a keyboard goes
 * on from there. The Probelauf's block is there only while one can run or
 * runs; otherwise its step leads to the day's section it belongs to.
 */
function go(step: Step): void {
  const heading = document.getElementById(`${step}-heading`) ?? document.getElementById('wahltag-heading')
  heading?.scrollIntoView({ block: 'start' })
  heading?.focus({ preventScroll: true })
}
</script>

<template>
  <nav
    aria-label="Schritte"
    class="steps"
  >
    <ol>
      <li
        v-for="step in STEPS"
        :key="step"
        :class="states[step]"
        :aria-current="states[step] === 'current' ? 'step' : undefined"
      >
        <span aria-hidden="true">{{ MARKS[states[step]].symbol }}</span>
        <template v-if="step === 'ergebnis'">
          <RouterLink
            v-if="resultReady"
            :to="`/wahlen/${electionId}/ergebnis`"
          >
            {{ STEP_LABELS[step] }}
          </RouterLink>
          <span v-else>{{ STEP_LABELS[step] }}</span>
        </template>
        <a
          v-else
          :href="`#${step}`"
          @click.prevent="go(step)"
        >{{ STEP_LABELS[step] }}</a>
        <span class="visually-hidden">({{ MARKS[states[step]].text }})</span>
      </li>
    </ol>
  </nav>
</template>

<style scoped>
.steps ol {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
  margin: 0 0 12px;
  padding: 0;
  list-style: none;
}

.steps li {
  display: flex;
  gap: 4px;
  color: var(--muted);
}

.steps li.current {
  color: var(--ink);
  font-weight: 600;
}

.steps li.done {
  color: var(--ok);
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}
</style>
