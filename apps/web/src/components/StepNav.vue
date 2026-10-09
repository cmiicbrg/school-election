<script setup lang="ts">
// The termin's steps, in order, each done, the current one or still to
// come (lib/steps.ts), with a line under its name that says where it
// stands. A step leads to its section on the page; the result to its own
// page once the 1. Wahlgang is counted. The page shows the list beside
// the steps, and on a phone in the strip under the title.

import { RouterLink } from 'vue-router'
import LineIcon from './LineIcon.vue'
import { STEP_LABELS, STEP_NUMBERS, STEPS, type Step, type StepState } from '../lib/steps.ts'

const props = defineProps<{
  electionId: string
  states: Record<Step, StepState>
  /** The line under each step's name. */
  statuses: Record<Step, string>
  /** The 1. Wahlgang is counted: the result page has something to show. */
  resultReady: boolean
}>()

const emit = defineEmits<{ went: [] }>()

const STATE_TEXT: Readonly<Record<StepState, string>> = {
  done: 'erledigt',
  current: 'jetzt',
  open: 'noch offen',
}

/** A step's section on this page, the result's page once there is one, or no link yet. */
const tagOf = (step: Step) => (step !== 'ergebnis' ? 'a' : props.resultReady ? RouterLink : 'span')
const attrsOf = (step: Step) => (step !== 'ergebnis' ? { href: `#${step}` } : props.resultReady ? { to: `/wahlen/${props.electionId}/ergebnis` } : {})

/**
 * To the step's section, with the focus on its heading, so a keyboard goes
 * on from there. The Probelauf's block is there only while one can run or
 * runs; otherwise its step leads to the day's section it belongs to.
 */
function go(event: MouseEvent, step: Step): void {
  if (step === 'ergebnis') return
  event.preventDefault()
  const heading = document.getElementById(`${step}-heading`) ?? document.getElementById('wahltag-heading')
  heading?.scrollIntoView({ block: 'start' })
  heading?.focus({ preventScroll: true })
  emit('went')
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
        <component
          :is="tagOf(step)"
          class="item"
          v-bind="attrsOf(step)"
          @click="(event: MouseEvent) => go(event, step)"
        >
          <span
            class="mark"
            aria-hidden="true"
          >
            <LineIcon
              v-if="states[step] === 'done'"
              name="check"
              :size="14"
            />
            <template v-else>{{ STEP_NUMBERS[step] }}</template>
          </span>
          <span class="text">
            <span class="label">{{ STEP_LABELS[step] }}</span>
            <span
              v-if="statuses[step]"
              class="status"
            >{{ statuses[step] }}</span>
          </span>
        </component>
        <span class="visually-hidden">({{ STATE_TEXT[states[step]] }})</span>
      </li>
    </ol>
  </nav>
</template>

<style scoped>
.steps ol {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.item {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 44px;
  padding: 8px 12px;
  border-radius: 10px;
  color: var(--ink);
  text-decoration: none;
}

a.item:hover {
  background: var(--paper);
}

.text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.label {
  font-weight: 600;
}

.status {
  color: var(--muted);
  font-size: 0.8rem;
}

.mark {
  flex: none;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border: 1.5px solid var(--line2);
  border-radius: 50%;
  background: var(--paper);
  color: var(--muted);
  font-size: 0.8rem;
  font-weight: 700;
}

.done .mark {
  border-color: transparent;
  background: var(--ok-bg);
  color: var(--ok);
}

.current .item {
  background: var(--paper);
  box-shadow: 0 0 0 1px var(--line);
}

.current .label {
  font-weight: 700;
}

.current .mark {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--accent-ink);
}

.open .item {
  color: var(--muted);
}
</style>
