<script setup lang="ts">
// One contest's ballot: the candidates with their pictures, and one row per
// active slot with its points, its function and a choice among the
// candidates; a candidate chosen in a second row moves there. A contest
// with a single candidate asks "Ja" or "Nein" instead. The state is
// ballot-state.ts's; "Prüfen" hands the ballot up as it stands, which the
// review step classifies, and "Korrigieren" brings it back here as it was.

import { computed, ref } from 'vue'
import { fromBallot, place, pool, rankingOf, rowOf, type BallotState } from './ballot-state.ts'
import { pictureUrl, type VoterBallot, type VoterContest } from './voter-api.ts'
import { candidateName, pointsLabel, slotRows, yesOrNo } from './voter-rules.ts'

const props = defineProps<{
  contest: VoterContest
  /** The ballot as it was reviewed, to correct. */
  initial?: VoterBallot
}>()

const emit = defineEmits<{
  review: [ballot: VoterBallot]
  back: []
}>()

type Choice = 'yes' | 'no' | null

function initialChoice(ballot: VoterBallot | undefined): Choice {
  if (ballot?.kind === 'no') return 'no'
  if (ballot?.kind === 'ranking' && ballot.ranking[0]) return 'yes'
  return null
}

const rows = computed(() => slotRows(props.contest))
const single = computed(() => yesOrNo(props.contest))
const morePeopleThanRows = computed(() => props.contest.candidates.length > rows.value.length)
const state = ref<BallotState>(fromBallot(props.contest, props.initial))
const choice = ref<Choice>(initialChoice(props.initial))
const unranked = computed(() => pool(props.contest, state.value).length)

function choose(rank: number, event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  state.value = place(state.value, rank, value === '' ? null : value)
}

/** Where a candidate stands on the ballot as it is filled. */
function standing(candidateId: string): string {
  const rank = rowOf(state.value, candidateId)
  if (rank === undefined) return morePeopleThanRows.value ? 'ohne Punkte' : 'noch nicht gereiht'
  const row = rows.value[rank - 1]
  return row ? `gereiht: ${pointsLabel(row.points)}` : ''
}

function review(): void {
  if (!single.value) {
    emit('review', rankingOf(state.value))
  } else if (choice.value === 'no') {
    emit('review', { kind: 'no' })
  } else if (choice.value === 'yes') {
    emit('review', { kind: 'ranking', ranking: [props.contest.candidates[0]?.id ?? null] })
  }
}
</script>

<template>
  <section
    class="ballot"
    aria-labelledby="voter-heading"
  >
    <h1
      id="voter-heading"
      tabindex="-1"
    >
      {{ contest.title }}
    </h1>
    <p v-if="single">
      In dieser Wahl steht eine Person zur Wahl. Stimmen Sie mit Ja oder Nein.
    </p>
    <template v-else>
      <p>Wählen Sie in jeder Zeile eine Person. Jede Person kann nur einmal gereiht werden.</p>
      <p v-if="morePeopleThanRows">
        Es gibt mehr Kandidat:innen als Zeilen: Wer nicht gereiht wird, bekommt keine Punkte.
      </p>
    </template>
    <ul
      class="plain candidates"
      aria-label="Kandidat:innen"
    >
      <li
        v-for="candidate in contest.candidates"
        :key="candidate.id"
      >
        <img
          v-if="candidate.picture"
          :src="pictureUrl(candidate.picture)"
          alt=""
          class="picture"
        >
        <span
          v-else
          class="picture placeholder"
          aria-hidden="true"
        />
        <span class="name">{{ candidateName(candidate) }}</span>
        <span
          v-if="!single"
          class="standing"
        >{{ standing(candidate.id) }}</span>
      </li>
    </ul>
    <fieldset
      v-if="single"
      class="choice"
    >
      <legend>Ihre Stimme</legend>
      <label class="option">
        <input
          v-model="choice"
          type="radio"
          name="choice"
          value="yes"
        >
        Ja
      </label>
      <label class="option">
        <input
          v-model="choice"
          type="radio"
          name="choice"
          value="no"
        >
        Nein
      </label>
    </fieldset>
    <div
      v-else
      class="rows"
    >
      <div
        v-for="row in rows"
        :key="row.rank"
        class="slot"
      >
        <label :for="`voter-slot-${row.rank}`">{{ pointsLabel(row.points) }} · {{ row.label }}</label>
        <select
          :id="`voter-slot-${row.rank}`"
          :value="state.slots[row.rank - 1] ?? ''"
          @change="choose(row.rank, $event)"
        >
          <option value="">
            – bitte wählen –
          </option>
          <option
            v-for="candidate in contest.candidates"
            :key="candidate.id"
            :value="candidate.id"
          >
            {{ candidateName(candidate) }}
          </option>
        </select>
      </div>
      <output
        v-if="morePeopleThanRows"
        class="status muted"
      >
        Ohne Punkte: {{ unranked }}
      </output>
    </div>
    <div class="actions">
      <button
        type="button"
        :disabled="single && choice === null"
        @click="review"
      >
        Prüfen
      </button>
      <button
        type="button"
        class="secondary"
        @click="emit('back')"
      >
        Zurück
      </button>
    </div>
  </section>
</template>

<style scoped>
.status {
  display: block;
  margin: 0 0 10px;
}

.candidates > li {
  display: grid;
  grid-template-columns: auto 1fr;
  column-gap: 12px;
  align-items: center;
  padding: 8px 0;
}

.picture {
  grid-row: span 2;
  width: 3.5rem;
  height: 3.5rem;
  object-fit: cover;
  object-position: 50% 25%;
  border-radius: var(--radius);
  background: var(--field);
}

.name {
  font-weight: 600;
}

.standing {
  color: var(--muted);
  font-size: 0.95rem;
}

.rows {
  display: grid;
  gap: 4px;
  margin-top: 12px;
}

.slot select {
  max-width: none;
  min-height: 44px;
}

.choice {
  margin: 12px 0;
  padding: 8px 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
}

.choice legend {
  font-weight: 600;
}

.option {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 44px;
  margin: 0;
  font-weight: 500;
}

.option input {
  width: 1.4rem;
  height: 1.4rem;
}

.actions button {
  min-height: 44px;
}
</style>
