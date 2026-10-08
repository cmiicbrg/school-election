<script setup lang="ts">
// Vorbereiten: what will be printed and for whom, what still blocks it,
// what a formal election usually has, and the step itself. Preparing
// again after a return to draft may make sheets invalid: the API says
// which, and the page asks before it goes on.

import { computed, ref, watch } from 'vue'
import { useDialogFocus } from '../lib/dialog-focus.ts'
import { apiPost } from '../lib/api.ts'
import { ApiError, errorMessage } from '../lib/api-rules.ts'
import { problemText, RULESET_LABELS, warningText, type Problem } from '../lib/labels.ts'
import type { SetupRules } from '../lib/setup-rules.ts'
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

const shownProblems = computed(() => problems.value.length > 0 ? problems.value : props.preparation.problems)

// The confirmation names what preparing would void now, and the refusal
// what was missing then: a change of the configuration makes both stale,
// so they go away with one (the page reads what is missing again).
watch(() => props.configuration, () => {
  stale.value = null
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
  problems.value = []
  try {
    await apiPost(`/api/elections/${props.electionId}/prepare`, confirmed ? { confirmVoid: confirmed.map((batch) => batch.id) } : undefined)
    stale.value = null
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
  <section aria-labelledby="prepare-heading">
    <h2 id="prepare-heading">
      Vorbereiten
    </h2>
    <p class="muted">
      Vorbereiten legt den Aufbau fest: welche Klassen und Gruppen in welchen Wahlen wählen. Danach können Stimmkarten erzeugt werden; Namen von Kandidat:innen bleiben bis zum Beginn der Stimmabgabe änderbar.
    </p>

    <h3>Wer wählt wo</h3>
    <table v-if="preparation.summary.voterGroups.length > 0">
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
    <p
      v-else
      class="muted"
    >
      Noch keine Klassen oder Gruppen.
    </p>

    <h3>Wahlen</h3>
    <table v-if="preparation.summary.contests.length > 0">
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
    <p
      v-else
      class="muted"
    >
      Noch keine Wahlen.
    </p>

    <ul
      v-if="shownProblems.length > 0"
      class="plain"
      aria-label="Was noch fehlt"
    >
      <li
        v-for="(problem, index) in shownProblems"
        :key="index"
        class="message error"
      >
        {{ problemText(problem, names) }}
      </li>
    </ul>
    <ul
      v-if="preparation.warnings.length > 0"
      class="plain"
      aria-label="Hinweise"
    >
      <li
        v-for="(warning, index) in preparation.warnings"
        :key="index"
        class="message warning"
      >
        {{ warningText(warning) }}
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
  </section>
</template>
