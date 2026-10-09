<script setup lang="ts">
// Schritt 6, the Wahltag: where the day stands, the turnout of the round
// that runs or ran, and the one step of the moment: open the 1. Wahlgang,
// end and count it, activate the runoff with the runoff cards of each
// class, end and count the runoff. Before the opening it names the classes
// that have no valid cards, which the opening's dialog asks about again.
// Every step asks first, in a dialog within the card.

import { computed, ref, toRef, watch } from 'vue'
import LineIcon from './LineIcon.vue'
import StepSection from './StepSection.vue'
import TurnoutFigures from './TurnoutFigures.vue'
import { useDialogFocus } from '../lib/dialog-focus.ts'
import type { ElectionDay } from '../lib/election-day.ts'
import type { ElectionDetail } from '../lib/types.ts'

const props = defineProps<{
  day: ElectionDay
  election: ElectionDetail
  /** A draft: the day cannot start yet. */
  locked: boolean
}>()

const notice = computed(() => props.day.noticeIn('wahltag'))
const error = computed(() => props.day.errorIn('wahltag'))
/** No dialog of the day is open: only then are its steps offered. */
const idle = computed(() => props.day.confirming === null && !props.day.finalizing)
const testing = computed(() => props.election.lifecycle.regular === 'testing')
/** The turnout of the round that runs or ran; a Probelauf's is the Probelauf card's. */
const turnout = computed(() => {
  const figures = props.day.turnout
  return figures && figures.kind === props.day.rules.turnoutOf && !testing.value ? figures : null
})
/** The classes that could not vote in the 1. Wahlgang if it opened now. */
const withoutCards = computed(() => (props.day.rules.open ? props.day.regularCards.lines.filter((line) => line.missing) : []))

/** Ticked in the dialog: the step goes ahead although a class has no cards. */
const overridden = ref(false)
watch(() => props.day.confirming, () => {
  overridden.value = false
})

const confirmHeading = ref<HTMLElement | null>(null)
useDialogFocus(toRef(() => props.day.confirming), confirmHeading)
</script>

<template>
  <StepSection
    id="wahltag"
    title="Wahltag"
    :number="6"
    :locked="locked"
    :collapsed="null"
  >
    <template
      v-if="!locked"
      #intro
    >
      <p data-testid="state">
        <strong>{{ day.stateLine }}</strong>
      </p>
    </template>
    <div class="wahltag">
      <p
        v-if="locked"
        data-testid="state"
      >
        {{ day.stateLine }}
      </p>
      <output
        v-if="notice"
        class="notice"
      >
        <LineIcon name="check" />
        <span>{{ notice }}</span>
      </output>

      <TurnoutFigures
        v-if="turnout"
        :turnout="turnout"
        :title="day.contestTitle"
      />

      <template v-if="day.rules.open">
        <p class="lead">
          Ab dem Öffnen zählen die Stimmen. Die Stimmkarten des 1. Wahlgangs können danach nicht mehr gedruckt werden.
        </p>
        <ul
          v-if="withoutCards.length > 0"
          class="warnings"
          aria-label="Ohne gültige Stimmkarten"
        >
          <li
            v-for="line in withoutCards"
            :key="line.text"
          >
            <LineIcon name="alert" />{{ line.text }}
          </li>
        </ul>
      </template>

      <div
        v-if="day.rules.activateRunoff && day.runoff.pairs.length > 0"
        class="runoff"
      >
        <h3>Stichwahl</h3>
        <p>
          <template
            v-for="entry in day.runoff.pairs"
            :key="entry.contestId"
          >
            {{ day.contestTitle(entry.contestId) }}: {{ day.names.candidate(entry.pair[0]) }} gegen {{ day.names.candidate(entry.pair[1]) }}.
          </template>
        </p>
        <ul
          class="runoff-sheets"
          aria-label="Stichwahl-Stimmkarten"
        >
          <li
            v-for="{ group, batches: issued, keys } in day.runoffSheets"
            :key="group.id"
          >
            <template v-if="issued.length > 0">
              <span>{{ group.name }}: {{ keys }} Stichwahl-Stimmkarten</span>
              <a
                v-for="batch in issued"
                :key="batch.id"
                :href="day.printPath(batch)"
                target="_blank"
                rel="noopener"
                class="button secondary small"
              ><LineIcon name="print" />Drucken ({{ batch.keys }})</a>
            </template>
            <span
              v-else
              class="no-sheets"
            ><LineIcon name="alert" />Für {{ group.name }} gibt es noch keine Stichwahl-Stimmkarten: zuerst unter Stimmkarten erzeugen und drucken.</span>
          </li>
        </ul>
        <p
          v-if="day.runoff.waiting.length > 0"
          class="message warning"
        >
          Zuerst den Losentscheid eintragen: {{ day.runoff.waiting.map(day.contestTitle).join(', ') }}.
        </p>
        <div
          v-else-if="idle"
          class="actions"
        >
          <button
            type="button"
            class="large"
            :disabled="day.busy"
            data-step="activate"
            @click="day.ask('activate')"
          >
            Stichwahl aktivieren
          </button>
        </div>
      </div>

      <div
        v-if="day.dialog"
        class="card-box dialog"
        role="alertdialog"
        aria-labelledby="day-dialog-heading"
      >
        <h3
          id="day-dialog-heading"
          ref="confirmHeading"
          tabindex="-1"
        >
          {{ day.dialog.title }}
        </h3>
        <p>{{ day.dialog.text }}</p>
        <ul
          v-if="day.dialog.lines.length > 0"
          class="plain dialog-lines"
          :aria-label="`${day.dialog.title} – Stimmkarten`"
        >
          <li
            v-for="line in day.dialog.lines"
            :key="line.text"
            :class="{ missing: line.missing }"
          >
            {{ line.text }}
          </li>
        </ul>
        <label
          v-if="day.dialog.override"
          class="check override"
        >
          <input
            v-model="overridden"
            type="checkbox"
          >
          {{ day.dialog.override }}
        </label>
        <div class="actions">
          <button
            type="button"
            :class="{ danger: day.dialog.danger }"
            :disabled="day.busy || (day.dialog.override !== null && !overridden)"
            @click="day.confirm()"
          >
            {{ day.dialog.yes }}
          </button>
          <button
            type="button"
            class="secondary"
            :disabled="day.busy"
            @click="day.cancel()"
          >
            Abbrechen
          </button>
        </div>
      </div>

      <div
        v-if="idle && (day.rules.open || day.rules.closeRegular || day.rules.closeRunoff)"
        class="actions"
      >
        <button
          v-if="day.rules.open"
          type="button"
          class="large"
          :disabled="day.busy"
          data-step="open"
          @click="day.ask('open')"
        >
          <LineIcon name="play" />1. Wahlgang öffnen
        </button>
        <button
          v-if="day.rules.closeRegular"
          type="button"
          class="danger large"
          :disabled="day.busy"
          data-step="close-regular"
          @click="day.ask('close-regular')"
        >
          <LineIcon name="stop" />1. Wahlgang beenden und auszählen
        </button>
        <button
          v-if="day.rules.closeRunoff"
          type="button"
          class="danger large"
          :disabled="day.busy"
          data-step="close-runoff"
          @click="day.ask('close-runoff')"
        >
          <LineIcon name="stop" />Stichwahl beenden und auszählen
        </button>
      </div>
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
.wahltag {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.wahltag > p,
.wahltag > .actions,
.wahltag > .message {
  margin: 0;
}

.lead {
  color: var(--ink2);
  font-size: 0.9rem;
}

.warnings {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  color: var(--warn);
  font-size: 0.9rem;
  list-style: none;
}

.warnings > li,
.no-sheets {
  display: flex;
  align-items: flex-start;
  gap: 6px;
}

.warnings .icon,
.no-sheets .icon {
  margin-top: 3px;
}

.runoff {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: 12px;
}

.runoff h3 {
  margin: 0;
  font-size: 1.05rem;
}

.runoff > p,
.runoff > .actions,
.runoff > .message {
  margin: 0;
}

.runoff-sheets {
  margin: 0;
  padding: 0;
  list-style: none;
}

.runoff-sheets > li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 6px 12px;
  padding: 8px 0;
}

.runoff-sheets > li + li {
  border-top: 1px solid var(--line);
}

.no-sheets {
  color: var(--warn);
}

.dialog {
  margin: 0;
}

.dialog h3 {
  margin-top: 0;
}

.dialog-lines {
  margin: 8px 0;
}

.dialog-lines .missing {
  color: var(--danger);
  font-weight: 600;
}

.override {
  display: block;
  margin: 8px 0;
  font-weight: 600;
}

button.large {
  min-height: 44px;
  padding: 0 20px;
}
</style>
