<script setup lang="ts">
// Stimmkarten: a card per class with its batches of keys, regular and
// runoff, and their counts; issuing, printing, and in a panel of its own
// the exception that makes sheets invalid: replacing a batch. What issuing
// or replacing came to shows in the card of its class. Witnesses see
// counts, and the codes once the batch's round has closed.
//
// A class's further batch of a Wahlgang is a top-up, which asks first, so
// a second click never adds cards unnoticed; the count empties once a
// batch is issued, and a class with cards for the 1. Wahlgang and none for
// the runoff gets that count proposed. Every valid batch of a Wahlgang
// prints in one go (pages/PrintRound.vue).

import { computed, nextTick, reactive, ref, watch } from 'vue'
import LineIcon from './LineIcon.vue'
import { useDialogFocus } from '../lib/dialog-focus.ts'
import type { Lifecycle, RoundKind } from '@school-election/election-core'
import { apiPost } from '../lib/api.ts'
import { withBase } from '../lib/base.ts'
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

const BATCH_STATE_LABELS = { issued: 'gültig', void: 'ungültig' } as const
/** A Wahlgang as an object of "für": "für den 1. Wahlgang". */
const FOR_ROUND: Readonly<Record<RoundKind, string>> = { regular: 'den 1. Wahlgang', runoff: 'die Stichwahl' }
const KINDS: readonly RoundKind[] = ['regular', 'runoff']
/** The most cards a batch holds, as the API takes them. */
const MAX_BATCH = 1000

const busy = ref(false)
/** Why the last change was refused, in the card of its class, or in the exceptions' panel for a replacement. */
const error = ref<{ text: string, groupId: string | null } | null>(null)
/** What the last change came to, in the card of the class it was for, with the batch to print. */
const done = ref<{ text: string, batchId: string, groupId: string } | null>(null)
const replacing = ref<BatchSummary | null>(null)
const replaceHeading = ref<HTMLElement | null>(null)
useDialogFocus(replacing, replaceHeading)
/** The number of voters entered per class. */
const counts = reactive<Record<string, number | undefined>>({})
/** The classes whose count is the one proposed for the runoff, not one typed. */
const proposed = reactive(new Set<string>())
/** A top-up waiting for its yes: the class, the Wahlgang and how many cards; the count's field is read-only meanwhile, so it shows what the question names. */
const topUp = ref<{ groupId: string, kind: RoundKind, count: number } | null>(null)

/** The valid cards of a class in a Wahlgang, all its batches together. */
function validKeys(groupId: string, kind: RoundKind): number {
  return props.batches.filter((batch) => batch.voterGroupId === groupId && batch.roundKind === kind && batch.state === 'issued').reduce((sum, batch) => sum + batch.keys, 0)
}

// A class with cards for the 1. Wahlgang and none for the runoff, while
// runoff cards can be issued, gets the 1. Wahlgang's count in its empty
// field: the runoff's voters are the same.
watch([() => props.batches, () => props.rules.issue.runoff], () => {
  if (!props.rules.issue.runoff) return
  for (const group of props.configuration.voterGroups) {
    const regular = validKeys(group.id, 'regular')
    if (counts[group.id] === undefined && regular > 0 && validKeys(group.id, 'runoff') === 0) {
      counts[group.id] = Math.min(regular, MAX_BATCH)
      proposed.add(group.id)
    }
  }
}, { immediate: true })

/** The totals of the Wahlgänge where a class has more than one valid batch. */
function totals(groupId: string): { kind: RoundKind, keys: number }[] {
  return KINDS
    .filter((kind) => props.batches.filter((batch) => batch.voterGroupId === groupId && batch.roundKind === kind && batch.state === 'issued').length > 1)
    .map((kind) => ({ kind, keys: validKeys(groupId, kind) }))
}

/** The Wahlgänge whose valid batches can be printed now, all at once. */
const printAll = computed(() => KINDS.filter((kind) => printable(props.lifecycle, kind)
  && mayReadKeys(props.role, props.lifecycle, kind)
  && props.batches.some((batch) => batch.roundKind === kind && batch.state === 'issued')))

const groups = computed(() => props.configuration.voterGroups.map((group) => ({
  ...group,
  contests: props.configuration.contests.filter((contest) => group.contestIds.includes(contest.id)).map((contest) => contest.title),
  batches: props.batches.filter((batch) => batch.voterGroupId === group.id),
})))

/** Nothing to show per class yet: a draft without any batch. */
const waiting = computed(() => props.lifecycle.election === 'draft' && props.batches.length === 0)
/** What the step waits for, and the classes that have no cards yet: "1A und 2B". */
const waitingText = computed(() => {
  const names = props.configuration.voterGroups.map((group) => group.name)
  const classes = names.length > 1 ? `${names.slice(0, -1).join(', ')} und ${names.at(-1)}` : (names[0] ?? '')
  const ready = 'Stimmkarten gibt es, sobald der Wahltermin vorbereitet ist.'
  return classes === '' ? ready : `${ready} ${classes}: noch keine Stimmkarten.`
})

const anyIssue = computed(() => props.rules.issue.regular || props.rules.issue.runoff)
const anyReplace = computed(() => props.batches.some((batch) => batch.state === 'issued' && props.rules.replace[batch.roundKind]))

/** The print page's address for a plain link, which opens in a tab of its own: base path included, since the router does not add it here. */
function printPath(batch: BatchSummary): string {
  return withBase(`/elections/${props.electionId}/batches/${batch.id}/print`)
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

/** Issues the cards entered, or asks first where the class has valid cards for that Wahlgang already. */
function request(groupId: string, roundKind: RoundKind): void {
  const count = counts[groupId] ?? 0
  if (validKeys(groupId, roundKind) === 0) {
    void issue(groupId, roundKind, count)
    return
  }
  topUp.value = { groupId, kind: roundKind, count }
  void nextTick(() => document.querySelector<HTMLButtonElement>(`[data-top-up="${groupId}"] .cancel`)?.focus())
}

function cancelTopUp(): void {
  const asked = topUp.value
  topUp.value = null
  if (asked) void nextTick(() => document.querySelector<HTMLButtonElement>(`[data-issue="${asked.groupId}:${asked.kind}"]`)?.focus())
}

async function confirmTopUp(): Promise<void> {
  const asked = topUp.value
  topUp.value = null
  if (asked) await issue(asked.groupId, asked.kind, asked.count)
}

async function issue(groupId: string, roundKind: RoundKind, count: number): Promise<void> {
  busy.value = true
  error.value = null
  done.value = null
  try {
    const issued = await apiPost<{ batch: BatchSummary }>(`/api/elections/${props.electionId}/batches`, { voterGroupId: groupId, roundKind, count })
    done.value = { text: `${count} Stimmkarten (${ROUND_LABELS[roundKind]}) erzeugt.`, batchId: issued.batch.id, groupId }
    counts[groupId] = undefined
    proposed.delete(groupId)
    emit('changed')
  } catch (err) {
    error.value = { text: errorMessage(err), groupId }
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
    done.value = { text: `Der Stapel wurde ersetzt: ${replacement.batch.keys} neue Stimmkarten. Die alten sind ungültig.`, batchId: replacement.batch.id, groupId: batch.voterGroupId }
    replacing.value = null
    emit('changed')
  } catch (err) {
    error.value = { text: errorMessage(err), groupId: null }
  } finally {
    busy.value = false
  }
}

function groupName(batch: BatchSummary): string {
  return props.configuration.voterGroups.find((group) => group.id === batch.voterGroupId)?.name ?? ''
}
</script>

<template>
  <div class="sheets">
    <p
      v-if="waiting"
      class="muted"
    >
      {{ waitingText }}
    </p>

    <template v-else>
      <div
        v-if="printAll.length > 0"
        class="print-all"
      >
        <a
          v-for="kind in printAll"
          :key="kind"
          :href="withBase(`/elections/${electionId}/rounds/${kind}/print`)"
          target="_blank"
          rel="noopener"
          class="button secondary"
        ><LineIcon name="print" />Alle Stapel drucken: {{ ROUND_LABELS[kind] }}</a>
        <span class="muted">Ein Dokument, jede Klasse auf eigenen Blättern.</span>
      </div>
      <article
        v-for="group in groups"
        :key="group.id"
        class="class-card"
        :aria-labelledby="`class-${group.id}`"
      >
        <div class="class-head">
          <h3 :id="`class-${group.id}`">
            {{ group.name }}
          </h3>
          <span
            v-if="group.contests.length > 0"
            class="muted"
          >wählt in {{ group.contests.join(', ') }}</span>
        </div>
        <div
          v-if="group.batches.length > 0"
          class="table-scroll class-table"
        >
          <table>
            <thead>
              <tr>
                <th scope="col">
                  Wahlgang
                </th><th
                  scope="col"
                  class="number"
                >
                  Stimmkarten
                </th><th scope="col">
                  Stand
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="batch in group.batches"
                :key="batch.id"
                :data-testid="`batch-${batch.roundKind}-${batch.state}`"
              >
                <td class="round">
                  {{ ROUND_LABELS[batch.roundKind] }}
                </td>
                <td class="number">
                  <s v-if="batch.state === 'void'">{{ batch.keys }}</s><template v-else>
                    {{ batch.keys }}
                  </template>
                </td>
                <td>
                  <!-- The stack's state, and beside it, at the row's end, what can be done with it. -->
                  <div class="state">
                    <span :class="['badge', batch.state === 'void' ? 'void' : 'info']">{{ BATCH_STATE_LABELS[batch.state] }}</span>
                    <a
                      v-if="readable(batch)"
                      :href="printPath(batch)"
                      target="_blank"
                      rel="noopener"
                      :class="['button', 'small', prints(batch) ? 'secondary' : 'ghost']"
                    ><LineIcon
                      v-if="prints(batch)"
                      name="print"
                    />{{ prints(batch) ? 'Drucken' : 'Codes anzeigen' }}</a>
                  </div>
                </td>
              </tr>
            </tbody>
            <tfoot v-if="totals(group.id).length > 0">
              <tr
                v-for="total in totals(group.id)"
                :key="total.kind"
                class="total"
              >
                <th scope="row">
                  {{ ROUND_LABELS[total.kind] }} gesamt
                </th>
                <td class="number">
                  {{ total.keys }}
                </td>
                <td>
                  <span class="badge info">gültig</span>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
        <p
          v-else
          class="muted empty"
        >
          Noch keine Stimmkarten.
        </p>
        <output
          v-if="done?.groupId === group.id"
          class="notice"
        >
          <LineIcon name="check" />
          <span>{{ done.text }}</span>
          <a
            :href="withBase(`/elections/${electionId}/batches/${done.batchId}/print`)"
            target="_blank"
            rel="noopener"
          >Jetzt drucken</a>
        </output>
        <p
          v-if="error && error.groupId === group.id"
          class="message error in-card"
          role="alert"
        >
          {{ error.text }}
        </p>
        <div
          v-if="anyIssue"
          class="class-foot"
        >
          <div>
            <label :for="`count-${group.id}`">Anzahl Wählende</label>
            <input
              :id="`count-${group.id}`"
              v-model.number="counts[group.id]"
              type="number"
              min="1"
              :max="MAX_BATCH"
              :aria-describedby="proposed.has(group.id) ? `count-hint-${group.id}` : undefined"
              :readonly="topUp?.groupId === group.id"
              @input="proposed.delete(group.id)"
            >
          </div>
          <template v-if="topUp?.groupId !== group.id">
            <button
              v-if="rules.issue.regular"
              type="button"
              :class="{ secondary: validKeys(group.id, 'regular') > 0 }"
              :disabled="busy || !((counts[group.id] ?? 0) >= 1)"
              :data-issue="`${group.id}:regular`"
              @click="request(group.id, 'regular')"
            >
              {{ validKeys(group.id, 'regular') > 0 ? 'Weitere Stimmkarten (zusätzlicher Stapel)' : 'Stimmkarten erzeugen' }}
            </button>
            <button
              v-if="rules.issue.runoff"
              type="button"
              class="secondary"
              :disabled="busy || !((counts[group.id] ?? 0) >= 1)"
              :data-issue="`${group.id}:runoff`"
              @click="request(group.id, 'runoff')"
            >
              {{ validKeys(group.id, 'runoff') > 0 ? 'Weitere Stichwahl-Stimmkarten (zusätzlicher Stapel)' : 'Stichwahl-Stimmkarten erzeugen' }}
            </button>
          </template>
          <p
            v-if="proposed.has(group.id)"
            :id="`count-hint-${group.id}`"
            class="count-hint"
          >
            Für die Stichwahl vorgeschlagen: so viele wie im 1. Wahlgang.
          </p>
          <fieldset
            v-if="topUp?.groupId === group.id"
            class="confirm top-up"
            :aria-label="`Zusätzlichen Stapel bestätigen: ${group.name}`"
            :data-top-up="group.id"
          >
            <span>{{ group.name }} hat schon {{ validKeys(group.id, topUp.kind) }} gültige Stimmkarten für {{ FOR_ROUND[topUp.kind] }}. Einen zusätzlichen Stapel mit {{ topUp.count }} Stimmkarten erzeugen?</span>
            <button
              type="button"
              :disabled="busy"
              @click="confirmTopUp"
            >
              Ja, zusätzlichen Stapel erzeugen
            </button>
            <button
              type="button"
              class="secondary cancel"
              @click="cancelTopUp"
            >
              Abbrechen
            </button>
          </fieldset>
        </div>
      </article>
    </template>

    <div
      v-if="anyReplace"
      class="exceptions"
    >
      <div class="exceptions-head">
        <h3><LineIcon name="alert" />Ausnahmen</h3>
        <p>
          Sind gedruckte Stimmkarten verloren gegangen oder dürfen sie nicht verwendet werden, wird der ganze Stapel ersetzt: seine Codes werden ungültig, und es werden ebenso viele neue erzeugt, die neu gedruckt werden müssen. Das wird protokolliert.
        </p>
      </div>
      <ul class="exceptions-list">
        <template
          v-for="batch in batches"
          :key="batch.id"
        >
          <li v-if="batch.state === 'issued' && rules.replace[batch.roundKind]">
            <span><strong>{{ groupName(batch) }}</strong> · {{ ROUND_LABELS[batch.roundKind] }} · {{ batch.keys }} Stimmkarten</span>
            <button
              type="button"
              class="danger small"
              :disabled="busy"
              :aria-label="`Stapel ersetzen: ${groupName(batch)}, ${ROUND_LABELS[batch.roundKind]}`"
              @click="replacing = batch"
            >
              <LineIcon name="refresh" />Stapel ersetzen
            </button>
          </li>
        </template>
      </ul>
      <div
        v-if="replacing"
        class="card-box dialog"
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
      <p
        v-if="error && error.groupId === null"
        class="message error in-card"
        role="alert"
      >
        {{ error.text }}
      </p>
    </div>
  </div>
</template>

<style scoped>
.sheets {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.sheets > p {
  margin: 0;
}

.class-card {
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--paper);
}

.class-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 12px;
  padding: 14px 16px;
}

.class-head h3 {
  margin: 0;
  font-size: 1.05rem;
}

.class-head .muted {
  font-size: 0.8rem;
}

.class-table {
  border-top: 1px solid var(--line);
}

.class-table table {
  margin: 0;
}

.class-table tbody tr:last-child > * {
  border-bottom: 0;
}

.round {
  font-weight: 600;
}

.number {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.state {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 6px 12px;
}

.empty {
  margin: 0;
  padding: 0 16px 14px;
}

.notice {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin: 0 16px 14px;
  padding: 12px 14px;
  border-radius: 10px;
  background: var(--ok-bg);
  color: var(--ok);
  font-size: 0.85rem;
}

.notice > span {
  flex: 1 1 200px;
}

.notice a {
  color: var(--ok);
  font-weight: 600;
}

.in-card {
  margin: 0 16px 14px;
}

.class-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 10px;
  padding: 14px 16px;
  border-top: 1px solid var(--line);
  border-radius: 0 0 12px 12px;
  background: var(--soft);
}

.class-foot input {
  width: 140px;
}

.count-hint {
  flex-basis: 100%;
  margin: 0;
  color: var(--muted);
  font-size: 0.8rem;
}

.top-up {
  flex-basis: 100%;
  margin: 0;
}

/* A total row: the class's valid cards of a Wahlgang, all batches together. */
.total th {
  background: none;
  color: var(--ink);
  font-size: 0.85rem;
  letter-spacing: 0;
  text-transform: none;
}

.total > * {
  border-top: 1px solid var(--line);
  border-bottom: 0;
}

.print-all {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}

.print-all .muted {
  font-size: 0.85rem;
}

.exceptions {
  border: 1px solid var(--danger-line);
  border-radius: 12px;
}

.exceptions-head {
  padding: 14px 16px;
  border-bottom: 1px solid var(--danger-line);
  border-radius: 12px 12px 0 0;
  background: var(--danger-soft);
}

.exceptions-head h3 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  color: var(--danger);
  font-size: 1rem;
}

.exceptions-head p {
  max-width: 72ch;
  margin: 6px 0 0;
  color: var(--ink2);
  font-size: 0.85rem;
}

.exceptions-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.exceptions-list > li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 12px;
  padding: 10px 16px;
  font-size: 0.9rem;
}

.exceptions-list > li + li {
  border-top: 1px solid var(--line);
}

.dialog {
  margin: 0 16px 16px;
}
</style>
