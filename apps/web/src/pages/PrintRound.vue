<script setup lang="ts">
// Every valid batch of a Wahlgang as one document to print, class after
// class in the termin's order, each starting on a sheet of its own
// (components/CardSheets.vue), so a school prints a Wahlgang's cards in
// one go rather than a print job per class. Like a single batch's page
// (pages/PrintBatch.vue) it reads the stored keys and creates nothing,
// and prints only until the Wahlgang opens; it reads each batch through
// the route that gives the owner and co-admins its keys.

import { computed, onMounted, ref } from 'vue'
import '@fontsource/dm-sans/400.css'
import '@fontsource/dm-sans/700.css'
import '../print-page.css'
import type { Lifecycle, RoundKind } from '@school-election/election-core'
import CardSheets from '../components/CardSheets.vue'
import PrintNotes from '../components/PrintNotes.vue'
import { apiGet } from '../lib/api.ts'
import { ApiError } from '../lib/api-rules.ts'
import { BASE_URL } from '../lib/base.ts'
import { usePageTitle } from '../lib/page-title.ts'
import { allDrawn, drawCodes } from '../lib/qr-images.ts'
import { cardsOf, pagesOf, printable, ROUND_LABELS, voterAddress, type Card } from '../lib/sheet.ts'
import type { BatchSummary } from '../lib/types.ts'

const props = defineProps<{
  id: string
  roundKind: string
}>()

interface ElectionDetail {
  title: string
  lifecycle: Lifecycle
}

interface Configuration {
  voterGroups: { id: string, name: string }[]
}

interface BatchKeys {
  batch: { state: 'issued' | 'void' }
  keys: { key: string }[]
}

interface Stack {
  batchId: string
  groupName: string
  cards: Card[]
}

const MESSAGES: Record<string, string> = {
  forbidden: 'Die Codes der Stimmkarten sind für Zeug:innen erst sichtbar, wenn ihr Wahlgang beendet ist.',
  not_found: 'Diesen Wahltermin gibt es nicht, oder er ist nicht Ihrer.',
}
const FAILED = 'Die Stimmkarten konnten nicht geladen werden.'

const kind = computed<RoundKind | null>(() => (props.roundKind === 'regular' || props.roundKind === 'runoff' ? props.roundKind : null))
const election = ref<ElectionDetail>()
const stacks = ref<Stack[]>([])
const qr = ref<ReadonlyMap<string, string>>(new Map())
/** Every card's QR image drawn: only then are the sheets shown and printable. */
const ready = ref(false)
const error = ref<string | null>(null)

const roundLabel = computed(() => (kind.value ? ROUND_LABELS[kind.value] : ''))
usePageTitle(() => ['Stimmkarten drucken', election.value?.title, roundLabel.value, 'alle Klassen'].filter(Boolean).join(' · '))
const prints = computed(() => election.value !== undefined && kind.value !== null && printable(election.value.lifecycle, kind.value))
const cardCount = computed(() => stacks.value.reduce((sum, stack) => sum + stack.cards.length, 0))
const pageCount = computed(() => stacks.value.reduce((sum, stack) => sum + pagesOf(stack.cards).length, 0))
const address = voterAddress(BASE_URL)

async function load(): Promise<void> {
  const round = kind.value
  if (round === null) {
    error.value = 'Diesen Wahlgang gibt es nicht.'
    return
  }
  try {
    const base = `/api/elections/${encodeURIComponent(props.id)}`
    const [detail, configuration, list] = await Promise.all([
      apiGet<ElectionDetail>(base),
      apiGet<Configuration>(`${base}/configuration`),
      apiGet<{ batches: BatchSummary[] }>(`${base}/batches`),
    ])
    election.value = detail
    if (!prints.value) return
    // Class after class, as the termin lists them; a class's top-ups after its first batch.
    const order = new Map(configuration.voterGroups.map((group, index) => [group.id, index]))
    const valid = list.batches
      .filter((batch) => batch.roundKind === round && batch.state === 'issued')
      .toSorted((a, b) => (order.get(a.voterGroupId) ?? 0) - (order.get(b.voterGroupId) ?? 0))
    const keys = await Promise.all(valid.map((batch) => apiGet<BatchKeys>(`${base}/batches/${encodeURIComponent(batch.id)}`)))
    // A batch replaced or voided between the list and its keys keeps them for comparing: none of them is printed.
    if (keys.some((answer) => answer.batch.state !== 'issued')) {
      error.value = 'Die Stimmkarten haben sich gerade geändert. Bitte die Seite neu laden.'
      return
    }
    stacks.value = valid.map((batch, index) => ({
      batchId: batch.id,
      groupName: configuration.voterGroups.find((group) => group.id === batch.voterGroupId)?.name ?? '',
      cards: cardsOf((keys[index]?.keys ?? []).map((entry) => entry.key), BASE_URL),
    }))
  } catch (err) {
    error.value = err instanceof ApiError ? MESSAGES[err.code] ?? FAILED : FAILED
    return
  }
  const cards = stacks.value.flatMap((stack) => stack.cards)
  if (cards.length === 0) return
  try {
    qr.value = await drawCodes(cards)
    ready.value = allDrawn(cards, qr.value)
    if (!ready.value) error.value = 'Die QR-Codes konnten nicht erzeugt werden.'
  } catch {
    error.value = 'Die QR-Codes konnten nicht erzeugt werden.'
  }
}

function print(): void {
  window.print()
}

onMounted(() => {
  void load()
})
</script>

<template>
  <div class="print-page">
    <header class="screen-only">
      <h1>Alle Stimmkarten drucken</h1>
      <p v-if="election && stacks.length > 0">
        {{ election.title }} · {{ roundLabel }} · {{ stacks.length === 1 ? '1 Stapel' : `${stacks.length} Stapel` }}, {{ cardCount }} Karten auf {{ pageCount }} Seiten. Jeder Stapel beginnt auf einem neuen Blatt.
      </p>
      <PrintNotes
        v-if="prints && stacks.length > 0"
        all
      />
      <p
        v-if="error"
        role="alert"
      >
        {{ error }}
      </p>
      <output
        v-else-if="prints && stacks.length > 0 && !ready"
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
      v-if="election && !error && !prints"
      class="replaced"
      data-testid="not-printable"
    >
      Der Wahlgang hat begonnen: Seine Stimmkarten werden nicht mehr gedruckt.
    </output>
    <output
      v-else-if="election && !error && stacks.length === 0"
      class="replaced"
    >
      Für {{ kind === 'runoff' ? 'die Stichwahl' : 'den 1. Wahlgang' }} gibt es noch keine gültigen Stimmkarten.
    </output>

    <template v-if="ready && prints && election && kind">
      <CardSheets
        v-for="stack in stacks"
        :key="stack.batchId"
        :title="election.title"
        :round-kind="kind"
        :group-name="stack.groupName"
        :cards="stack.cards"
        :images="qr"
        :address="address"
      />
    </template>
  </div>
</template>
