<script setup lang="ts">
// A batch of voting keys as sheets to print: six cards to an A4 page, each
// with the election, the round, the class, a QR code and the key. The page
// shows the stored keys however often it is opened, so a sheet can be
// printed again, until the batch's round opens: once votes are accepted,
// nothing is printed any more. Opening it creates nothing. The browser
// prints or saves as PDF; the server renders no sheet and never holds one.
// The owner and co-admins may open it any time; a witness once the batch's
// round has closed, which the API decides.

import QRCode from 'qrcode'
import { computed, onMounted, ref } from 'vue'
import '@fontsource/dm-sans/400.css'
import '@fontsource/dm-sans/700.css'
import '@fontsource/jetbrains-mono/400.css'
import type { Lifecycle, RoundKind } from '@school-election/election-core'
import { apiGet } from '../lib/api.ts'
import { ApiError } from '../lib/api-rules.ts'
import { cardsOf, pagesOf, printable, ROUND_LABELS, voterAddress, type Card } from '../lib/sheet.ts'

const props = defineProps<{
  id: string
  batchId: string
}>()

interface ElectionDetail {
  title: string
  lifecycle: Lifecycle
}

interface Configuration {
  voterGroups: { id: string, name: string }[]
}

interface BatchKeys {
  batch: { id: string, voterGroupId: string, roundKind: RoundKind, state: 'issued' | 'void', keys: number }
  keys: { key: string, used: boolean | null }[]
}

const MESSAGES: Record<string, string> = {
  forbidden: 'Die Codes dieses Stapels sind für Zeuginnen und Zeugen erst sichtbar, wenn die Runde geschlossen ist.',
  not_found: 'Diesen Stapel gibt es nicht, oder die Wahl ist nicht Ihre.',
}

const election = ref<ElectionDetail>()
const groupName = ref('')
const batch = ref<BatchKeys>()
const qr = ref(new Map<string, string>())
/** An issued batch with every card's QR image drawn: only then are the sheets shown and printable. */
const ready = ref(false)
const error = ref<string | null>(null)
const origin = window.location.origin

const cards = computed(() => batch.value ? cardsOf(batch.value.keys.map((entry) => entry.key), origin) : [])
const pages = computed(() => pagesOf(cards.value))
const roundLabel = computed(() => batch.value ? ROUND_LABELS[batch.value.batch.roundKind] : '')
/** An issued batch whose round has not opened: the only kind with sheets. */
const prints = computed(() => batch.value !== undefined && election.value !== undefined
  && batch.value.batch.state === 'issued' && printable(election.value.lifecycle, batch.value.batch.roundKind))
const address = voterAddress(origin)

async function load(): Promise<void> {
  try {
    const base = `/api/elections/${encodeURIComponent(props.id)}`
    const [detail, configuration, keys] = await Promise.all([
      apiGet<ElectionDetail>(base),
      apiGet<Configuration>(`${base}/configuration`),
      apiGet<BatchKeys>(`${base}/batches/${encodeURIComponent(props.batchId)}`),
    ])
    election.value = detail
    groupName.value = configuration.voterGroups.find((group) => group.id === keys.batch.voterGroupId)?.name ?? ''
    batch.value = keys
  } catch (err) {
    error.value = err instanceof ApiError ? MESSAGES[err.code] ?? 'Die Stimmkarten konnten nicht geladen werden.' : 'Die Stimmkarten konnten nicht geladen werden.'
    return
  }
  // A replaced batch keeps its keys for comparing, but they never vote,
  // and a batch whose round has opened is not printed any more: no cards
  // either way, and nothing to draw.
  if (!prints.value) return
  try {
    // One image per key, drawn here: the policy allows data: images. The
    // sheets appear, and can be printed, only once every image is there.
    const drawn = await Promise.all(cards.value.map(async (card): Promise<[string, string]> =>
      [card.key, await QRCode.toDataURL(card.url, { errorCorrectionLevel: 'M', margin: 0, width: 320 })]))
    qr.value = new Map(drawn)
    ready.value = drawn.every(([, image]) => image !== '')
    if (!ready.value) error.value = 'Die QR-Codes konnten nicht erzeugt werden.'
  } catch {
    error.value = 'Die QR-Codes konnten nicht erzeugt werden.'
  }
}

function image(card: Card): string {
  return qr.value.get(card.key) ?? ''
}

function print(): void {
  window.print()
}

onMounted(() => {
  void load()
})
</script>

<template>
  <div class="print-batch">
    <header class="screen-only">
      <h1>Stimmkarten drucken</h1>
      <p v-if="election && batch">
        {{ election.title }} · {{ roundLabel }} · {{ groupName }} · {{ batch.batch.keys }} Karten auf {{ pages.length }} Seiten.
      </p>
      <p v-if="prints">
        Diese Seite zeigt immer dieselben Codes. Sie kann bis zum Beginn der Runde noch einmal gedruckt werden; neue Codes gibt es nur über „Stapel ersetzen“ in der Wahl.
      </p>
      <p
        v-if="error"
        role="alert"
      >
        {{ error }}
      </p>
      <output
        v-else-if="prints && !ready"
        class="note"
      >
        Die Stimmkarten werden vorbereitet …
      </output>
      <button
        v-if="ready"
        type="button"
        @click="print"
      >
        Drucken
      </button>
    </header>

    <output
      v-if="batch && batch.batch.state === 'void'"
      class="replaced"
    >
      Dieser Stapel wurde ersetzt. Seine Codes gelten nicht mehr; die neuen Stimmkarten sind der Stapel, der an seine Stelle getreten ist.
    </output>
    <output
      v-else-if="batch && election && !prints"
      class="replaced"
      data-testid="not-printable"
    >
      Die Runde hat begonnen: Die Stimmkarten dieses Stapels werden nicht mehr gedruckt.
    </output>

    <template v-if="ready && prints && batch && election">
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
            {{ election.title }}
          </h2>
          <p class="round">
            {{ roundLabel }} · {{ groupName }}
          </p>
          <img
            :src="image(card)"
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
  </div>
</template>

<style scoped>
.print-batch {
  font-family: 'DM Sans', sans-serif;
  color: #111;
}

header {
  max-width: 210mm;
  margin: 0 auto;
  padding: 16px;
}

header button {
  font: inherit;
  font-size: 1.1rem;
  padding: 0.5rem 1.25rem;
}

/* An <output> is inline by default; these are paragraphs that announce themselves. */
.note,
.replaced {
  display: block;
}

.replaced {
  max-width: 210mm;
  margin: 0 auto;
  padding: 16px;
  color: #8a1c1c;
  font-weight: 700;
}

.page {
  box-sizing: border-box;
  width: 210mm;
  height: 297mm;
  padding: 10mm;
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-template-rows: repeat(3, 1fr);
  gap: 0;
  break-after: page;
  background: #fff;
}

.card {
  box-sizing: border-box;
  border: 0.3mm dashed #888;
  padding: 5mm;
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
   never pushes the QR code or the key out of the card. */
.title,
.round,
.how {
  margin: 0;
  max-width: 100%;
  overflow: hidden;
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-box-orient: vertical;
}

.title {
  font-size: 12pt;
  font-weight: 700;
  line-height: 1.2;
  -webkit-line-clamp: 2;
}

.round {
  font-size: 10pt;
  line-height: 1.2;
  -webkit-line-clamp: 1;
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
  .screen-only {
    display: none;
  }

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
