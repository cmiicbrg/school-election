// The election day's state, shared by its cards: the Probelauf, the
// Wahltag, the result and "Ergebnis feststellen" (components/ElectionDay.vue).
// What is now, the turnout while a round accepts ballots (read again every
// five seconds, counts only, never a total), the result once the regular
// round has closed, the rehearsal's count, and the steps: Probelauf, 1.
// Wahlgang öffnen, beenden und auszählen, Stichwahl aktivieren, beenden und
// auszählen, Ergebnis feststellen, Export. A step that makes cards final
// (opening, activating the runoff) lists every class with its valid cards,
// and one without needs a second, explicit confirmation: it could not vote
// in that Wahlgang. Every control comes from the caller's permissions and
// election-core's guards (lib/run-rules.ts), so a witness sees the same
// cards without one; every step that cannot be undone asks first and says
// what it does. While the election can change, the state asks every five
// seconds whether it has, the result included, so a witness's page follows
// the teacher's steps and the lots recorded without a reload. What a step
// came to, and why one was refused, shows in the card of that step.

import { computed, nextTick, onScopeDispose, ref, watch, type UnwrapNestedRefs } from 'vue'
import type { LotRequest, Outcome, RoundKind, RulesetId } from '@school-election/election-core'
import { apiDownload, apiGet, apiPost } from './api.ts'
import { errorMessage } from './api-rules.ts'
import { withBase } from './base.ts'
import { fileNameOf } from './download.ts'
import { ROUND_LABELS } from './labels.ts'
import { dateTime, listed, type Names } from './outcome-text.ts'
import { notify } from './toast.ts'
import { accepting, runoffState, runRules } from './run-rules.ts'
import type { BatchSummary, Configuration, ContestResult, ElectionDetail, ElectionFinalized, ElectionResult, RoundResults, RunoffActivated, TestEnded, Turnout } from './types.ts'

const EVERY_MS = 5000

/** The card a message belongs to. */
export type DayCard = 'probelauf' | 'wahltag' | 'ergebnis' | 'feststellen'
/** The steps that ask first in the Wahltag's card. */
export type DayStep = 'open' | 'close-regular' | 'close-runoff' | 'activate'

export interface DayMessage {
  text: string
  card: DayCard
}

export interface DayDialog {
  title: string
  text: string
  /** What the step affects, line by line: each class with its cards, or the cards left unused. */
  lines: { text: string, missing: boolean }[]
  /** What is missing that the step makes final: the step then waits for this to be ticked. */
  override: string | null
  yes: string
  /** A step that cannot be undone and shuts something out is red. */
  danger: boolean
}

export interface DaySource {
  election: ElectionDetail
  configuration: Configuration
  batches: BatchSummary[]
}

/** What an undecided contest stays when the result is established now. */
const UNDECIDED: Readonly<Record<Exclude<Outcome['kind'], 'final'>, string>> = {
  'lot-required': 'der Losentscheid fehlt',
  'runoff-required': 'die Stichwahl fehlt',
  'tie': 'unentschieden; die Wahlkommission entscheidet',
  'committee-decision': 'die Wahlkommission entscheidet',
}

const count = (n: number, one: string, many: string): string => (n === 1 ? `1 ${one}` : `${n} ${many}`)
const can = (names: string[]): string => (names.length === 1 ? 'kann' : 'können')

// The step buttons are hidden while their dialog is open, so the focus goes
// back to the one that comes back when the dialog is cancelled.
async function refocusStep(step: string): Promise<void> {
  await nextTick()
  document.querySelector<HTMLElement>(`[data-step="${step}"]`)?.focus()
}

function lotsOf(contest: ContestResult): LotRequest[] {
  return contest.outcome.kind === 'lot-required' ? [...contest.outcome.lots] : []
}

/** Each class of `groups` with its valid cards of the round, and the ones without. */
function cardLines(groups: { name: string, keys: number }[], round: string): { lines: DayDialog['lines'], missing: string[] } {
  return {
    lines: groups.map((group) => ({ text: group.keys > 0 ? `${group.name}: ${group.keys} Stimmkarten` : `${group.name}: keine gültigen Stimmkarten für ${round}`, missing: group.keys === 0 })),
    missing: groups.filter((group) => group.keys === 0).map((group) => group.name),
  }
}

export function useElectionDay(source: () => DaySource, changed: () => void) {
  const election = computed(() => source().election)
  const rules = computed(() => runRules(election.value.lifecycle, election.value.permissions))
  const base = computed(() => `/api/elections/${election.value.id}`)

  /** The turnout shown, with the round it is of: figures of one round never show under another's label. */
  const turnout = ref<(Turnout & { kind: RoundKind }) | null>(null)
  const result = ref<ElectionResult | null>(null)
  const testResult = ref<RoundResults | null>(null)
  const busy = ref(false)
  const error = ref<DayMessage | null>(null)
  const notice = ref<DayMessage | null>(null)
  const confirming = ref<DayStep | null>(null)
  const finalizing = ref(false)
  const exported = ref<{ name: string, sha256: string } | null>(null)

  const names = computed<Names>(() => {
    const byId = new Map(source().configuration.contests.flatMap((contest) => contest.candidates.map((candidate) => [candidate.id, `${candidate.givenName} ${candidate.surname}`])))
    return { candidate: (id) => byId.get(id) ?? id }
  })
  /** A candidate's picture, base path included, or null without one. */
  const pictureOf = computed(() => {
    const byId = new Map(source().configuration.contests.flatMap((contest) => contest.candidates.map((candidate) => [candidate.id, candidate.picture])))
    return (id: string): string | null => {
      const picture = byId.get(id) ?? null
      return picture === null ? null : withBase(picture)
    }
  })
  const contestTitle = (id: string): string => source().configuration.contests.find((contest) => contest.id === id)?.title ?? ''
  const rulesetOf = (id: string): RulesetId => source().configuration.contests.find((contest) => contest.id === id)?.rulesetId ?? 'single-choice-v1'

  const stateLine = computed(() => {
    const { lifecycle } = election.value
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
      if (JSON.stringify(detail.lifecycle) !== JSON.stringify(election.value.lifecycle)) changed()
    } catch {
      // The next tick asks again.
    } finally {
      statePending = false
    }
  }

  /** A read that went through takes back what an earlier one of its card said went wrong. */
  function clearError(card: DayCard): void {
    if (error.value?.card === card) error.value = null
  }

  /** The result as it stands; a read of the tick's own is quiet about a failure, the next tick reads again. */
  async function readResult(quiet = false): Promise<void> {
    const current = ++resultReads
    try {
      const answer = await apiGet<ElectionResult>(`${base.value}/result`)
      if (current === resultReads) {
        result.value = answer
        clearError('ergebnis')
      }
    } catch (err) {
      if (current === resultReads && !quiet) error.value = { text: errorMessage(err), card: 'ergebnis' }
    }
  }

  async function readTestResult(): Promise<void> {
    const current = ++testReads
    try {
      const answer = await apiGet<RoundResults>(`${base.value}/rounds/regular/test-result`)
      if (current === testReads) {
        testResult.value = answer
        clearError('probelauf')
      }
    } catch (err) {
      if (current === testReads) error.value = { text: errorMessage(err), card: 'probelauf' }
    }
  }

  let timer: ReturnType<typeof setInterval> | undefined

  function stopPolling(): void {
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
  }

  function refresh(): void {
    const { lifecycle } = election.value
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

  watch(() => election.value.lifecycle, refresh, { immediate: true, deep: true })
  // A component's scope ends when it unmounts.
  onScopeDispose(stopPolling)

  /** One step: the request, what to say afterwards in the step's card, and the page told to read the election again. */
  async function act<T>(card: DayCard, request: () => Promise<T>, then?: (answer: T) => string): Promise<boolean> {
    busy.value = true
    error.value = null
    notice.value = null
    try {
      const answer = await request()
      const said = then?.(answer)
      if (said) notice.value = { text: said, card }
      changed()
      return true
    } catch (err) {
      error.value = { text: errorMessage(err), card }
      return false
    } finally {
      busy.value = false
    }
  }

  const startTest = () => act('probelauf', () => apiPost(`${base.value}/rounds/regular/test`), () => 'Probelauf gestartet: Stimmen zählen nicht, und nichts bleibt.')
  const endTest = () => act('probelauf', () => apiPost<TestEnded>(`${base.value}/rounds/regular/test/end`), (ended) => {
    testResult.value = null
    return `Probelauf beendet: ${count(ended.ballots, 'Stimmzettel', 'Stimmzettel')} entfernt, ${count(ended.keys, 'Code', 'Codes')} wieder frei.`
  })
  const open = () => act('wahltag', () => apiPost(`${base.value}/rounds/regular/open`), () => 'Der 1. Wahlgang ist geöffnet.')
  const close = (kind: RoundKind) => act('wahltag', () => apiPost<{ ballots: number }>(`${base.value}/rounds/${kind}/close`), (closed) =>
    `${ROUND_LABELS[kind]} beendet: ${count(closed.ballots, 'Stimmzettel', 'Stimmzettel')} versiegelt und ausgezählt.`)
  const activate = () => act('wahltag', () => apiPost<RunoffActivated>(`${base.value}/rounds/runoff/activate`), (activated) =>
    `Die Stichwahl läuft: ${count(activated.keys, 'Stichwahl-Stimmkarte gilt', 'Stichwahl-Stimmkarten gelten')} jetzt.`)

  const regularCards = computed(() => cardLines(source().configuration.voterGroups.map((group) => ({
    name: group.name,
    keys: source().batches.filter((batch) => batch.voterGroupId === group.id && batch.roundKind === 'regular' && batch.state === 'issued').reduce((sum, batch) => sum + batch.keys, 0),
  })), 'den 1. Wahlgang'))

  /** What closing leaves unused, from the turnout of the round that closes. */
  function unusedLine(kind: RoundKind): DayDialog['lines'] {
    const figures = turnout.value
    if (figures?.kind !== kind) return []
    const unused = figures.keys.issued - figures.keys.used
    return [{ text: `${unused} von ${figures.keys.issued} Stimmkarten wurden nicht verwendet.`, missing: false }]
  }

  /** The pairs the first round gave, by contest, and the contests whose runoff entry still waits for a lot. */
  const runoff = computed(() => runoffState(result.value?.contests ?? []))

  /** The classes or groups that vote in a contest of the runoff, each with its issued runoff batches (a top-up is a batch of its own), if any. */
  const runoffSheets = computed(() => source().configuration.voterGroups
    .filter((group) => runoff.value.pairs.some((entry) => group.contestIds.includes(entry.contestId)))
    .map((group) => {
      const batches = source().batches.filter((batch) => batch.voterGroupId === group.id && batch.roundKind === 'runoff' && batch.state === 'issued')
      return { group, batches, keys: batches.reduce((sum, batch) => sum + batch.keys, 0) }
    }))

  const dialog = computed<DayDialog | null>(() => {
    switch (confirming.value) {
      case 'open': {
        const { lines, missing } = regularCards.value
        return {
          title: '1. Wahlgang öffnen?',
          text: 'Ab jetzt können Stimmen abgegeben werden. Kandidat:innen und die Stimmkarten des 1. Wahlgangs ändern sich nicht mehr, und für den 1. Wahlgang können keine Stimmkarten mehr erzeugt oder gedruckt werden. Ein laufender Probelauf wird beendet.',
          lines,
          override: missing.length > 0 ? `Trotzdem öffnen: ${listed(missing)} ${can(missing)} im 1. Wahlgang nicht wählen.` : null,
          yes: 'Ja, 1. Wahlgang öffnen',
          danger: false,
        }
      }
      case 'close-regular':
        return { title: '1. Wahlgang beenden und auszählen?', text: 'Danach nimmt der 1. Wahlgang keine Stimmen mehr an; wer gerade abgibt, bekommt eine Absage. Die Stimmzettel werden versiegelt und ausgezählt. Ein beendeter Wahlgang öffnet nicht wieder.', lines: unusedLine('regular'), override: null, yes: 'Ja, beenden und auszählen', danger: true }
      case 'close-runoff':
        return { title: 'Stichwahl beenden und auszählen?', text: 'Danach nimmt die Stichwahl keine Stimmen mehr an; wer gerade abgibt, bekommt eine Absage. Die Stimmzettel werden versiegelt und ausgezählt. Eine beendete Stichwahl öffnet nicht wieder.', lines: unusedLine('runoff'), override: null, yes: 'Ja, beenden und auszählen', danger: true }
      case 'activate': {
        const { lines, missing } = cardLines(runoffSheets.value.map((entry) => ({ name: entry.group.name, keys: entry.keys })), 'die Stichwahl')
        return {
          title: 'Stichwahl aktivieren?',
          text: 'Die Stichwahl beginnt sofort, mit den Stichwahl-Stimmkarten. Die Stimmkarten des 1. Wahlgangs gelten nicht mehr, und Stichwahl-Stimmkarten können danach nicht mehr erzeugt oder gedruckt werden.',
          lines,
          override: missing.length > 0 ? `Trotzdem aktivieren: ${listed(missing)} ${can(missing)} in der Stichwahl nicht wählen.` : null,
          yes: 'Ja, Stichwahl aktivieren',
          danger: false,
        }
      }
      case null:
        return null
    }
  })

  const RUN: Readonly<Record<DayStep, () => Promise<boolean>>> = {
    'open': open,
    'close-regular': () => close('regular'),
    'close-runoff': () => close('runoff'),
    'activate': activate,
  }

  const undecided = computed(() => (result.value?.contests ?? [])
    .filter((contest) => contest.outcome.kind !== 'final')
    .map((contest) => `${contestTitle(contest.contestId)}: ${contest.outcome.kind === 'final' ? '' : UNDECIDED[contest.outcome.kind]}`))

  watch(confirming, (now, before) => {
    if (now === null && before !== null) void refocusStep(before)
  })
  watch(finalizing, (now, before) => {
    if (!now && before) void refocusStep('finalize')
  })

  function ask(step: DayStep): void {
    confirming.value = step
  }
  function cancel(): void {
    confirming.value = null
  }
  async function confirm(): Promise<void> {
    const step = confirming.value
    confirming.value = null
    if (step !== null) await RUN[step]()
  }

  function askFinalize(): void {
    finalizing.value = true
  }
  function cancelFinalize(): void {
    finalizing.value = false
  }
  /** Establishes the result with `reason`; whether it went through. */
  function finalize(reason: string): Promise<boolean> {
    return act('feststellen', () => apiPost<ElectionFinalized>(`${base.value}/finalize`, { reason: reason.trim() }), (done) => {
      finalizing.value = false
      return done.batchesVoided > 0 ? 'Das Ergebnis ist festgestellt. Nicht verwendete Stichwahl-Stimmkarten sind ungültig.' : 'Das Ergebnis ist festgestellt.'
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
      const name = fileNameOf(headers.get('content-disposition')) ?? `wahl-${election.value.id}.json`
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
      error.value = { text: errorMessage(err), card: 'feststellen' }
    } finally {
      busy.value = false
    }
  }

  /** A plain link to the print page, base path included: the router does not add it here. */
  const printPath = (batch: BatchSummary): string => withBase(`/elections/${election.value.id}/batches/${batch.id}/print`)

  /** The message for `card`, if the last one is its. */
  const noticeIn = (card: DayCard): string | null => (notice.value?.card === card ? notice.value.text : null)
  const errorIn = (card: DayCard): string | null => (error.value?.card === card ? error.value.text : null)

  return {
    electionId: computed(() => election.value.id),
    rules,
    names,
    pictureOf,
    contestTitle,
    rulesetOf,
    stateLine,
    turnout,
    result,
    testResult,
    busy,
    confirming,
    finalizing,
    exported,
    dialog,
    undecided,
    runoff,
    runoffSheets,
    regularCards,
    noticeIn,
    errorIn,
    startTest,
    endTest,
    readTestResult,
    ask,
    cancel,
    confirm,
    askFinalize,
    cancelFinalize,
    finalize,
    lotRecorded,
    download,
    lotsOf,
    printPath,
  }
}

/** The day's state as its cards read it, refs unwrapped (`reactive(useElectionDay(...))`). */
export type ElectionDay = UnwrapNestedRefs<ReturnType<typeof useElectionDay>>
