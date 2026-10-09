<script setup lang="ts">
// One Wahl's result as it stands, in words and bars: a badge for what the
// count decided, the positions with the first one highlighted, the
// positions nobody holds in one line, the figures of each round as bars
// labelled as the app counts them ("Erste Stellen", "Stimmen"), a lot that
// is due with its form, and the lots recorded with who entered them and
// when. Screen readers read each position as one sentence, as the result
// page writes it; the full derivation is that page's.

import { computed } from 'vue'
import type { ContestStatistics, Outcome } from '@school-election/election-core'
import LineIcon from './LineIcon.vue'
import LotForm from './LotForm.vue'
import type { ElectionDay } from '../lib/election-day.ts'
import { countsLine, dateTime, firstPlaceFigures, joinedLabels, lotText, outcomeLine, positionsOf } from '../lib/outcome-text.ts'
import { initials } from '../lib/people.ts'
import type { ContestResult } from '../lib/types.ts'

const props = defineProps<{
  day: ElectionDay
  contest: ContestResult
}>()

const BADGES: Readonly<Record<Outcome['kind'], { text: string, tone: 'ok' | 'info' | 'warn' }>> = {
  'final': { text: 'Gewählt', tone: 'ok' },
  'runoff-required': { text: 'Stichwahl', tone: 'info' },
  'lot-required': { text: 'Losentscheid', tone: 'warn' },
  'tie': { text: 'Unentschieden', tone: 'warn' },
  'committee-decision': { text: 'Wahlkommission', tone: 'warn' },
}

const title = computed(() => props.day.contestTitle(props.contest.contestId))
const rulesetId = computed(() => props.day.rulesetOf(props.contest.contestId))
const badge = computed(() => BADGES[props.contest.outcome.kind])
const positions = computed(() => positionsOf(rulesetId.value, props.contest.outcome, props.day.names))
const held = computed(() => positions.value.filter((position) => !position.vacant))
/** The positions nobody holds, in one phrase: "1., 2. und 3. Stellvertretung im SGA". */
const vacant = computed(() => joinedLabels(positions.value.filter((position) => position.vacant).map((position) => position.label)))

interface Round {
  label: string
  statistics: ContestStatistics
  figures: ReturnType<typeof firstPlaceFigures>
}
const rounds = computed<Round[]>(() => {
  const first = props.contest.first.result.statistics
  const list: Round[] = [{ label: '1. Wahlgang', statistics: first, figures: firstPlaceFigures(rulesetId.value, first) }]
  const runoff = props.contest.runoff?.result.statistics
  if (runoff) list.push({ label: 'Stichwahl', statistics: runoff, figures: firstPlaceFigures('single-choice-v1', runoff) })
  return list
})

/** The ballots of a round, and what its bars count: "4 Stimmen. Erste Stellen:". */
const caption = (round: Round): string => (round.figures.rows.length > 0 ? `${countsLine(round.statistics)} ${round.figures.label}:` : countsLine(round.statistics))
/** A bar's length: its share of the round's valid ballots. */
const share = (figure: number, statistics: ContestStatistics): string => `${statistics.validBallots > 0 ? (figure / statistics.validBallots) * 100 : 0}%`
const top = (figure: number, round: Round): boolean => figure > 0 && figure === Math.max(...round.figures.rows.map((row) => row.figure))
</script>

<template>
  <article
    class="result"
    :aria-labelledby="`result-${contest.contestId}`"
  >
    <div class="head">
      <h3 :id="`result-${contest.contestId}`">
        {{ title }}
      </h3>
      <span :class="['badge', badge.tone]"><LineIcon
        v-if="contest.outcome.kind === 'final'"
        name="check"
        :size="13"
      />{{ badge.text }}</span>
    </div>
    <p
      v-if="contest.outcome.kind !== 'final'"
      class="outcome"
    >
      {{ outcomeLine(contest.outcome, day.names) }}
    </p>
    <div class="body">
      <ul
        v-if="positions.length > 0"
        class="positions"
        :aria-label="`Positionen: ${title}`"
      >
        <li
          v-for="(position, index) in held"
          :key="position.label"
          :class="{ first: index === 0 && position.name !== null }"
        >
          <img
            v-if="position.candidateId !== null && day.pictureOf(position.candidateId)"
            class="avatar"
            :src="day.pictureOf(position.candidateId) ?? ''"
            alt=""
          >
          <span
            v-else
            class="avatar"
            :class="{ pending: position.name === null }"
            :data-initials="position.name === null ? '' : initials(position.name)"
            aria-hidden="true"
          />
          <span class="text">
            <span class="role">{{ position.label }}</span><span class="visually-hidden">: </span>
            <template v-if="position.name !== null">
              <span class="name">{{ position.name }}</span><span class="basis"><span class="visually-hidden"> (</span>{{ position.basis }}<span class="visually-hidden">)</span></span>
            </template>
            <span
              v-else
              class="basis"
            >{{ position.basis }}</span>
          </span>
        </li>
        <li
          v-if="vacant"
          class="vacant"
        >
          {{ vacant }}: <strong>unbesetzt</strong>
        </li>
      </ul>
      <div class="rounds">
        <div
          v-for="round in rounds"
          :key="round.label"
          class="round"
        >
          <p class="caption">
            <strong>{{ round.label }}</strong>: {{ caption(round) }}
          </p>
          <ul
            v-if="round.figures.rows.length > 0"
            class="bars"
            :aria-label="`${round.figures.label}, ${round.label}: ${title}`"
          >
            <li
              v-for="row in round.figures.rows"
              :key="row.candidateId"
            >
              <span class="who">{{ day.names.candidate(row.candidateId) }}</span><span class="visually-hidden">{{ ' ' }}</span>
              <span
                class="bar"
                aria-hidden="true"
              ><span
                :class="{ top: top(row.figure, round) }"
                :style="{ width: share(row.figure, round.statistics) }"
              /></span>
              <span class="figure">{{ row.figure }}</span>
            </li>
          </ul>
        </div>
      </div>
    </div>
    <div
      v-for="lot in day.lotsOf(contest)"
      :key="lot.id"
      class="lot"
      :data-testid="`lot-${lot.id}`"
    >
      <h4>Losentscheid</h4>
      <p>{{ lotText(rulesetId, lot, day.names) }}</p>
      <LotForm
        v-if="day.rules.recordLot"
        :election-id="day.electionId"
        :contest-id="contest.contestId"
        :contest-title="title"
        :ruleset-id="rulesetId"
        :lot="lot"
        :names="day.names"
        @recorded="day.lotRecorded(contest.contestId)"
      />
    </div>
    <div
      v-if="contest.lots.length > 0"
      class="recorded"
    >
      <h4>Losentscheide</h4>
      <ul :aria-label="`Losentscheide: ${title}`">
        <li
          v-for="lot in contest.lots"
          :key="lot.id"
        >
          <span class="drawn">{{ lot.drawn.map(day.names.candidate).join(', ') }}.</span><span class="visually-hidden">{{ ' ' }}</span>
          <span class="why">Begründung: {{ lot.reason }}</span><span class="visually-hidden">{{ ' ' }}</span>
          <span class="by">Eingetragen von {{ lot.actorName }} am {{ dateTime(lot.recordedAt) }}</span>
        </li>
      </ul>
    </div>
  </article>
</template>

<style scoped>
.result {
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: var(--radius-card);
  background: var(--paper);
}

.head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 12px;
  padding: 18px 24px;
  border-bottom: 1px solid var(--line);
}

.head h3 {
  margin: 0;
  font-size: 1.1rem;
}

.badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.outcome {
  margin: 0;
  padding: 14px 24px 0;
  font-weight: 600;
}

.body {
  display: flex;
  flex-wrap: wrap;
  gap: 28px;
  padding: 20px 24px;
}

.positions,
.rounds {
  flex: 1 1 300px;
  min-width: 0;
}

.positions {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.positions > li {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 8px 14px;
}

.positions > li.first {
  margin-bottom: 6px;
  padding: 14px;
  border-radius: 12px;
  background: #eef1fb;
}

.avatar {
  flex: none;
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  overflow: hidden;
  box-sizing: border-box;
  border: 1px solid var(--line);
  border-radius: 50%;
  background: var(--soft);
  color: var(--ink2);
  font-size: 0.75rem;
  font-weight: 600;
  object-fit: cover;
  object-position: 50% 25%;
}

.avatar::before {
  content: attr(data-initials);
}

.avatar.pending {
  border-style: dashed;
  border-color: var(--line2);
  background: var(--paper);
}

.first .avatar {
  width: 48px;
  height: 48px;
  border: 0;
  background: var(--paper);
  color: var(--accent);
  font-size: 0.9rem;
}

.text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.role {
  color: var(--muted);
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.name {
  font-weight: 600;
}

.first .name {
  font-size: 1.15rem;
}

.basis {
  color: var(--ink2);
  font-size: 0.8rem;
}

.positions > li.vacant {
  display: block;
  margin-top: 6px;
  border: 1px dashed var(--line2);
  border-radius: 10px;
  color: var(--muted);
  font-size: 0.85rem;
}

.vacant strong {
  color: var(--ink2);
}

.rounds {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.caption {
  margin: 0 0 10px;
  color: var(--ink2);
  font-size: 0.85rem;
}

.caption strong {
  color: var(--ink);
}

.bars {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  font-size: 0.85rem;
  list-style: none;
}

/* The same columns in every row, so the bars start and end together. */
.bars > li {
  display: grid;
  grid-template-columns: minmax(0, 9rem) minmax(0, 1fr) 2em;
  gap: 12px;
  align-items: center;
}

.who {
  overflow-wrap: anywhere;
}

.bar {
  height: 10px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--chip);
}

.bar > span {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: #8e9bc9;
}

.bar > span.top {
  background: var(--accent);
}

.figure {
  text-align: right;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.lot {
  margin: 0 24px 20px;
  padding: 14px 16px;
  border: 1px solid var(--warn-line);
  border-radius: 12px;
  background: var(--warn-soft);
}

.lot h4,
.recorded h4 {
  margin: 0 0 8px;
  color: var(--ink2);
  font-size: 0.75rem;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.lot p {
  margin: 0 0 8px;
}

.recorded {
  padding: 16px 24px 20px;
  border-top: 1px solid var(--line);
  background: var(--soft);
}

.recorded ul {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.recorded li {
  display: flex;
  flex-direction: column;
  font-size: 0.85rem;
}

.drawn {
  font-weight: 600;
}

.why {
  color: var(--ink2);
}

.by {
  color: var(--muted);
  font-size: 0.8rem;
}

@media (width <= 600px) {
  .head,
  .body {
    padding-left: 16px;
    padding-right: 16px;
  }

  .outcome {
    padding: 14px 16px 0;
  }

  .lot {
    margin: 0 16px 16px;
  }

  .recorded {
    padding: 16px;
  }
}
</style>
