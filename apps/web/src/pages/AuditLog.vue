<script setup lang="ts">
// Protokoll: every administrative step of the election, in order, as a
// sentence with who and when, and whether the chain of hashes holds
// together, with its last hash, which a witness can note down and compare
// later: the check proves that the chain is consistent in itself, and
// only a hash kept elsewhere proves that nothing was changed or cut off
// since (apps/api/lib/audit-chain.ts). For every member, witnesses
// included, at any time; read again every five seconds while the page is
// open, a final election's included, since an export appends to the log
// at any time. Nothing of a voter is in it: the log records
// administration, never voting.

import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { apiGet } from '../lib/api.ts'
import { errorMessage } from '../lib/api-rules.ts'
import { eventText, type AuditNames } from '../lib/audit-labels.ts'
import { dateTime } from '../lib/outcome-text.ts'
import { usePageTitle } from '../lib/page-title.ts'
import type { AuditLog, Configuration, ElectionDetail } from '../lib/types.ts'

const props = defineProps<{ id: string }>()

const election = ref<ElectionDetail>()
usePageTitle(() => (election.value ? `Protokoll: ${election.value.title}` : 'Protokoll'))
const configuration = ref<Configuration>()
const audit = ref<AuditLog>()
const error = ref<string | null>(null)

let loads = 0

async function load(): Promise<void> {
  const current = ++loads
  const base = `/api/elections/${props.id}`
  try {
    const [detail, config, log] = await Promise.all([apiGet<ElectionDetail>(base), apiGet<Configuration>(`${base}/configuration`), apiGet<AuditLog>(`${base}/audit`)])
    if (current !== loads) return
    election.value = detail
    configuration.value = config
    audit.value = log
    error.value = null
  } catch (err) {
    if (current === loads) error.value = errorMessage(err)
  }
}

const EVERY_MS = 5000
let timer: ReturnType<typeof setInterval> | undefined
let reading = false

/** The election and its log read again, once at a time, for as long as the page is open. */
async function follow(): Promise<void> {
  if (reading) return
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
  audit.value = undefined
  void load()
})

const names = computed<AuditNames>(() => {
  const contests = new Map(configuration.value?.contests.map((contest) => [contest.id, contest.title]) ?? [])
  const candidates = new Map(configuration.value?.contests.flatMap((contest) => contest.candidates.map((candidate) => [candidate.id, `${candidate.givenName} ${candidate.surname}`])) ?? [])
  const groups = new Map(configuration.value?.voterGroups.map((group) => [group.id, group.name]) ?? [])
  // A row removed since is named by its id: the log keeps what the configuration no longer has.
  return {
    contest: (id) => contests.get(id) ?? id,
    candidate: (id) => candidates.get(id) ?? id,
    group: (id) => groups.get(id) ?? id,
  }
})

const chainText = computed(() => {
  const chain = audit.value?.chain
  if (!chain) return ''
  if (chain.valid) return `Die Protokollkette ist in sich schlüssig: ${chain.length} Einträge, jeder mit der Prüfsumme des vorigen. Letzte Prüfsumme: ${chain.head ?? 'keine'}. Nur der Vergleich mit einer früher notierten Prüfsumme zeigt, dass seither nichts verändert oder entfernt wurde.`
  return `Die Protokollkette ist unterbrochen bei Eintrag ${chain.index + 1}: ${chain.problem}. Bitte die Betreiber:in verständigen.`
})
</script>

<template>
  <p
    v-if="error"
    class="message error"
    role="alert"
  >
    {{ error }}
  </p>
  <template v-else-if="election && audit">
    <h1>Protokoll: {{ election.title }}</h1>
    <p class="muted">
      <RouterLink :to="`/wahlen/${election.id}`">
        Zum Wahltermin
      </RouterLink>
      ·
      <RouterLink :to="`/wahlen/${election.id}/ergebnis`">
        Ergebnis
      </RouterLink>
    </p>
    <p
      :class="['message', audit.chain.valid ? 'ok' : 'error']"
      data-testid="chain"
    >
      {{ chainText }}
    </p>
    <p class="muted">
      Das Protokoll hält fest, wer den Wahltermin wann eingerichtet und vorbereitet, wer die Wahlgänge geöffnet und beendet und wer das Ergebnis festgestellt hat. Es enthält nichts über einzelne Stimmen oder Stimmkarten.
    </p>
    <ol
      class="plain"
      aria-label="Protokoll"
    >
      <li
        v-for="event in audit.events"
        :key="event.seq"
      >
        <span class="muted">{{ dateTime(event.at) }} · {{ event.actor.name }}</span><br>
        {{ eventText(event.action, event.metadata, names) }}
      </li>
    </ol>
  </template>
  <p
    v-else
    class="muted"
  >
    Wird geladen …
  </p>
</template>

<style scoped>
.message {
  word-break: break-all;
}
</style>
