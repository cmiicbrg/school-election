<script setup lang="ts">
// A batch of voting keys as sheets to print (components/CardSheets.vue:
// six cards to an A4 page, cut lines between them, a band on a runoff's
// cards); pages/PrintRound.vue prints every batch of a Wahlgang. The page
// shows the stored keys however often it is opened, so a sheet can be
// printed again, until the batch's round opens: once votes are accepted,
// nothing is printed any more. Opening it creates nothing. The browser
// prints or saves as PDF; the server renders no sheet and never holds one.
// The owner and co-admins may open it any time; a witness once the batch's
// round has closed, which the API decides.

import { computed, onMounted, ref } from 'vue'
import '@fontsource/dm-sans/400.css'
import '@fontsource/dm-sans/700.css'
import '@fontsource/jetbrains-mono/400.css'
import '../print-page.css'
import { formatKey, type Lifecycle, type RoundKind } from '@school-election/election-core'
import CardSheets from '../components/CardSheets.vue'
import PrintNotes from '../components/PrintNotes.vue'
import { apiGet } from '../lib/api.ts'
import { ApiError } from '../lib/api-rules.ts'
import { BASE_URL } from '../lib/base.ts'
import { usePageTitle } from '../lib/page-title.ts'
import { allDrawn, drawCodes } from '../lib/qr-images.ts'
import { cardsOf, pagesOf, printable, ROUND_LABELS, voterAddress } from '../lib/sheet.ts'

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
  forbidden: 'Die Codes dieses Stapels sind für Zeug:innen erst sichtbar, wenn ihr Wahlgang beendet ist.',
  not_found: 'Diesen Stapel gibt es nicht, oder der Wahltermin ist nicht Ihrer.',
}

const election = ref<ElectionDetail>()
const groupName = ref('')
const batch = ref<BatchKeys>()
const qr = ref(new Map<string, string>())
/** An issued batch with every card's QR image drawn: only then are the sheets shown and printable. */
const ready = ref(false)
const error = ref<string | null>(null)

// The cards name the app where this page was opened, base path included.
const cards = computed(() => batch.value ? cardsOf(batch.value.keys.map((entry) => entry.key), BASE_URL) : [])
/**
 * The codes as a list: for a replaced batch, which keeps them so its old
 * sheets can be compared, and for any batch once its round has closed,
 * when the API says which keys voted. Nothing is printed then.
 */
const usage = computed(() => {
  if (!batch.value) return null
  const known = batch.value.keys.some((entry) => entry.used !== null)
  if (batch.value.batch.state !== 'void' && !known) return null
  return { known, codes: batch.value.keys.map((entry) => ({ grouped: formatKey(entry.key), used: entry.used })) }
})
const usedCount = computed(() => usage.value?.codes.filter((entry) => entry.used === true).length ?? 0)
const pages = computed(() => pagesOf(cards.value))
const roundLabel = computed(() => batch.value ? ROUND_LABELS[batch.value.batch.roundKind] : '')
usePageTitle(() => ['Stimmkarten drucken', election.value?.title, roundLabel.value, groupName.value].filter(Boolean).join(' · '))
/** An issued batch whose round has not opened: the only kind with sheets. */
const prints = computed(() => batch.value !== undefined && election.value !== undefined
  && batch.value.batch.state === 'issued' && printable(election.value.lifecycle, batch.value.batch.roundKind))
const address = voterAddress(BASE_URL)

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
  // and a batch whose round has opened is not printed any more (once the
  // round has closed its codes are listed with their use instead): no
  // cards either way, and nothing to draw.
  if (!prints.value) return
  try {
    // The sheets appear, and can be printed, only once every image is there.
    qr.value = await drawCodes(cards.value)
    ready.value = allDrawn(cards.value, qr.value)
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
      <h1>Stimmkarten drucken</h1>
      <p v-if="election && batch">
        {{ election.title }} · {{ roundLabel }} · {{ groupName }} · {{ batch.batch.keys }} Karten auf {{ pages.length }} Seiten.
      </p>
      <PrintNotes v-if="prints" />
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
      Dieser Stapel gilt nicht mehr: Er wurde ersetzt, oder eine Änderung des Aufbaus hat seine Stimmkarten ungültig gemacht. Seine Codes wählen nicht; sie bleiben nur zum Vergleich mit den alten Stimmkarten.
    </output>
    <output
      v-else-if="batch && election && !prints && !usage"
      class="replaced"
      data-testid="not-printable"
    >
      Der Wahlgang hat begonnen: Die Stimmkarten dieses Stapels werden nicht mehr gedruckt.
    </output>

    <section
      v-if="usage && batch && election"
      class="usage"
      aria-labelledby="usage-heading"
    >
      <h2 id="usage-heading">
        {{ usage.known ? 'Codes und ihre Verwendung' : 'Codes dieses Stapels' }}
      </h2>
      <p v-if="usage.known">
        {{ election.title }} · {{ roundLabel }} · {{ groupName }}: {{ usedCount }} von {{ usage.codes.length }} Codes wurden verwendet. Der Wahlgang ist beendet; übrig gebliebene Stimmkarten müssen hier als „nicht verwendet“ erscheinen.
      </p>
      <p v-else>
        {{ election.title }} · {{ roundLabel }} · {{ groupName }}: {{ usage.codes.length }} Codes, zum Vergleich mit den alten Stimmkarten.
      </p>
      <table>
        <thead>
          <tr>
            <th scope="col">
              Code
            </th>
            <th
              v-if="usage.known"
              scope="col"
            >
              Verwendung
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="entry in usage.codes"
            :key="entry.grouped"
            data-testid="usage"
          >
            <td class="key">
              {{ entry.grouped }}
            </td>
            <td v-if="usage.known">
              {{ entry.used ? 'verwendet' : 'nicht verwendet' }}
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <CardSheets
      v-if="ready && prints && batch && election"
      :title="election.title"
      :round-kind="batch.batch.roundKind"
      :group-name="groupName"
      :cards="cards"
      :images="qr"
      :address="address"
    />
  </div>
</template>

<style scoped>
.usage {
  max-width: 210mm;
  margin: 0 auto;
  padding: 16px;
}

.usage table {
  border-collapse: collapse;
}

.usage th,
.usage td {
  text-align: left;
  padding: 4px 12px 4px 0;
  border-bottom: 1px solid #ddd;
}

.usage .key {
  font-family: 'JetBrains Mono', monospace;
}
</style>
