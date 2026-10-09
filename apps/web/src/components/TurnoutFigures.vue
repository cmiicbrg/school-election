<script setup lang="ts">
// The turnout of a round: how many of its cards were used, as a large
// figure, and per Wahl with a bar. Counts only, never a result. In the
// colour of a test while a Probelauf runs on the cards.

import type { RoundKind } from '@school-election/election-core'
import type { Turnout } from '../lib/types.ts'

defineProps<{
  turnout: Turnout & { kind: RoundKind }
  /** A Wahl's title by its id. */
  title: (contestId: string) => string
  /** A Probelauf runs on the cards. */
  testing?: boolean
}>()

const OF_ROUND: Readonly<Record<RoundKind, string>> = { regular: 'des 1. Wahlgangs', runoff: 'der Stichwahl' }

const share = (used: number, issued: number): string => `${issued > 0 ? Math.min(100, (used / issued) * 100) : 0}%`
</script>

<template>
  <div
    class="turnout"
    :class="{ testing }"
    data-testid="turnout"
  >
    <p class="total">
      <span class="figure">{{ turnout.keys.used }}</span> von {{ turnout.keys.issued }} Stimmkarten {{ OF_ROUND[turnout.kind] }} verwendet
    </p>
    <ul
      class="contests"
      aria-label="Beteiligung je Wahl"
    >
      <li
        v-for="entry in turnout.contests"
        :key="entry.contestId"
      >
        <span class="line">
          <span class="name">{{ title(entry.contestId) }}</span><span class="visually-hidden">: </span><span class="count">{{ entry.used }} von {{ entry.issued }}</span>
        </span>
        <span
          class="bar"
          aria-hidden="true"
        ><span :style="{ width: share(entry.used, entry.issued) }" /></span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.turnout {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.total {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 12px;
  margin: 0;
  color: var(--ink2);
}

.figure {
  color: var(--ink);
  font-size: 2.6rem;
  font-weight: 600;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}

.contests {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 16px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.contests > li {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--paper);
}

.line {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}

.name {
  font-weight: 600;
}

.count {
  color: var(--ink2);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.bar {
  height: 8px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--chip);
}

.bar > span {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--accent);
}

.testing .bar > span {
  background: #c77a00;
}
</style>
