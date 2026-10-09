<script setup lang="ts">
// One election, in its steps: Einrichten, Mitglieder, Vorbereiten,
// Stimmkarten and the Wahltag with its Probelauf, each a card, and the
// result on its own page. Beside them the steps' list says which is done
// and which is now, with a line each on where it stands; on a phone it is
// a strip under the title that opens the list. A step marked done
// collapses to one line that says what it holds (lib/steps.ts). Until a
// run starts the cards stand in their order; once a Probelauf runs or the
// 1. Wahlgang has opened, the day comes first. The page reads everything
// it shows from the API, and again after every change a section reports;
// what each section may offer comes from the caller's permissions and the
// lifecycle.

import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import DeleteElection from '../components/DeleteElection.vue'
import LineIcon from '../components/LineIcon.vue'
import MembersSection from '../components/MembersSection.vue'
import PrepareSection from '../components/PrepareSection.vue'
import RunSection from '../components/RunSection.vue'
import SetupSection from '../components/SetupSection.vue'
import SheetsSection from '../components/SheetsSection.vue'
import StepNav from '../components/StepNav.vue'
import StepSection from '../components/StepSection.vue'
import VotingAddress from '../components/VotingAddress.vue'
import { apiGet } from '../lib/api.ts'
import { errorMessage, isTransient, retryDelay } from '../lib/api-rules.ts'
import { requiredItems } from '../lib/checklist.ts'
import { ROLE_LABELS, ROUND_LABELS, stateLabel } from '../lib/labels.ts'
import { usePageTitle } from '../lib/page-title.ts'
import { setupRules } from '../lib/setup-rules.ts'
import { collapsed, sectionOrder, STEP_LABELS, STEP_NUMBERS, stepStates, stepStatus, STEPS, useStepMarks, type Markable, type Step } from '../lib/steps.ts'
import type { BatchSummary, Configuration, ElectionDetail, Member, Preparation } from '../lib/types.ts'

const props = defineProps<{ id: string }>()

const election = ref<ElectionDetail>()
usePageTitle(() => election.value?.title ?? 'Wahltermin')
const configuration = ref<Configuration>()
const members = ref<Member[]>()
const preparation = ref<Preparation>()
const batches = ref<BatchSummary[]>()
const error = ref<string | null>(null)

const rules = computed(() => election.value ? setupRules(election.value.lifecycle, election.value.permissions) : undefined)
const { marks, mark } = useStepMarks(() => props.id)
const states = computed(() => election.value ? stepStates(election.value.lifecycle, marks.value) : undefined)
const isCollapsed = (step: Markable): boolean => election.value !== undefined && collapsed(step, election.value.lifecycle, marks.value)
const toggle = (step: Markable): void => mark(step, !isCollapsed(step))
/** The cards in the order the page shows them. */
const order = computed(() => election.value ? sectionOrder(election.value.lifecycle, isCollapsed) : [])
const draft = computed(() => election.value?.state === 'draft')
const testing = computed(() => election.value?.lifecycle.regular === 'testing')

/** Each step's line in the steps' list. */
const statuses = computed(() => {
  const lifecycle = election.value?.lifecycle
  if (!lifecycle || !configuration.value) return undefined
  const names = { contest: () => '', group: () => '' }
  const facts = {
    lifecycle,
    contests: configuration.value.contests.length,
    groups: configuration.value.voterGroups.length,
    members: members.value?.length ?? 0,
    missing: requiredItems(preparation.value?.problems ?? [], names).filter((item) => !item.done).length,
    batches: (batches.value ?? []).filter((batch) => batch.state === 'issued').length,
  }
  return Object.fromEntries(STEPS.map((step) => [step, stepStatus(step, facts)])) as Record<Step, string>
})
/** The step the strip on a phone names: the current one, or the result once all are done. */
const current = computed<Step>(() => STEPS.find((step) => states.value?.[step] === 'current') ?? 'ergebnis')

/** The colour of the state's chip in the head. */
const tone = computed(() => {
  const lifecycle = election.value?.lifecycle
  if (!lifecycle) return 'neutral'
  if (lifecycle.election === 'final') return 'ok'
  if (lifecycle.regular === 'testing') return 'test'
  if (lifecycle.election === 'draft') return 'neutral'
  if (lifecycle.regular === 'open' || lifecycle.runoff === 'open') return 'live'
  return lifecycle.regular === 'closed' ? 'ok' : 'info'
})

const strip = ref<HTMLDetailsElement | null>(null)
/** A step chosen in the strip: the strip closes, the step's card is in view. */
function closeStrip(): void {
  if (strip.value) strip.value.open = false
}

/** From the banner to the running Probelauf, with the focus on its heading. */
function toProbelauf(): void {
  const heading = document.getElementById('probelauf-heading')
  heading?.scrollIntoView({ block: 'start' })
  heading?.focus({ preventScroll: true })
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? `1 ${one}` : `${n} ${many}`)
const nameOf = (member: Member): string => member.displayName ?? member.email ?? ''
/** Everyone of the termin with their role, for the members' collapsed section. */
const membersSummary = computed(() => (members.value ?? []).map((member) => `${nameOf(member)} (${ROLE_LABELS[member.role]})`).join(', '))

/** What the setup holds, for its collapsed section: each Wahl with its candidates, and the classes. */
const setupSummary = computed(() => [
  ...(configuration.value?.contests ?? []).map((contest) => {
    const counted = `${contest.title} (${plural(contest.candidates.length, 'Kandidat:in', 'Kandidat:innen')})`
    const names = contest.candidates.map((candidate) => `${candidate.givenName} ${candidate.surname}`).join(', ')
    return names === '' ? counted : `${counted}: ${names}`
  }),
  `Klassen und Gruppen: ${(configuration.value?.voterGroups ?? []).map((group) => group.name).join(', ') || 'keine'}`,
])
/** The valid cards per class of each Wahlgang that has any, for the cards' collapsed section. */
const cardsSummary = computed(() => (['regular', 'runoff'] as const).flatMap((kind) => {
  const perClass = (configuration.value?.voterGroups ?? [])
    .map((group) => ({ name: group.name, keys: (batches.value ?? []).filter((batch) => batch.voterGroupId === group.id && batch.roundKind === kind && batch.state === 'issued').reduce((sum, batch) => sum + batch.keys, 0) }))
    .filter((entry) => entry.keys > 0)
  const listed = perClass.map((entry) => `${entry.name} ${entry.keys}`).join(', ')
  return perClass.length === 0 ? [] : [`${ROUND_LABELS[kind]}: ${listed} Stimmkarten`]
}))

/** Who leads the termin, for the members who do not. */
const lead = computed(() => {
  const owner = members.value?.find((member) => member.role === 'owner')
  return owner?.displayName ?? owner?.email ?? null
})

// Each load is numbered: a load that is no longer the newest, because the
// id changed or another change reloaded meanwhile, changes nothing.
let loads = 0

// A load that fails for the connection or the server is tried again after
// a growing pause, and what the page showed stays meanwhile, marked as not
// current: an election day's page does not go blank for a dropped
// connection. A refusal ends the page as before.
const offline = ref(false)
let attempts = 0
let retry: ReturnType<typeof setTimeout> | undefined

function stopRetrying(): void {
  clearTimeout(retry)
  retry = undefined
  attempts = 0
  offline.value = false
}

async function load(): Promise<void> {
  const current = ++loads
  clearTimeout(retry)
  const base = `/api/elections/${props.id}`
  try {
    const [detail, config, memberList, prep, batchList] = await Promise.all([
      apiGet<ElectionDetail>(base),
      apiGet<Configuration>(`${base}/configuration`),
      apiGet<Member[]>(`${base}/members`),
      apiGet<Preparation>(`${base}/preparation`),
      apiGet<{ batches: BatchSummary[] }>(`${base}/batches`),
    ])
    if (current !== loads) return
    election.value = detail
    configuration.value = config
    members.value = memberList
    preparation.value = prep
    batches.value = batchList.batches
    error.value = null
    stopRetrying()
  } catch (err) {
    if (current !== loads) return
    if (isTransient(err)) {
      offline.value = true
      retry = setTimeout(() => void load(), retryDelay(attempts++))
    } else {
      stopRetrying()
      error.value = errorMessage(err)
    }
  }
}

function clear(): void {
  election.value = undefined
  configuration.value = undefined
  members.value = undefined
  preparation.value = undefined
  batches.value = undefined
  error.value = null
  stopRetrying()
}

onMounted(() => {
  void load()
})
// Another election under the same page: nothing of the previous one stays
// on view, so no click can reach it while the new one loads.
watch(() => props.id, () => {
  clear()
  void load()
})

function reload(): void {
  void load()
}

// A deleted termin: the page lets go of it first, so the leave guards of
// its sections go with them and nothing typed there can hold the page on a
// termin that is gone, then it goes to the list.
const router = useRouter()
async function deleted(): Promise<void> {
  loads++
  clear()
  await nextTick()
  await router.push('/')
}

// Leaving the page ends its loads: one still on its way changes nothing
// and schedules no retry when it fails.
onUnmounted(() => {
  loads++
  clearTimeout(retry)
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
  <div
    v-else-if="election && configuration && members && preparation && batches && rules && states && statuses"
    class="termin"
  >
    <p
      v-if="testing"
      class="banner"
    >
      <LineIcon name="flask" />
      <span><strong>Probelauf läuft.</strong> Stimmen zählen nicht, und nichts bleibt.</span>
      <a
        href="#probelauf"
        @click.prevent="toProbelauf"
      >Zum Probelauf</a>
    </p>
    <div class="head">
      <div class="head-text">
        <p class="status">
          <span :class="['chip', tone]">{{ stateLabel(election.lifecycle) }}</span><span class="visually-hidden"> · </span>Ihre Rolle: {{ ROLE_LABELS[election.role] }}<template v-if="lead && election.role !== 'owner'">
            · {{ ROLE_LABELS.owner }}: {{ lead }}
          </template>
        </p>
        <h1>{{ election.title }}</h1>
        <p
          v-if="election.description"
          class="description"
        >
          {{ election.description }}
        </p>
      </div>
      <nav
        aria-label="Seiten des Wahltermins"
        class="pages"
      >
        <RouterLink
          v-if="election.lifecycle.regular === 'closed'"
          :to="`/wahlen/${election.id}/ergebnis`"
          class="button secondary"
        >
          <LineIcon name="chart" />Ergebnis und Herleitung
        </RouterLink>
        <RouterLink
          :to="`/wahlen/${election.id}/protokoll`"
          class="button secondary"
        >
          <LineIcon name="page" />Protokoll
        </RouterLink>
        <RouterLink
          to="/hilfe/wahltag"
          class="button secondary"
        >
          <LineIcon name="clock" />Ablauf am Wahltag
        </RouterLink>
      </nav>
    </div>
    <output
      v-if="offline"
      class="message warning"
    >
      Verbindung unterbrochen – neuer Versuch … Was hier steht, ist der letzte Stand.
    </output>
    <details
      ref="strip"
      class="strip"
    >
      <summary>
        <span
          class="strip-mark"
          aria-hidden="true"
        >{{ STEP_NUMBERS[current] }}</span>
        <span class="strip-text">
          <span class="strip-over">Schritt {{ STEP_NUMBERS[current] }} von {{ STEPS.length }}</span>
          <span><strong>{{ STEP_LABELS[current] }}</strong><span
            v-if="statuses[current]"
            class="muted"
          > · {{ statuses[current] }}</span></span>
        </span>
        <LineIcon
          class="strip-chevron"
          name="chevron-down"
          :size="18"
        />
      </summary>
      <div class="strip-panel">
        <StepNav
          :election-id="election.id"
          :states="states"
          :statuses="statuses"
          :result-ready="election.lifecycle.regular === 'closed'"
          @went="closeStrip"
        />
        <VotingAddress v-if="election.state !== 'final'" />
      </div>
    </details>
    <div class="layout">
      <aside class="side">
        <StepNav
          :election-id="election.id"
          :states="states"
          :statuses="statuses"
          :result-ready="election.lifecycle.regular === 'closed'"
        />
        <VotingAddress v-if="election.state !== 'final'" />
      </aside>
      <div class="sections">
        <template
          v-for="section in order"
          :key="section"
        >
          <StepSection
            v-if="section === 'einrichten'"
            id="einrichten"
            title="Einrichten"
            :number="1"
            :collapsed="isCollapsed('einrichten')"
            @toggle="toggle('einrichten')"
          >
            <template #summary>
              <ul class="lines">
                <li
                  v-for="line in setupSummary"
                  :key="line"
                >
                  {{ line }}
                </li>
              </ul>
            </template>
            <SetupSection
              :election="election"
              :configuration="configuration"
              :rules="rules"
              @changed="reload"
            />
          </StepSection>
          <StepSection
            v-else-if="section === 'mitglieder'"
            id="mitglieder"
            title="Mitglieder"
            :number="2"
            :collapsed="isCollapsed('mitglieder')"
            @toggle="toggle('mitglieder')"
          >
            <template #summary>
              <p>{{ membersSummary }}</p>
            </template>
            <MembersSection
              :election-id="election.id"
              :members="members"
              :witnesses="rules.witnesses"
              :co-admins="rules.coAdmins"
              :lead="rules.lead"
              :final="election.state === 'final'"
              @changed="reload"
            />
          </StepSection>
          <StepSection
            v-else-if="section === 'vorbereiten'"
            id="vorbereiten"
            title="Vorbereiten"
            :number="3"
            :collapsed="isCollapsed('vorbereiten')"
            @toggle="toggle('vorbereiten')"
          >
            <template #summary>
              <p>{{ election.state === 'draft' ? 'Noch nicht vorbereitet.' : 'Vorbereitet: welche Klassen in welchen Wahlen wählen, steht fest.' }}</p>
            </template>
            <PrepareSection
              :election-id="election.id"
              :preparation="preparation"
              :configuration="configuration"
              :rules="rules"
              :prepared="election.state !== 'draft'"
              @changed="reload"
            />
          </StepSection>
          <StepSection
            v-else-if="section === 'stimmkarten'"
            id="stimmkarten"
            title="Stimmkarten"
            :number="4"
            :locked="draft"
            :collapsed="draft ? null : isCollapsed('stimmkarten')"
            @toggle="toggle('stimmkarten')"
          >
            <template #summary>
              <ul class="lines">
                <li
                  v-for="line in cardsSummary"
                  :key="line"
                >
                  {{ line }}
                </li>
                <li v-if="cardsSummary.length === 0">
                  Noch keine Stimmkarten.
                </li>
              </ul>
            </template>
            <SheetsSection
              :election-id="election.id"
              :configuration="configuration"
              :batches="batches"
              :rules="rules"
              :role="election.role"
              :lifecycle="election.lifecycle"
              @changed="reload"
            />
          </StepSection>
          <StepSection
            v-else
            id="wahltag"
            title="Wahltag"
            :number="6"
            :locked="draft"
            :collapsed="null"
          >
            <RunSection
              :election="election"
              :configuration="configuration"
              :batches="batches"
              :probelauf-done="isCollapsed('probelauf')"
              @changed="reload"
              @probelauf="(done) => mark('probelauf', done)"
            />
          </StepSection>
        </template>
        <DeleteElection
          v-if="rules.remove"
          :election-id="election.id"
          :title="election.title"
          @deleted="deleted"
        />
      </div>
    </div>
  </div>
  <p
    v-else
    class="muted"
  >
    {{ offline ? 'Verbindung unterbrochen – neuer Versuch …' : 'Wird geladen …' }}
  </p>
</template>

<style scoped>
.termin {
  container: termin / inline-size;
}

.banner {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  margin: 0 0 20px;
  padding: 10px 16px;
  border: 1px solid var(--warn-line);
  border-radius: 12px;
  background: var(--warn-bg);
  color: var(--warn);
}

.banner span {
  flex: 1 1 280px;
}

.banner a {
  color: var(--warn);
  font-weight: 600;
}

.head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  margin: 8px 0 24px;
}

.status {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  margin: 0 0 8px;
  color: var(--muted);
  font-size: 0.9rem;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 0.8rem;
  font-weight: 600;
}

.chip::before {
  content: '';
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentcolor;
}

.chip.neutral {
  background: var(--soft);
  color: var(--ink2);
}

.chip.info,
.chip.live {
  background: var(--info-bg);
  color: var(--info);
}

.chip.test {
  background: var(--warn-bg);
  color: var(--warn);
}

.chip.ok {
  background: var(--ok-bg);
  color: var(--ok);
}

h1 {
  margin: 0;
  font-size: 2rem;
  line-height: 1.15;
}

.description {
  margin: 6px 0 0;
  color: var(--ink2);
  white-space: pre-line;
}

.pages {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.layout {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 32px;
}

.side {
  flex: 1 1 220px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.sections {
  flex: 999 1 560px;
  min-width: 0;
}

/* Margins, not a gap: collapsed cards that follow each other join. */
.sections > * + * {
  margin-top: 20px;
}

.lines {
  padding-left: 1.2em;
}

.strip {
  display: none;
  margin: 0 0 20px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--paper);
}

.strip > summary {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 48px;
  padding: 10px 14px;
  cursor: pointer;
  list-style: none;
}

.strip > summary::-webkit-details-marker {
  display: none;
}

.strip-mark {
  flex: none;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--accent);
  color: var(--accent-ink);
  font-size: 0.8rem;
  font-weight: 700;
}

.strip-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.strip-over {
  color: var(--accent);
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.strip-chevron {
  margin-left: auto;
  transition: transform 0.15s;
}

.strip[open] .strip-chevron {
  transform: rotate(180deg);
}

.strip-panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 8px 8px 14px;
  border-top: 1px solid var(--line);
}

@media (prefers-reduced-motion: reduce) {
  .strip-chevron {
    transition: none;
  }
}

@container termin (width < 760px) {
  .side {
    display: none;
  }

  .strip {
    display: block;
  }

  h1 {
    font-size: 1.6rem;
  }
}
</style>
