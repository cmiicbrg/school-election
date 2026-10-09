<script setup lang="ts">
// Vorbereiten: what will be printed and for whom, a checklist of what
// preparing needs and what a formal election usually has (lib/checklist.ts),
// and the step itself. The checklist is neutral, open or done, and turns
// red only where a refused "Vorbereiten" found something missing. Preparing
// again after a return to draft may make sheets invalid: the API says
// which, and the page asks before it goes on.

import { computed, ref, watch } from 'vue'
import { useDialogFocus } from '../lib/dialog-focus.ts'
import { apiPost } from '../lib/api.ts'
import { ApiError, errorMessage } from '../lib/api-rules.ts'
import { recommendedItems, requiredItems } from '../lib/checklist.ts'
import { RULESET_LABELS, type Problem } from '../lib/labels.ts'
import type { SetupRules } from '../lib/setup-rules.ts'
import { notify } from '../lib/toast.ts'
import type { Configuration, Preparation, StaleBatch } from '../lib/types.ts'

const props = defineProps<{
  electionId: string
  preparation: Preparation
  configuration: Configuration
  rules: SetupRules
  prepared: boolean
}>()

const emit = defineEmits<{ changed: [] }>()

const busy = ref(false)
const error = ref<string | null>(null)
const problems = ref<Problem[]>([])
const stale = ref<StaleBatch[] | null>(null)

const names = computed(() => ({
  contest: (id: string) => props.configuration.contests.find((contest) => contest.id === id)?.title ?? '?',
  group: (id: string) => props.configuration.voterGroups.find((group) => group.id === id)?.name ?? '?',
}))

/** Preparing was refused for what is missing: the open items say so in red, while the same is missing. */
const refused = computed(() => problems.value.length > 0)
const required = computed(() => requiredItems(refused.value ? problems.value : props.preparation.problems, names.value))
const recommended = computed(() => recommendedItems(props.preparation.warnings))

// The confirmation names what preparing would void now: a change of the
// configuration makes it stale, so it goes away with one.
watch(() => props.configuration, () => {
  stale.value = null
})
// The refusal holds while the same is missing, through a reload for
// something else and another try, and goes away once what is missing
// changes (the page reads it again after every change).
watch(() => JSON.stringify(props.preparation.problems), () => {
  problems.value = []
})

const voidHeading = ref<HTMLElement | null>(null)
const prepareButton = ref<HTMLButtonElement | null>(null)
useDialogFocus(stale, voidHeading, prepareButton)

/**
 * Preparing, with or without a confirmation. A confirmation names the
 * batches the dialog showed, and the API voids only if exactly those are
 * stale at that moment: a change in between comes back as void_required
 * with the batches as they are now, which the dialog then shows instead.
 */
async function prepare(confirmed?: readonly StaleBatch[]): Promise<void> {
  busy.value = true
  error.value = null
  try {
    await apiPost(`/api/elections/${props.electionId}/prepare`, confirmed ? { confirmVoid: confirmed.map((batch) => batch.id) } : undefined)
    stale.value = null
    problems.value = []
    notify('Der Wahltermin ist vorbereitet: Jetzt können Stimmkarten erzeugt werden.')
    emit('changed')
  } catch (err) {
    if (err instanceof ApiError && err.code === 'void_required' && Array.isArray(err.body.batches)) {
      stale.value = err.body.batches as StaleBatch[]
      if (confirmed) error.value = 'Die betroffenen Stimmkarten haben sich geändert; bitte prüfen Sie die Liste noch einmal.'
    } else if (err instanceof ApiError && err.code === 'not_ready' && Array.isArray(err.body.problems)) {
      problems.value = err.body.problems as Problem[]
    } else {
      error.value = errorMessage(err)
    }
  } finally {
    busy.value = false
  }
}

async function unprepare(): Promise<void> {
  busy.value = true
  error.value = null
  try {
    await apiPost(`/api/elections/${props.electionId}/unprepare`)
    notify('Zurück zum Entwurf: Aufbau und Zuordnung lassen sich wieder ändern.')
    emit('changed')
  } catch (err) {
    error.value = errorMessage(err)
  } finally {
    busy.value = false
  }
}

const staleKeys = computed(() => (stale.value ?? []).reduce((sum, batch) => sum + batch.keys, 0))
</script>

<template>
  <div>
    <p class="muted">
      Vorbereiten legt den Aufbau fest: welche Klassen und Gruppen in welchen Wahlen wählen. Danach können Stimmkarten erzeugt werden; Namen von Kandidat:innen bleiben bis zum Beginn der Stimmabgabe änderbar.
    </p>

    <h3>Wer wählt wo</h3>
    <div
      v-if="preparation.summary.voterGroups.length > 0"
      class="table-scroll"
    >
      <table>
        <thead>
          <tr>
            <th scope="col">
              Klasse / Gruppe
            </th><th scope="col">
              Wahlen
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="group in preparation.summary.voterGroups"
            :key="group.id"
          >
            <td>{{ group.name }}</td>
            <td>{{ group.contests.map((contest) => contest.title).join(', ') || '–' }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <p
      v-else
      class="muted"
    >
      Noch keine Klassen oder Gruppen.
    </p>

    <h3>Wahlen</h3>
    <div
      v-if="preparation.summary.contests.length > 0"
      class="table-scroll"
    >
      <table>
        <thead>
          <tr>
            <th scope="col">
              Wahl
            </th><th scope="col">
              Regeln
            </th><th scope="col">
              Kandidat:innen
            </th><th scope="col">
              Reihungen
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="contest in preparation.summary.contests"
            :key="contest.id"
          >
            <td>{{ contest.title }}</td>
            <td>{{ RULESET_LABELS[contest.rulesetId] }}</td>
            <td>{{ contest.candidates }}</td>
            <td>{{ contest.activeSlots }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <p
      v-else
      class="muted"
    >
      Noch keine Wahlen.
    </p>

    <template v-if="!prepared">
      <h3>Nötig zum Vorbereiten</h3>
      <ul
        class="checklist"
        aria-label="Nötig zum Vorbereiten"
      >
        <li
          v-for="item in required"
          :key="item.text"
          :class="{ done: item.done, missing: refused && !item.done }"
        >
          <span
            class="mark"
            aria-hidden="true"
          >{{ item.done ? '✓' : '○' }}</span>
          <span>
            {{ item.text }}<span class="visually-hidden">: {{ item.done ? 'erledigt' : 'offen' }}</span>
            <ul
              v-if="!item.done && item.missing.length > 0"
              class="details"
            >
              <li
                v-for="line in item.missing"
                :key="line"
              >
                {{ line }}
              </li>
            </ul>
          </span>
        </li>
      </ul>
      <p
        v-if="refused"
        class="message error"
        role="alert"
      >
        Vorbereiten geht noch nicht: Was oben rot steht, fehlt noch.
      </p>
    </template>
    <h3>Empfohlen</h3>
    <ul
      class="checklist"
      aria-label="Empfohlen"
    >
      <li
        v-for="item in recommended"
        :key="item.text"
        :class="{ done: item.done }"
      >
        <span
          class="mark"
          aria-hidden="true"
        >{{ item.done ? '✓' : '○' }}</span>
        <span>
          {{ item.text }}<span class="visually-hidden">: {{ item.done ? 'erledigt' : 'offen' }}</span>
          <ul
            v-if="!item.done && item.missing.length > 0"
            class="details"
          >
            <li
              v-for="line in item.missing"
              :key="line"
            >
              {{ line }}
            </li>
          </ul>
        </span>
      </li>
    </ul>

    <div
      v-if="stale"
      class="card-box"
      role="alertdialog"
      aria-labelledby="void-heading"
    >
      <h3
        id="void-heading"
        ref="voidHeading"
        tabindex="-1"
      >
        Stimmkarten werden ungültig
      </h3>
      <p>Durch die Änderungen am Aufbau passen die Stimmkarten dieser Klassen oder Gruppen nicht mehr. Beim Vorbereiten werden sie ungültig und müssen neu erzeugt und gedruckt werden:</p>
      <ul>
        <li
          v-for="batch in stale"
          :key="batch.id"
        >
          {{ names.group(batch.voterGroupId) }}: {{ batch.keys }} Stimmkarten
        </li>
      </ul>
      <div class="actions">
        <button
          type="button"
          class="danger"
          :disabled="busy"
          @click="prepare(stale)"
        >
          Trotzdem vorbereiten ({{ staleKeys }} Stimmkarten werden ungültig)
        </button>
        <button
          type="button"
          class="secondary"
          :disabled="busy"
          @click="stale = null"
        >
          Abbrechen
        </button>
      </div>
    </div>

    <p
      v-if="error"
      class="message error"
      role="alert"
    >
      {{ error }}
    </p>
    <div class="actions">
      <button
        v-if="rules.prepare"
        ref="prepareButton"
        type="button"
        :disabled="busy"
        @click="prepare()"
      >
        Vorbereiten
      </button>
      <button
        v-if="rules.unprepare"
        type="button"
        class="secondary"
        :disabled="busy"
        @click="unprepare"
      >
        Zurück zum Entwurf
      </button>
      <output
        v-if="prepared && !rules.unprepare"
        class="muted"
      >
        Der Wahltermin ist vorbereitet.
      </output>
    </div>
  </div>
</template>

<style scoped>
.checklist {
  margin: 0 0 12px;
  padding: 0;
  list-style: none;
}

.checklist > li {
  display: flex;
  gap: 8px;
  padding: 4px 0;
}

.mark {
  flex: none;
  width: 1.2em;
  color: var(--muted);
  text-align: center;
}

.done > .mark {
  color: var(--ok);
}

.missing {
  color: var(--danger);
  font-weight: 600;
}

.missing > .mark {
  color: var(--danger);
}

.details {
  margin: 2px 0 0;
  padding-left: 1.1em;
  font-weight: 400;
}
</style>
