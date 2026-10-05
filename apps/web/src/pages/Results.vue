<script setup lang="ts">
// Ergebnis und Herleitung: per contest the figures of every round as a
// table (first places, every slot, points), the derivation step by step
// in German from election-core's trace, the lots recorded, the positions
// as they stand or as declared, and the versions that counted. For every
// member, witnesses included, once the regular round has closed; before
// that the page says so, shows nothing, and asks the API for nothing the
// lifecycle says it would refuse. While the election can still change (a
// lot recorded, the runoff, the finalization), the page reads the result
// again every five seconds, so what a witness sees is what stands.

import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { apiGet } from '../lib/api.ts'
import { ApiError, errorMessage } from '../lib/api-rules.ts'
import { ROUND_LABELS, RULESET_LABELS } from '../lib/labels.ts'
import { dateTime, outcomeLine, positionLines, recordedLotLine, type Names } from '../lib/outcome-text.ts'
import { statisticsTable, stepText } from '../lib/trace-text.ts'
import type { Configuration, ContestResult, ElectionDetail, ElectionResult, Snapshot } from '../lib/types.ts'
import { canShowResults, type RoundKind, type RulesetId } from '@school-election/election-core'

const props = defineProps<{ id: string }>()

const election = ref<ElectionDetail>()
const configuration = ref<Configuration>()
const result = ref<ElectionResult>()
const error = ref<string | null>(null)
/** The regular round has not closed: nothing to show yet. */
const early = ref(false)

let loads = 0

async function load(): Promise<void> {
  const current = ++loads
  const base = `/api/elections/${props.id}`
  try {
    const [detail, config] = await Promise.all([apiGet<ElectionDetail>(base), apiGet<Configuration>(`${base}/configuration`)])
    let answer: ElectionResult | undefined
    if (canShowResults(detail.lifecycle, 'regular').ok) {
      try {
        answer = await apiGet<ElectionResult>(`${base}/result`)
      } catch (err) {
        // A round opened between the two reads: nothing to show yet.
        if (!(err instanceof ApiError && err.status === 409)) throw err
      }
    }
    if (current !== loads) return
    election.value = detail
    configuration.value = config
    result.value = answer
    early.value = answer === undefined
    error.value = null
  } catch (err) {
    if (current === loads) error.value = errorMessage(err)
  }
}

const EVERY_MS = 5000
let timer: ReturnType<typeof setInterval> | undefined
let reading = false

/** The election and its result read again, once at a time, while the election is not final. */
async function follow(): Promise<void> {
  if (reading || election.value?.lifecycle.election === 'final') return
  reading = true
  try {
    await load()
  } finally {
    reading = false
  }
}

onMounted(() => {
  void load()
  timer = setInterval(() => void follow(), EVERY_MS)
})
onUnmounted(() => {
  if (timer !== undefined) clearInterval(timer)
})
watch(() => props.id, () => {
  election.value = undefined
  configuration.value = undefined
  result.value = undefined
  void load()
})

const names = computed<Names>(() => {
  const byId = new Map(configuration.value?.contests.flatMap((contest) => contest.candidates.map((candidate) => [candidate.id, `${candidate.givenName} ${candidate.surname}`])) ?? [])
  return { candidate: (id) => byId.get(id) ?? id }
})
const contestOf = (id: string) => configuration.value?.contests.find((contest) => contest.id === id)
const rulesetOf = (id: string): RulesetId => contestOf(id)?.rulesetId ?? 'single-choice-v1'

interface Round {
  kind: RoundKind
  rulesetId: RulesetId
  snapshot: Snapshot
}

/** The rounds of a contest with their snapshots: the regular round, and the runoff once it has closed, counted as a single choice. */
function roundsOf(contest: ContestResult): Round[] {
  const rounds: Round[] = [{ kind: 'regular', rulesetId: rulesetOf(contest.contestId), snapshot: contest.first }]
  if (contest.runoff) rounds.push({ kind: 'runoff', rulesetId: 'single-choice-v1', snapshot: contest.runoff })
  return rounds
}

const versions = (snapshot: Snapshot): string => `Auszählung Version ${snapshot.tallyVersion}, Software ${snapshot.appVersion} (${snapshot.gitSha})`

/** The ballots of a round below its table: valid, "Nein" among them where there were any, invalid. */
function ballotsText(snapshot: Snapshot): string {
  const { validBallots, noBallots, invalidBallots } = snapshot.result.statistics
  const no = noBallots > 0 ? `, davon „Nein“: ${noBallots}` : ''
  return `Gültige Stimmen: ${validBallots}${no} · ungültig: ${invalidBallots}`
}
</script>

<template>
  <p
    v-if="error"
    class="message error"
    role="alert"
  >
    {{ error }}
  </p>
  <template v-else-if="election && configuration">
    <h1>Ergebnis: {{ election.title }}</h1>
    <p class="muted">
      <RouterLink :to="`/wahlen/${election.id}`">
        Zur Wahl
      </RouterLink>
      ·
      <RouterLink :to="`/wahlen/${election.id}/protokoll`">
        Protokoll
      </RouterLink>
    </p>
    <p
      v-if="early"
      class="muted"
      data-testid="early"
    >
      Das Ergebnis gibt es, sobald die Wahl geschlossen ist. Solange eine Runde läuft, sieht niemand Zwischenstände.
    </p>
    <template v-else-if="result">
      <p
        v-if="result.finalized"
        data-testid="finalized"
      >
        <strong>Abgeschlossen am {{ dateTime(result.finalized.at) }} durch {{ result.finalized.actorName }}: {{ result.finalized.reason }}</strong>
      </p>
      <p
        v-else
        class="muted"
      >
        Das Ergebnis, wie es jetzt steht; die Wahl ist noch nicht abgeschlossen.
      </p>
      <article
        v-for="contest in result.contests"
        :key="contest.contestId"
        :aria-labelledby="`contest-${contest.contestId}`"
        class="card-box"
      >
        <h2 :id="`contest-${contest.contestId}`">
          {{ contestOf(contest.contestId)?.title ?? '' }}
        </h2>
        <p class="muted">
          {{ RULESET_LABELS[rulesetOf(contest.contestId)] }}
        </p>

        <section
          v-for="round in roundsOf(contest)"
          :key="round.kind"
          :aria-label="`${ROUND_LABELS[round.kind]}: ${contestOf(contest.contestId)?.title ?? ''}`"
        >
          <h3>{{ ROUND_LABELS[round.kind] }}</h3>
          <table>
            <thead>
              <tr>
                <th scope="col">
                  Kandidat:in
                </th>
                <th scope="col">
                  Erste Stellen
                </th>
                <th
                  v-for="slot in statisticsTable(round.rulesetId, round.snapshot.result.statistics, names).slots"
                  :key="slot"
                  scope="col"
                >
                  {{ slot }}
                </th>
                <th scope="col">
                  Punkte
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in statisticsTable(round.rulesetId, round.snapshot.result.statistics, names).rows"
                :key="row.candidateId"
              >
                <th scope="row">
                  {{ row.name }}
                </th>
                <td>{{ row.firstPlaces }}</td>
                <td
                  v-for="(count, index) in row.rankCounts"
                  :key="index"
                >
                  {{ count }}
                </td>
                <td>{{ row.points }}</td>
              </tr>
            </tbody>
          </table>
          <p class="muted">
            {{ ballotsText(round.snapshot) }} · {{ versions(round.snapshot) }}
          </p>
        </section>

        <h3>Herleitung</h3>
        <ol :aria-label="`Herleitung: ${contestOf(contest.contestId)?.title ?? ''}`">
          <li
            v-for="(step, index) in contest.outcome.trace"
            :key="index"
          >
            {{ stepText(rulesetOf(contest.contestId), step, names) }}
          </li>
        </ol>

        <ul
          v-if="contest.lots.length > 0"
          class="plain"
          :aria-label="`Losentscheide: ${contestOf(contest.contestId)?.title ?? ''}`"
        >
          <li
            v-for="lot in contest.lots"
            :key="lot.id"
          >
            {{ recordedLotLine(lot.drawn, lot.actorName, lot.recordedAt, lot.reason, names) }}
          </li>
        </ul>

        <h3>{{ result.finalized ? 'Ergebnis' : 'Stand' }}</h3>
        <p>
          <strong>{{ outcomeLine(contest.outcome, names) }}</strong>
        </p>
        <ul
          v-if="positionLines(rulesetOf(contest.contestId), contest.outcome, names).length > 0"
          class="plain"
          :aria-label="`Positionen: ${contestOf(contest.contestId)?.title ?? ''}`"
        >
          <li
            v-for="line in positionLines(rulesetOf(contest.contestId), contest.outcome, names)"
            :key="line"
          >
            {{ line }}
          </li>
        </ul>
      </article>
    </template>
  </template>
  <p
    v-else
    class="muted"
  >
    Wird geladen …
  </p>
</template>

<style scoped>
h2 {
  border-top: 0;
  padding-top: 0;
  margin-top: 0;
}

td {
  text-align: right;
}

td:first-child,
th {
  text-align: left;
}

ol li {
  margin: 4px 0;
}
</style>
