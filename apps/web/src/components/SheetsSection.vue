<script setup lang="ts">
// Stimmkarten: the batches of keys per class, regular and runoff, with
// their counts; issuing, printing, and in a box of its own the exception
// that makes sheets invalid: replacing a batch. Witnesses see counts, and
// the codes once the batch's round has closed.

import { computed, reactive, ref } from 'vue'
import { useDialogFocus } from '../lib/dialog-focus.ts'
import type { Lifecycle, RoundKind } from '@school-election/election-core'
import { apiPost } from '../lib/api.ts'
import { errorMessage } from '../lib/api-rules.ts'
import { ROUND_LABELS, type Role } from '../lib/labels.ts'
import { mayReadKeys, type SetupRules } from '../lib/setup-rules.ts'
import { printable } from '../lib/sheet.ts'
import type { BatchSummary, Configuration } from '../lib/types.ts'

const props = defineProps<{
  electionId: string
  configuration: Configuration
  batches: BatchSummary[]
  rules: SetupRules
  role: Role
  lifecycle: Lifecycle
}>()

const emit = defineEmits<{ changed: [] }>()

const BATCH_STATE_LABELS = { issued: 'ausgegeben', void: 'ungültig' } as const

const busy = ref(false)
const error = ref<string | null>(null)
const done = ref<{ text: string, batchId: string } | null>(null)
const replacing = ref<BatchSummary | null>(null)
const replaceHeading = ref<HTMLElement | null>(null)
useDialogFocus(replacing, replaceHeading)
/** The number of voters entered per class. */
const counts = reactive<Record<string, number>>({})

const groups = computed(() => props.configuration.voterGroups.map((group) => ({
  ...group,
  batches: props.batches.filter((batch) => batch.voterGroupId === group.id),
})))

const anyIssue = computed(() => props.rules.issue.regular || props.rules.issue.runoff)
const anyReplace = computed(() => props.batches.some((batch) => batch.state === 'issued' && props.rules.replace[batch.roundKind]))

function printPath(batch: BatchSummary): string {
  return `/elections/${props.electionId}/batches/${batch.id}/print`
}

/** Sheets print until the batch's round opens; once it has closed, the codes with their use can be seen. */
function prints(batch: BatchSummary): boolean {
  return batch.state === 'issued' && printable(props.lifecycle, batch.roundKind)
}

function closed(batch: BatchSummary): boolean {
  const round = batch.roundKind === 'regular' ? props.lifecycle.regular : props.lifecycle.runoff
  return round === 'closed'
}

/** A link to the batch's page: to print while that is possible, otherwise to see its codes, which a replaced batch keeps for comparing. */
function readable(batch: BatchSummary): boolean {
  if (!mayReadKeys(props.role, props.lifecycle, batch.roundKind)) return false
  return batch.state === 'void' || prints(batch) || closed(batch)
}

async function issue(groupId: string, roundKind: RoundKind): Promise<void> {
  const count = counts[groupId] ?? 0
  busy.value = true
  error.value = null
  done.value = null
  try {
    const issued = await apiPost<{ batch: BatchSummary }>(`/api/elections/${props.electionId}/batches`, { voterGroupId: groupId, roundKind, count })
    done.value = { text: `${count} Stimmkarten (${ROUND_LABELS[roundKind]}) erzeugt.`, batchId: issued.batch.id }
    emit('changed')
  } catch (err) {
    error.value = errorMessage(err)
  } finally {
    busy.value = false
  }
}

async function replace(batch: BatchSummary): Promise<void> {
  busy.value = true
  error.value = null
  done.value = null
  try {
    const replacement = await apiPost<{ batch: BatchSummary }>(`/api/elections/${props.electionId}/batches/${batch.id}/replace`)
    done.value = { text: `Der Stapel wurde ersetzt: ${replacement.batch.keys} neue Stimmkarten. Die alten sind ungültig.`, batchId: replacement.batch.id }
    replacing.value = null
    emit('changed')
  } catch (err) {
    error.value = errorMessage(err)
  } finally {
    busy.value = false
  }
}

function groupName(batch: BatchSummary): string {
  return props.configuration.voterGroups.find((group) => group.id === batch.voterGroupId)?.name ?? ''
}
</script>

<template>
  <section aria-labelledby="sheets-heading">
    <h2 id="sheets-heading">
      Stimmkarten
    </h2>
    <p class="muted">
      Jede Klasse oder Gruppe bekommt ihren eigenen Stapel Stimmkarten, sechs je A4-Seite. Die Druckseite zeigt immer dieselben Codes und kann bis zum Beginn der Runde noch einmal gedruckt werden; danach nicht mehr. Für eine mögliche Stichwahl können Stimmkarten schon vorab erzeugt werden; sie gelten erst, wenn die Stichwahl beginnt.
    </p>
    <p
      v-if="!anyIssue && batches.length === 0"
      class="muted"
    >
      Stimmkarten gibt es, sobald die Wahl vorbereitet ist.
    </p>

    <div
      v-for="group in groups"
      :key="group.id"
      class="card-box"
    >
      <h3>{{ group.name }}</h3>
      <table v-if="group.batches.length > 0">
        <thead>
          <tr>
            <th scope="col">
              Runde
            </th><th scope="col">
              Stimmkarten
            </th><th scope="col">
              Stand
            </th><th scope="col">
              <span class="visually-hidden">Aktionen</span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="batch in group.batches"
            :key="batch.id"
            :data-testid="`batch-${batch.roundKind}-${batch.state}`"
          >
            <td>{{ ROUND_LABELS[batch.roundKind] }}</td>
            <td>{{ batch.keys }}</td>
            <td>{{ BATCH_STATE_LABELS[batch.state] }}</td>
            <td>
              <a
                v-if="readable(batch)"
                :href="printPath(batch)"
                target="_blank"
                rel="noopener"
              >{{ prints(batch) ? 'Drucken' : 'Codes anzeigen' }}</a>
            </td>
          </tr>
        </tbody>
      </table>
      <p
        v-else
        class="muted"
      >
        Noch keine Stimmkarten.
      </p>
      <div
        v-if="anyIssue"
        class="row"
      >
        <div>
          <label :for="`count-${group.id}`">Anzahl Wählende</label>
          <input
            :id="`count-${group.id}`"
            v-model.number="counts[group.id]"
            type="number"
            min="1"
            max="1000"
          >
        </div>
        <button
          v-if="rules.issue.regular"
          type="button"
          :disabled="busy || !((counts[group.id] ?? 0) >= 1)"
          @click="issue(group.id, 'regular')"
        >
          Stimmkarten erzeugen
        </button>
        <button
          v-if="rules.issue.runoff"
          type="button"
          class="secondary"
          :disabled="busy || !((counts[group.id] ?? 0) >= 1)"
          @click="issue(group.id, 'runoff')"
        >
          Stichwahl-Stimmkarten erzeugen
        </button>
      </div>
    </div>

    <output
      v-if="done"
      class="message ok"
    >
      {{ done.text }}
      <a
        :href="`/elections/${electionId}/batches/${done.batchId}/print`"
        target="_blank"
        rel="noopener"
      >Jetzt drucken</a>
    </output>
    <p
      v-if="error"
      class="message error"
      role="alert"
    >
      {{ error }}
    </p>

    <div
      v-if="anyReplace"
      class="card-box"
    >
      <h3>Ausnahmen</h3>
      <p class="muted">
        Sind gedruckte Stimmkarten verloren gegangen oder dürfen sie nicht verwendet werden, wird der ganze Stapel ersetzt: seine Codes werden ungültig, und es werden ebenso viele neue erzeugt, die neu gedruckt werden müssen. Das wird protokolliert.
      </p>
      <ul class="plain">
        <template
          v-for="batch in batches"
          :key="batch.id"
        >
          <li
            v-if="batch.state === 'issued' && rules.replace[batch.roundKind]"
            class="row"
          >
            <span>{{ groupName(batch) }} · {{ ROUND_LABELS[batch.roundKind] }} · {{ batch.keys }} Stimmkarten</span>
            <button
              type="button"
              class="danger"
              :disabled="busy"
              :aria-label="`Stapel ersetzen: ${groupName(batch)}, ${ROUND_LABELS[batch.roundKind]}`"
              @click="replacing = batch"
            >
              Stapel ersetzen
            </button>
          </li>
        </template>
      </ul>
      <div
        v-if="replacing"
        class="card-box"
        role="alertdialog"
        aria-labelledby="replace-heading"
      >
        <h3
          id="replace-heading"
          ref="replaceHeading"
          tabindex="-1"
        >
          Stapel ersetzen?
        </h3>
        <p>Die {{ replacing.keys }} bisherigen Stimmkarten für {{ groupName(replacing) }} ({{ ROUND_LABELS[replacing.roundKind] }}) werden ungültig. Es werden {{ replacing.keys }} neue Codes erzeugt, die neu gedruckt werden müssen.</p>
        <div class="actions">
          <button
            type="button"
            class="danger"
            :disabled="busy"
            @click="replace(replacing)"
          >
            Ja, Stapel ersetzen
          </button>
          <button
            type="button"
            class="secondary"
            :disabled="busy"
            @click="replacing = null"
          >
            Abbrechen
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
</style>
