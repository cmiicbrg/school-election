<script setup lang="ts">
// One stack's cards as sheets to print: six cards to an A4 page, each
// exactly a sixth of the sheet, with the termin, the Wahlgang, the class, a
// QR code and the key, and only the three cut lines between them. A stack
// starts on a sheet of its own. A runoff card carries a framed band,
// "Stichwahl", and says that it counts only once the runoff begins: printed
// in advance, it must not pass for a card of the 1. Wahlgang. The print
// pages (pages/PrintBatch.vue, pages/PrintRound.vue) load the keys and
// draw the QR images; this draws the sheets.

import { computed } from 'vue'
import '@fontsource/dm-sans/400.css'
import '@fontsource/dm-sans/700.css'
import '@fontsource/jetbrains-mono/400.css'
import type { RoundKind } from '@school-election/election-core'
import { pagesOf, ROUND_LABELS, type Card } from '../lib/sheet.ts'

const props = defineProps<{
  /** The termin's title. */
  title: string
  roundKind: RoundKind
  /** The class or group the stack is for. */
  groupName: string
  cards: Card[]
  /** Each card's QR image, by its key. */
  images: ReadonlyMap<string, string>
  /** The address a voter types instead of scanning. */
  address: string
}>()

const pages = computed(() => pagesOf(props.cards))
</script>

<template>
  <section
    v-for="(page, index) in pages"
    :key="index"
    class="page"
    data-testid="page"
  >
    <article
      v-for="card in page"
      :key="card.key"
      class="card"
      data-testid="card"
    >
      <h2 class="title">
        {{ title }}
      </h2>
      <p
        v-if="roundKind === 'runoff'"
        class="band"
        data-testid="band"
      >
        <span class="band-head"><strong>{{ ROUND_LABELS.runoff }}</strong> · {{ groupName }}</span>
        <span class="band-note">gilt erst, wenn die Stichwahl beginnt</span>
      </p>
      <p
        v-else
        class="round"
      >
        {{ ROUND_LABELS[roundKind] }} · {{ groupName }}
      </p>
      <img
        :src="images.get(card.key) ?? ''"
        alt=""
        class="qr"
        data-testid="qr"
      >
      <p
        class="key"
        data-testid="key"
      >
        {{ card.grouped }}
      </p>
      <p class="how">
        QR-Code mit dem Handy scannen, oder <strong>{{ address }}</strong> öffnen und den Code eingeben.
      </p>
    </article>
  </section>
</template>

<style scoped>
/* Exactly A4, two columns of 105mm by three rows of 99mm, so a card is a
   sixth of the sheet and three cuts separate them. The cut lines are the
   borders of two empty elements over the grid: one vertical line down the
   middle, one horizontal line at each third. Borders print by default,
   where a background would not; a card has no border of its own. */
.page {
  position: relative;
  box-sizing: border-box;
  width: 210mm;
  height: 297mm;
  padding: 0;
  display: grid;
  grid-template-columns: 105mm 105mm;
  grid-template-rows: repeat(3, 99mm);
  gap: 0;
  break-after: page;
  background: #fff;
  font-family: 'DM Sans', sans-serif;
  color: #111;
}

.page::before,
.page::after {
  content: '';
  position: absolute;
  box-sizing: border-box;
  pointer-events: none;
}

.page::before {
  top: 0;
  bottom: 0;
  left: calc(105mm - 0.1mm);
  width: 0.2mm;
  border-left: 0.2mm solid #999;
}

.page::after {
  left: 0;
  right: 0;
  top: calc(99mm - 0.1mm);
  height: calc(99mm + 0.2mm);
  border-top: 0.2mm solid #999;
  border-bottom: 0.2mm solid #999;
}

/* The content keeps away from the edges, where a printer may not print. */
.card {
  box-sizing: border-box;
  padding: 8mm;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: 2.5mm;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

/* Text is clamped to its lines, so a long title or class name, both valid,
   never pushes the QR code or the key out of the card. The title is an h2
   for screen readers, without the app's line over headings, which would
   print on every card. */
.title,
.round,
.band-head,
.how {
  margin: 0;
  max-width: 100%;
  overflow: hidden;
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-box-orient: vertical;
}

.title {
  padding: 0;
  border: 0;
  font-size: 12pt;
  font-weight: 700;
  line-height: 1.2;
  -webkit-line-clamp: 2;
}

.round,
.band-head {
  font-size: 10pt;
  line-height: 1.2;
  -webkit-line-clamp: 1;
}

/* A runoff card's band: a frame, which prints where a background would not. */
.band {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5mm;
  max-width: 100%;
  margin: 0;
  padding: 1mm 4mm;
  border: 0.6mm solid #111;
}

.band strong {
  font-size: 11pt;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.band-note {
  font-size: 8pt;
  line-height: 1.2;
}

.qr {
  width: 32mm;
  height: 32mm;
  flex-shrink: 0;
}

.key {
  font-family: 'JetBrains Mono', monospace;
  font-size: 14pt;
  letter-spacing: 0.04em;
  margin: 0;
  white-space: nowrap;
  flex-shrink: 0;
}

.how {
  font-size: 8.5pt;
  line-height: 1.3;
  -webkit-line-clamp: 2;
}

@media screen {
  .page {
    margin: 0 auto 8mm;
    box-shadow: 0 0 6px rgb(0 0 0 / 25%);
  }
}

@media print {
  .page {
    margin: 0;
    box-shadow: none;
  }
}

@page {
  size: A4 portrait;
  margin: 0;
}
</style>

<style>
/* The sheets are sized to A4 exactly, so the browser's default body margin
   would push them over the page edge in print: none while printing. Global,
   like the page size above. */
@media print {
  html,
  body {
    margin: 0;
    padding: 0;
  }
}
</style>
