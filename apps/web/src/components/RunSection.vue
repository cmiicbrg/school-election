<script setup lang="ts">
// Ablauf: the election day on one section. What is now, the turnout
// while a round accepts ballots (read again every five seconds, counts
// only, never a total), the result in words once the regular round has
// closed, the lots the officials drew, and the steps in their order:
// Probelauf, 1. Wahlgang öffnen, beenden und auszählen, Stichwahl
// aktivieren, beenden und auszählen, Ergebnis feststellen, Export. A step
// that makes cards final (opening, activating the runoff) lists every
// class with its valid cards, and one without needs a second, explicit
// confirmation: it could not vote in that Wahlgang. Every control comes from the caller's permissions
// and election-core's guards (lib/run-rules.ts), so a witness sees the
// same section without one; every step that cannot be undone asks first
// and says what it does. While the election can change, the section asks
// every five seconds whether it has, the result included, so a witness's
// page follows the teacher's steps and the lots recorded without a reload.

import { computed, nextTick, onUnmounted, ref, useId, watch } from 'vue'
import { RouterLink } from 'vue-router'
import type { LotRequest, Outcome, RoundKind, RulesetId } from '@school-election/election-core'
import LotForm from './LotForm.vue'
import { apiDownload, apiGet, apiPost } from '../lib/api.ts'
import { BASE_URL, withBase } from '../lib/base.ts'
import { errorMessage } from '../lib/api-rules.ts'
import { useDialogFocus } from '../lib/dialog-focus.ts'
import { fileNameOf } from '../lib/download.ts'
import { ROUND_LABELS } from '../lib/labels.ts'
import { countsLine, dateTime, firstPlacesLine, listed, lotText, outcomeLine, positionLines, recordedLotLine, type Names } from '../lib/outcome-text.ts'
import { notify } from '../lib/toast.ts'
import { accepting, runoffState, runRules } from '../lib/run-rules.ts'
import { voterAddress } from '../lib/sheet.ts'
import type { BatchSummary, Configuration, ContestResult, ElectionDetail, ElectionFinalized, ElectionResult, RoundResults, RunoffActivated, TestEnded, Turnout } from '../lib/types.ts'

const props = defineProps<{
  election: ElectionDetail
  configuration: Configuration
  batches: BatchSummary[]
}>()

const emit = defineEmits<{ changed: [] }>()

const EVERY_MS = 5000

const ids = { confirm: useId(), finalize: useId(), reason: useId() }
const rules = computed(() => runRules(props.election.lifecycle, props.election.permissions))
const base = computed(() => `/api/elections/${props.election.id}`)

/** The turnout shown, with the round it is of: figures of one round never show under another's label. */
const turnout = ref<(Turnout & { kind: RoundKind }) | null>(null)
const result = ref<ElectionResult | null>(null)
const testResult = ref<RoundResults | null>(null)
const busy = ref(false)
const error = ref<string | null>(null)
const notice = ref<string | null>(null)
const confirming = ref<'open' | 'close-regular' | 'close-runoff' | 'activate' | null>(null)
const finalizing = ref(false)
const reason = ref('')
const exported = ref<{ name: string, sha256: string } | null>(null)

const confirmHeading = ref<HTMLElement | null>(null)
const finalizeHeading = ref<HTMLElement | null>(null)
useDialogFocus(confirming, confirmHeading)
useDialogFocus(finalizing, finalizeHeading)

const names = computed<Names>(() => {
  const byId = new Map(props.configuration.contests.flatMap((contest) => contest.candidates.map((candidate) => [candidate.id, `${candidate.givenName} ${candidate.surname}`])))
  return { candidate: (id) => byId.get(id) ?? id }
})
const contestTitle = (id: string): string => props.configuration.contests.find((contest) => contest.id === id)?.title ?? ''
const rulesetOf = (id: string): RulesetId => props.configuration.contests.find((contest) => contest.id === id)?.rulesetId ?? 'single-choice-v1'
const address = computed(() => voterAddress(BASE_URL))

const stateLine = computed(() => {
  const { lifecycle } = props.election
  const done = result.value?.finalized
  if (lifecycle.election === 'final') return done ? `Ergebnis festgestellt am ${dateTime(done.at)} durch ${done.actorName}: ${done.reason}` : 'Ergebnis festgestellt.'
  if (lifecycle.election === 'draft') return 'Der Wahltermin ist noch im Entwurf: zuerst vorbereiten.'
  if (lifecycle.regular === 'testing') return 'Der Probelauf läuft: Stimmen zählen nicht, und nichts bleibt.'
  if (lifecycle.regular === 'planned') return 'Vorbereitet. Sobald die Stimmkarten gedruckt sind, kann der 1. Wahlgang geöffnet werden.'
  if (lifecycle.regular === 'open') return 'Der 1. Wahlgang läuft.'
  if (lifecycle.runoff === 'open') return 'Die Stichwahl läuft.'
  return lifecycle.runoff === 'closed' ? 'Die Stichwahl ist beendet und ausgezählt.' : 'Der 1. Wahlgang ist beendet und ausgezählt.'
})

// The turnout is read once at a time, and its generation changes only
// with the election's state, never with a tick: a slow answer is still
// applied (the next tick corrects it within five seconds), a tick while
// one is on its way is skipped rather than piled up, and an answer from
// before a change of state is dropped. The result is numbered per read,
// so two lots recorded close together never bring back the older answer.
let turnoutGeneration = 0
let turnoutPending = false
let statePending = false
let resultReads = 0
let testReads = 0

async function readTurnout(kind: RoundKind): Promise<void> {
  if (turnoutPending) return
  const generation = turnoutGeneration
  turnoutPending = true
  try {
    const answer = await apiGet<Turnout>(`${base.value}/rounds/${kind}/turnout`)
    if (generation === turnoutGeneration) turnout.value = { ...answer, kind }
  } catch {
    // The last figures stay; the next read tries again.
  } finally {
    if (generation === turnoutGeneration) turnoutPending = false
  }
}

/** Whether the election has moved on since the page read it: then the page reads it again. */
async function followState(): Promise<void> {
  if (statePending) return
  statePending = true
  try {
    const detail = await apiGet<ElectionDetail>(base.value)
    if (JSON.stringify(detail.lifecycle) !== JSON.stringify(props.election.lifecycle)) emit('changed')
  } catch {
    // The next tick asks again.
  } finally {
    statePending = false
  }
}

/** The result as it stands; a read of the tick's own is quiet about a failure, the next tick reads again. */
async function readResult(quiet = false): Promise<void> {
  const current = ++resultReads
  try {
    const answer = await apiGet<ElectionResult>(`${base.value}/result`)
    if (current === resultReads) result.value = answer
  } catch (err) {
    if (current === resultReads && !quiet) error.value = errorMessage(err)
  }
}

async function readTestResult(): Promise<void> {
  const current = ++testReads
  try {
    const answer = await apiGet<RoundResults>(`${base.value}/rounds/regular/test-result`)
    if (current === testReads) testResult.value = answer
  } catch (err) {
    if (current === testReads) error.value = errorMessage(err)
  }
}

let timer: ReturnType<typeof setInterval> | undefined

function stopPolling(): void {
  if (timer !== undefined) clearInterval(timer)
  timer = undefined
}

function refresh(): void {
  const { lifecycle } = props.election
  const kind = rules.value.turnoutOf
  stopPolling()
  turnoutGeneration += 1
  turnoutPending = false
  if (turnout.value?.kind !== kind) turnout.value = null
  if (kind !== null) void readTurnout(kind)
  const live = kind !== null && accepting(lifecycle)
  const moving = lifecycle.election === 'prepared' || lifecycle.election === 'active'
  const follows = moving && rules.value.showResult
  if (live || moving) {
    timer = setInterval(() => {
      if (live) void readTurnout(kind)
      if (moving) void followState()
      if (follows) void readResult(true)
    }, EVERY_MS)
  }
  if (rules.value.showResult) void readResult()
  else result.value = null
  if (!rules.value.showTestResult) testResult.value = null
}

watch(() => props.election.lifecycle, refresh, { immediate: true, deep: true })
onUnmounted(stopPolling)

/** One step: the request, what to say afterwards, and the page told to read the election again. */
async function act<T>(request: () => Promise<T>, then?: (answer: T) => void): Promise<void> {
  busy.value = true
  error.value = null
  notice.value = null
  try {
    const answer = await request()
    then?.(answer)
    emit('changed')
  } catch (err) {
    error.value = errorMessage(err)
  } finally {
    busy.value = false
  }
}

const count = (n: number, one: string, many: string): string => (n === 1 ? `1 ${one}` : `${n} ${many}`)

const startTest = () => act(() => apiPost(`${base.value}/rounds/regular/test`), () => {
  notice.value = 'Probelauf gestartet: Stimmen zählen nicht, und nichts bleibt.'
})
const endTest = () => act(() => apiPost<TestEnded>(`${base.value}/rounds/regular/test/end`), (ended) => {
  notice.value = `Probelauf beendet: ${count(ended.ballots, 'Stimmzettel', 'Stimmzettel')} entfernt, ${count(ended.keys, 'Code', 'Codes')} wieder frei.`
  testResult.value = null
})
const open = () => act(() => apiPost(`${base.value}/rounds/regular/open`), () => {
  notice.value = 'Der 1. Wahlgang ist geöffnet.'
})
const close = (kind: RoundKind) => act(() => apiPost<{ ballots: number }>(`${base.value}/rounds/${kind}/close`), (closed) => {
  notice.value = `${ROUND_LABELS[kind]} beendet: ${count(closed.ballots, 'Stimmzettel', 'Stimmzettel')} versiegelt und ausgezählt.`
})
const activate = () => act(() => apiPost<RunoffActivated>(`${base.value}/rounds/runoff/activate`), (activated) => {
  notice.value = `Die Stichwahl läuft: ${count(activated.keys, 'Stichwahl-Stimmkarte gilt', 'Stichwahl-Stimmkarten gelten')} jetzt.`
})

interface Dialog {
  title: string
  text: string
  /** What the step affects, line by line: each class with its cards, or the cards left unused. */
  lines: { text: string, missing: boolean }[]
  /** What is missing that the step makes final: the step then waits for this to be ticked. */
  override: string | null
  yes: string
  run: () => Promise<void>
}

/** Ticked in the dialog: the step goes ahead although a class has no cards. */
const overridden = ref(false)
watch(confirming, () => {
  overridden.value = false
})

/** Each class of `groups` with its valid cards of the round, and the ones without. */
function cardLines(groups: { name: string, keys: number }[], round: string): { lines: Dialog['lines'], missing: string[] } {
  return {
    lines: groups.map((group) => ({ text: group.keys > 0 ? `${group.name}: ${group.keys} Stimmkarten` : `${group.name}: keine gültigen Stimmkarten für ${round}`, missing: group.keys === 0 })),
    missing: groups.filter((group) => group.keys === 0).map((group) => group.name),
  }
}

const regularCards = computed(() => cardLines(props.configuration.voterGroups.map((group) => ({
  name: group.name,
  keys: props.batches.filter((batch) => batch.voterGroupId === group.id && batch.roundKind === 'regular' && batch.state === 'issued').reduce((sum, batch) => sum + batch.keys, 0),
})), 'den 1. Wahlgang'))

/** What closing leaves unused, from the turnout of the round that closes. */
function unusedLine(kind: RoundKind): Dialog['lines'] {
  const figures = turnout.value
  if (figures?.kind !== kind) return []
  const unused = figures.keys.issued - figures.keys.used
  return [{ text: `${unused} von ${figures.keys.issued} Stimmkarten wurden nicht verwendet.`, missing: false }]
}

const can = (names: string[]): string => (names.length === 1 ? 'kann' : 'können')

const dialog = computed<Dialog | null>(() => {
  switch (confirming.value) {
    case 'open': {
      const { lines, missing } = regularCards.value
      return {
        title: '1. Wahlgang öffnen?',
        text: 'Ab jetzt können Stimmen abgegeben werden. Kandidat:innen und die Stimmkarten des 1. Wahlgangs ändern sich nicht mehr, und für den 1. Wahlgang können keine Stimmkarten mehr erzeugt oder gedruckt werden. Ein laufender Probelauf wird beendet.',
        lines,
        override: missing.length > 0 ? `Trotzdem öffnen: ${listed(missing)} ${can(missing)} im 1. Wahlgang nicht wählen.` : null,
        yes: 'Ja, 1. Wahlgang öffnen',
        run: open,
      }
    }
    case 'close-regular':
      return { title: '1. Wahlgang beenden und auszählen?', text: 'Danach nimmt der 1. Wahlgang keine Stimmen mehr an; wer gerade abgibt, bekommt eine Absage. Die Stimmzettel werden versiegelt und ausgezählt. Ein beendeter Wahlgang öffnet nicht wieder.', lines: unusedLine('regular'), override: null, yes: 'Ja, beenden und auszählen', run: () => close('regular') }
    case 'close-runoff':
      return { title: 'Stichwahl beenden und auszählen?', text: 'Danach nimmt die Stichwahl keine Stimmen mehr an; wer gerade abgibt, bekommt eine Absage. Die Stimmzettel werden versiegelt und ausgezählt. Eine beendete Stichwahl öffnet nicht wieder.', lines: unusedLine('runoff'), override: null, yes: 'Ja, beenden und auszählen', run: () => close('runoff') }
    case 'activate': {
      const { lines, missing } = cardLines(runoffSheets.value.map((entry) => ({ name: entry.group.name, keys: entry.keys })), 'die Stichwahl')
      return {
        title: 'Stichwahl aktivieren?',
        text: 'Die Stichwahl beginnt sofort, mit den Stichwahl-Stimmkarten. Die Stimmkarten des 1. Wahlgangs gelten nicht mehr, und Stichwahl-Stimmkarten können danach nicht mehr erzeugt oder gedruckt werden.',
        lines,
        override: missing.length > 0 ? `Trotzdem aktivieren: ${listed(missing)} ${can(missing)} in der Stichwahl nicht wählen.` : null,
        yes: 'Ja, Stichwahl aktivieren',
        run: activate,
      }
    }
    case null:
      return null
  }
})

/** What an undecided contest stays when the result is established now. */
const UNDECIDED: Readonly<Record<Exclude<Outcome['kind'], 'final'>, string>> = {
  'lot-required': 'der Losentscheid fehlt',
  'runoff-required': 'die Stichwahl fehlt',
  'tie': 'unentschieden; die Wahlkommission entscheidet',
  'committee-decision': 'die Wahlkommission entscheidet',
}
const undecided = computed(() => (result.value?.contests ?? [])
  .filter((contest) => contest.outcome.kind !== 'final')
  .map((contest) => `${contestTitle(contest.contestId)}: ${contest.outcome.kind === 'final' ? '' : UNDECIDED[contest.outcome.kind]}`))

// The step buttons are hidden while their dialog is open, so the focus goes
// back to the one that comes back when the dialog is cancelled.
async function refocusStep(step: string): Promise<void> {
  await nextTick()
  document.querySelector<HTMLElement>(`[data-step="${step}"]`)?.focus()
}
watch(confirming, (now, before) => {
  if (now === null && before !== null) void refocusStep(before)
})
watch(finalizing, (now, before) => {
  if (!now && before) void refocusStep('finalize')
})

async function confirm(): Promise<void> {
  const run = dialog.value?.run
  confirming.value = null
  if (run) await run()
}

async function finalize(): Promise<void> {
  await act(() => apiPost<ElectionFinalized>(`${base.value}/finalize`, { reason: reason.value.trim() }), (done) => {
    finalizing.value = false
    reason.value = ''
    notice.value = done.batchesVoided > 0 ? 'Das Ergebnis ist festgestellt. Nicht verwendete Stichwahl-Stimmkarten sind ungültig.' : 'Das Ergebnis ist festgestellt.'
  })
}

/** A lot recorded: confirmed, and the result read again, which now applies it. */
function lotRecorded(contestId: string): void {
  notify(`Losentscheid für „${contestTitle(contestId)}“ eingetragen.`)
  void readResult()
}

/** The export as a file for the person, from the answer's body, and its digest shown. */
async function download(): Promise<void> {
  busy.value = true
  error.value = null
  try {
    const { blob, headers } = await apiDownload(`${base.value}/export`)
    const name = fileNameOf(headers.get('content-disposition')) ?? `wahl-${props.election.id}.json`
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = name
    document.body.append(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    exported.value = { name, sha256: headers.get('x-export-sha256') ?? '' }
    notify(`Export gespeichert: ${name}.`)
  } catch (err) {
    error.value = errorMessage(err)
  } finally {
    busy.value = false
  }
}

/** The pairs the first round gave, by contest, and the contests whose runoff entry still waits for a lot. */
const runoff = computed(() => runoffState(result.value?.contests ?? []))
const runoffPairs = computed(() => runoff.value.pairs)

/** The classes or groups that vote in a contest of the runoff, each with its issued runoff batches (a top-up is a batch of its own), if any. */
const runoffSheets = computed(() => props.configuration.voterGroups
  .filter((group) => runoffPairs.value.some((entry) => group.contestIds.includes(entry.contestId)))
  .map((group) => {
    const batches = props.batches.filter((batch) => batch.voterGroupId === group.id && batch.roundKind === 'runoff' && batch.state === 'issued')
    return { group, batches, keys: batches.reduce((sum, batch) => sum + batch.keys, 0) }
  }))

function lotsOf(contest: ContestResult): LotRequest[] {
  return contest.outcome.kind === 'lot-required' ? [...contest.outcome.lots] : []
}

/** A plain link to the print page, base path included: the router does not add it here. */
const printPath = (batch: BatchSummary): string => withBase(`/elections/${props.election.id}/batches/${batch.id}/print`)
</script>

<template>
  <section aria-labelledby="run-heading">
    <h2 id="run-heading">
      Ablauf
    </h2>
    <p
      v-if="election.lifecycle.election !== 'final'"
      class="muted"
    >
      Stimmabgabe unter <strong>{{ address }}</strong>; die Stimmkarten tragen diese Adresse als QR-Code.
    </p>
    <p data-testid="state">
      <strong>{{ stateLine }}</strong>
    </p>

    <div
      v-if="turnout && turnout.kind === rules.turnoutOf"
      data-testid="turnout"
    >
      <p>
        {{ ROUND_LABELS[turnout.kind] }}: <strong>{{ turnout.keys.used }} von {{ turnout.keys.issued }} Stimmkarten verwendet</strong>
      </p>
      <ul
        class="plain"
        aria-label="Beteiligung je Wahl"
      >
        <li
          v-for="entry in turnout.contests"
          :key="entry.contestId"
        >
          {{ contestTitle(entry.contestId) }}: {{ entry.used }} von {{ entry.issued }}
        </li>
      </ul>
    </div>

    <template v-if="rules.showTestResult">
      <div class="actions">
        <button
          type="button"
          class="secondary"
          :disabled="busy"
          @click="readTestResult"
        >
          Zwischenstand
        </button>
      </div>
      <ul
        v-if="testResult"
        class="plain"
        aria-label="Zwischenstand"
      >
        <li
          v-for="snapshot in testResult.contests"
          :key="snapshot.contestId"
        >
          {{ contestTitle(snapshot.contestId) }}: {{ countsLine(snapshot.result.statistics) }} {{ firstPlacesLine(rulesetOf(snapshot.contestId), snapshot.result.statistics, names) }}
        </li>
      </ul>
    </template>

    <template v-if="result && rules.showResult">
      <h3>Ergebnis</h3>
      <p class="muted">
        In Worten; die Zahlen und jeden Schritt zeigt die Seite
        <RouterLink :to="`/wahlen/${election.id}/ergebnis`">
          Ergebnis und Herleitung
        </RouterLink>.
      </p>
      <article
        v-for="contest in result.contests"
        :key="contest.contestId"
        :aria-labelledby="`result-${contest.contestId}`"
        class="card-box"
      >
        <h4 :id="`result-${contest.contestId}`">
          {{ contestTitle(contest.contestId) }}
        </h4>
        <p class="muted">
          1. Wahlgang: {{ countsLine(contest.first.result.statistics) }} {{ firstPlacesLine(rulesetOf(contest.contestId), contest.first.result.statistics, names) }}
        </p>
        <p
          v-if="contest.runoff"
          class="muted"
        >
          Stichwahl: {{ countsLine(contest.runoff.result.statistics) }} {{ firstPlacesLine('single-choice-v1', contest.runoff.result.statistics, names) }}
        </p>
        <p>
          <strong>{{ outcomeLine(contest.outcome, names) }}</strong>
        </p>
        <ul
          v-if="positionLines(rulesetOf(contest.contestId), contest.outcome, names).length > 0"
          class="plain"
          :aria-label="`Positionen: ${contestTitle(contest.contestId)}`"
        >
          <li
            v-for="line in positionLines(rulesetOf(contest.contestId), contest.outcome, names)"
            :key="line"
          >
            {{ line }}
          </li>
        </ul>
        <div
          v-for="lot in lotsOf(contest)"
          :key="lot.id"
          class="card-box"
          :data-testid="`lot-${lot.id}`"
        >
          <h5>Losentscheid</h5>
          <p>{{ lotText(rulesetOf(contest.contestId), lot, names) }}</p>
          <LotForm
            v-if="rules.recordLot"
            :election-id="election.id"
            :contest-id="contest.contestId"
            :contest-title="contestTitle(contest.contestId)"
            :ruleset-id="rulesetOf(contest.contestId)"
            :lot="lot"
            :names="names"
            @recorded="lotRecorded(contest.contestId)"
          />
        </div>
        <ul
          v-if="contest.lots.length > 0"
          class="plain"
          :aria-label="`Losentscheide: ${contestTitle(contest.contestId)}`"
        >
          <li
            v-for="lot in contest.lots"
            :key="lot.id"
          >
            {{ recordedLotLine(lot.drawn, lot.actorName, lot.recordedAt, lot.reason, names) }}
          </li>
        </ul>
      </article>
    </template>

    <div
      v-if="rules.activateRunoff && runoffPairs.length > 0"
      class="card-box"
    >
      <h3>Stichwahl</h3>
      <p>
        <template
          v-for="entry in runoffPairs"
          :key="entry.contestId"
        >
          {{ contestTitle(entry.contestId) }}: {{ names.candidate(entry.pair[0]) }} gegen {{ names.candidate(entry.pair[1]) }}.
        </template>
      </p>
      <ul
        class="plain"
        aria-label="Stichwahl-Stimmkarten"
      >
        <li
          v-for="{ group, batches: issued, keys } in runoffSheets"
          :key="group.id"
        >
          <template v-if="issued.length > 0">
            {{ group.name }}: {{ keys }} Stichwahl-Stimmkarten
            <a
              v-for="batch in issued"
              :key="batch.id"
              :href="printPath(batch)"
              target="_blank"
              rel="noopener"
            >Drucken ({{ batch.keys }})</a>
          </template>
          <span
            v-else
            class="message warning"
          >Für {{ group.name }} gibt es noch keine Stichwahl-Stimmkarten: zuerst unter Stimmkarten erzeugen und drucken.</span>
        </li>
      </ul>
      <p
        v-if="runoff.waiting.length > 0"
        class="message warning"
      >
        Zuerst den Losentscheid eintragen: {{ runoff.waiting.map(contestTitle).join(', ') }}.
      </p>
      <div
        v-else
        class="actions"
      >
        <button
          v-if="confirming === null && !finalizing"
          type="button"
          :disabled="busy"
          data-step="activate"
          @click="confirming = 'activate'"
        >
          Stichwahl aktivieren
        </button>
      </div>
    </div>

    <output
      v-if="notice"
      class="message ok"
    >
      {{ notice }}
    </output>
    <p
      v-if="error"
      class="message error"
      role="alert"
    >
      {{ error }}
    </p>

    <div
      v-if="dialog"
      class="card-box"
      role="alertdialog"
      :aria-labelledby="ids.confirm"
    >
      <h3
        :id="ids.confirm"
        ref="confirmHeading"
        tabindex="-1"
      >
        {{ dialog.title }}
      </h3>
      <p>{{ dialog.text }}</p>
      <ul
        v-if="dialog.lines.length > 0"
        class="plain dialog-lines"
        :aria-label="`${dialog.title} – Stimmkarten`"
      >
        <li
          v-for="line in dialog.lines"
          :key="line.text"
          :class="{ missing: line.missing }"
        >
          {{ line.text }}
        </li>
      </ul>
      <label
        v-if="dialog.override"
        class="check override"
      >
        <input
          v-model="overridden"
          type="checkbox"
        >
        {{ dialog.override }}
      </label>
      <div class="actions">
        <button
          type="button"
          :class="confirming === 'open' || confirming === 'activate' ? '' : 'danger'"
          :disabled="busy || (dialog.override !== null && !overridden)"
          @click="confirm"
        >
          {{ dialog.yes }}
        </button>
        <button
          type="button"
          class="secondary"
          :disabled="busy"
          @click="confirming = null"
        >
          Abbrechen
        </button>
      </div>
    </div>

    <div
      v-if="finalizing"
      class="card-box"
      role="alertdialog"
      :aria-labelledby="ids.finalize"
    >
      <h3
        :id="ids.finalize"
        ref="finalizeHeading"
        tabindex="-1"
      >
        Ergebnis endgültig feststellen?
      </h3>
      <p>Der Wahltermin wird abgeschlossen: nichts ändert sich mehr, auch kein Losentscheid. Nicht verwendete Stichwahl-Stimmkarten werden ungültig. Die Datenbank wird bereinigt, was einige Sekunden dauert.</p>
      <template v-if="undecided.length > 0">
        <p class="message warning">
          Noch nicht entschieden; so festgestellt, bleibt es dabei:
        </p>
        <ul
          class="plain dialog-lines"
          aria-label="Noch nicht entschieden"
        >
          <li
            v-for="line in undecided"
            :key="line"
            class="missing"
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
          :disabled="busy || reason.trim() === ''"
          @click="finalize"
        >
          Ja, Ergebnis feststellen
        </button>
        <button
          type="button"
          class="secondary"
          :disabled="busy"
          @click="finalizing = false"
        >
          Abbrechen
        </button>
      </div>
    </div>

    <div
      v-if="confirming === null && !finalizing"
      class="actions"
    >
      <button
        v-if="rules.startTest"
        type="button"
        class="secondary"
        :disabled="busy"
        @click="startTest"
      >
        Probelauf starten
      </button>
      <button
        v-if="rules.endTest"
        type="button"
        class="secondary"
        :disabled="busy"
        @click="endTest"
      >
        Probelauf beenden
      </button>
      <button
        v-if="rules.open"
        type="button"
        :disabled="busy"
        data-step="open"
        @click="confirming = 'open'"
      >
        1. Wahlgang öffnen
      </button>
      <button
        v-if="rules.closeRegular"
        type="button"
        class="danger"
        :disabled="busy"
        data-step="close-regular"
        @click="confirming = 'close-regular'"
      >
        1. Wahlgang beenden und auszählen
      </button>
      <button
        v-if="rules.closeRunoff"
        type="button"
        class="danger"
        :disabled="busy"
        data-step="close-runoff"
        @click="confirming = 'close-runoff'"
      >
        Stichwahl beenden und auszählen
      </button>
      <button
        v-if="rules.finalize"
        type="button"
        :disabled="busy"
        :class="undecided.length > 0 ? 'secondary' : ''"
        data-step="finalize"
        @click="finalizing = true"
      >
        Ergebnis endgültig feststellen
      </button>
      <button
        v-if="rules.exportFile"
        type="button"
        class="secondary"
        :disabled="busy"
        @click="download"
      >
        Export herunterladen
      </button>
    </div>
    <p
      v-if="exported"
      class="muted"
      data-testid="exported"
    >
      Export gespeichert als {{ exported.name }}. SHA-256: <code>{{ exported.sha256 }}</code>. Jeder Export enthält das Protokoll bis zu diesem Zeitpunkt und hat deshalb seine eigene Prüfsumme; sie steht auch im Protokoll.
    </p>
  </section>
</template>

<style scoped>
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

h4 {
  font-size: 1rem;
  margin: 0 0 6px;
}

h5 {
  font-size: 0.95rem;
  margin: 0 0 6px;
}

code {
  word-break: break-all;
}
</style>
