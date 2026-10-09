<script setup lang="ts">
// Schritt 7, "Ergebnis feststellen": the export of the termin, and for the
// Wahlleitung the step that makes the result final, with a reason, after a
// dialog that names what stays undecided. Once it is final, the export
// stays, with the digest of the file last saved.

import { computed, ref, toRef, useId } from 'vue'
import LineIcon from './LineIcon.vue'
import StepSection from './StepSection.vue'
import { useDialogFocus } from '../lib/dialog-focus.ts'
import type { ElectionDay } from '../lib/election-day.ts'

const props = defineProps<{
  day: ElectionDay
  /** The result is final. */
  final: boolean
}>()

const ids = { heading: useId(), reason: useId() }
const reason = ref('')
const notice = computed(() => props.day.noticeIn('feststellen'))
const error = computed(() => props.day.errorIn('feststellen'))
/** No dialog of the day is open: only then are its steps offered. */
const idle = computed(() => props.day.confirming === null && !props.day.finalizing)

const finalizeHeading = ref<HTMLElement | null>(null)
useDialogFocus(toRef(() => props.day.finalizing), finalizeHeading)

async function finalize(): Promise<void> {
  if (await props.day.finalize(reason.value)) reason.value = ''
}
</script>

<template>
  <StepSection
    id="feststellen"
    title="Ergebnis feststellen"
    :number="7"
    :intro="final ? undefined : 'Mit dem Feststellen wird das Ergebnis endgültig. Bis dahin können Mitglieder noch eingeladen und entfernt werden.'"
    :collapsed="null"
  >
    <div class="finalize">
      <output
        v-if="notice"
        class="notice"
      >
        <LineIcon name="check" />
        <span>{{ notice }}</span>
      </output>

      <div
        v-if="day.finalizing"
        class="card-box dialog"
        role="alertdialog"
        :aria-labelledby="ids.heading"
      >
        <h3
          :id="ids.heading"
          ref="finalizeHeading"
          tabindex="-1"
        >
          Ergebnis endgültig feststellen?
        </h3>
        <p>Der Wahltermin wird abgeschlossen: nichts ändert sich mehr, auch kein Losentscheid. Nicht verwendete Stichwahl-Stimmkarten werden ungültig. Die Datenbank wird bereinigt, was einige Sekunden dauert.</p>
        <template v-if="day.undecided.length > 0">
          <p class="message warning">
            Noch nicht entschieden; so festgestellt, bleibt es dabei:
          </p>
          <ul
            class="plain undecided"
            aria-label="Noch nicht entschieden"
          >
            <li
              v-for="line in day.undecided"
              :key="line"
            >
              {{ line }}
            </li>
          </ul>
        </template>
        <label :for="ids.reason">Begründung</label>
        <textarea
          :id="ids.reason"
          v-model="reason"
          maxlength="2000"
          required
          placeholder="Ergebnis festgestellt"
        />
        <div class="actions">
          <button
            type="button"
            class="danger"
            :disabled="day.busy || reason.trim() === ''"
            @click="finalize"
          >
            Ja, Ergebnis feststellen
          </button>
          <button
            type="button"
            class="secondary"
            :disabled="day.busy"
            @click="day.cancelFinalize()"
          >
            Abbrechen
          </button>
        </div>
      </div>

      <div
        v-if="idle && (day.rules.exportFile || day.rules.finalize)"
        class="actions"
      >
        <button
          v-if="day.rules.exportFile"
          type="button"
          class="secondary"
          :disabled="day.busy"
          @click="day.download()"
        >
          <LineIcon name="download" />Export herunterladen
        </button>
        <button
          v-if="day.rules.finalize"
          type="button"
          :class="['large', { secondary: day.undecided.length > 0 }]"
          :disabled="day.busy"
          data-step="finalize"
          @click="day.askFinalize()"
        >
          Ergebnis endgültig feststellen
        </button>
      </div>
      <p
        v-if="day.exported"
        class="exported"
        data-testid="exported"
      >
        Export gespeichert als {{ day.exported.name }}. SHA-256: <code>{{ day.exported.sha256 }}</code>. Jeder Export enthält das Protokoll bis zu diesem Zeitpunkt und hat deshalb seine eigene Prüfsumme; sie steht auch im Protokoll.
      </p>
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
.finalize {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.finalize > p,
.finalize > .actions,
.finalize > .message {
  margin: 0;
}

.dialog {
  margin: 0;
}

.dialog h3 {
  margin-top: 0;
}

.undecided {
  margin: 8px 0;
}

.undecided > li {
  color: var(--danger);
  font-weight: 600;
}

.exported {
  color: var(--muted);
  font-size: 0.85rem;
}

code {
  word-break: break-all;
}

button.large {
  min-height: 44px;
  padding: 0 20px;
}
</style>
