<script setup lang="ts">
// Losentscheid eintragen: the officials drew, the page records the order
// drawn, exactly the tied set, with a reason; election-core's resolve on
// the server checks the set before anything is written, and the answer is
// the contest's outcome now. The software never draws.
//
// Each place says what the one drawn there gets, the last place fills
// itself once the others are chosen, and before anything is recorded the
// form says in one sentence what follows from the order, since a lot is
// recorded once and never changes.
import { computed, nextTick, ref, useId, watch } from 'vue'
import type { LotRequest, RulesetId } from '@school-election/election-core'
import { apiPost } from '../lib/api.ts'
import { errorMessage } from '../lib/api-rules.ts'
import { functionLabel, listed, type Names } from '../lib/outcome-text.ts'

const props = defineProps<{
  electionId: string
  contestId: string
  contestTitle: string
  rulesetId: RulesetId
  lot: LotRequest
  names: Names
}>()

const emit = defineEmits<{ recorded: [] }>()

const id = useId()
const order = ref<(string | null)[]>(props.lot.candidates.map(() => null))
const reason = ref('')
const busy = ref(false)
const error = ref<string | null>(null)
/** The order is complete and the form shows what follows from it, waiting for "Ja, eintragen". */
const checking = ref(false)
const summaryHeading = ref<HTMLElement | null>(null)

/** What the lot decides, for the form's name: two lots of one contest stay apart. */
const subject = computed(() => (props.lot.reason === 'runoff-entry' ? 'Stichwahl' : 'Positionen'))

/** The tied candidates still free for a place, and the one it holds. */
function offered(place: number): string[] {
  return props.lot.candidates.filter((candidate) => order.value[place] === candidate || !order.value.includes(candidate))
}

/** What the one drawn at `place` gets. */
function gets(place: number): string {
  const lot = props.lot
  if (lot.reason === 'runoff-entry') return place < lot.seats ? 'kommt in die Stichwahl' : 'kommt nicht in die Stichwahl'
  const position = lot.positions[place]
  return position === undefined ? 'keine dieser Positionen' : functionLabel(props.rulesetId, position)
}

// When a choice leaves one place open, the last tied candidate takes it.
// Only a choice: clearing a place to correct the order leaves it open.
const openPlaces = (places: readonly (string | null)[]): number => places.filter((candidate) => candidate === null).length
watch(() => [...order.value], (places, before) => {
  if (openPlaces(places) !== 1 || openPlaces(before) <= 1) return
  const left = props.lot.candidates.filter((candidate) => !places.includes(candidate))
  const index = places.indexOf(null)
  if (left.length === 1 && index >= 0) order.value[index] = left[0] ?? null
})

const complete = computed(() => order.value.every((candidate) => candidate !== null) && reason.value.trim() !== '')

/** What follows from the order, in one sentence. */
const consequence = computed(() => {
  const drawn = order.value.filter((candidate): candidate is string => candidate !== null).map(props.names.candidate)
  const lot = props.lot
  if (lot.reason === 'runoff-entry') {
    const enter = drawn.slice(0, lot.seats)
    const stay = drawn.slice(lot.seats)
    const sentence = `${listed(enter)} ${enter.length === 1 ? 'kommt' : 'kommen'} in die Stichwahl`
    return stay.length === 0 ? `${sentence}.` : `${sentence}; ${listed(stay)} nicht.`
  }
  return `${drawn.map((name, place) => `${gets(place)}: ${name}`).join('; ')}.`
})

async function check(): Promise<void> {
  if (!complete.value) return
  checking.value = true
  await nextTick()
  summaryHeading.value?.focus()
}

async function record(): Promise<void> {
  busy.value = true
  error.value = null
  try {
    await apiPost(`/api/elections/${props.electionId}/lots`, { contestId: props.contestId, lotId: props.lot.id, order: order.value, reason: reason.value.trim() })
    emit('recorded')
  } catch (err) {
    error.value = errorMessage(err)
    checking.value = false
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <form
    :aria-label="`Losentscheid eintragen: ${contestTitle} (${subject})`"
    @submit.prevent="check"
  >
    <template v-if="!checking">
      <div
        v-for="(candidate, place) in order"
        :key="place"
      >
        <label :for="`${id}-${place}`">{{ place + 1 }}. gezogen – {{ gets(place) }}</label>
        <select
          :id="`${id}-${place}`"
          v-model="order[place]"
          required
        >
          <option :value="null">
            – bitte wählen –
          </option>
          <option
            v-for="option in offered(place)"
            :key="option"
            :value="option"
          >
            {{ names.candidate(option) }}
          </option>
        </select>
      </div>
      <label :for="`${id}-reason`">Begründung</label>
      <textarea
        :id="`${id}-reason`"
        v-model="reason"
        maxlength="500"
        required
        placeholder="Los gezogen von der Wahlkommission am …"
      />
      <div class="actions">
        <button
          type="submit"
          :disabled="busy || !complete"
        >
          Losentscheid eintragen
        </button>
      </div>
    </template>
    <fieldset
      v-else
      class="card-box"
      :aria-labelledby="`${id}-summary`"
    >
      <p
        :id="`${id}-summary`"
        ref="summaryHeading"
        tabindex="-1"
      >
        <strong>{{ consequence }}</strong> Ein eingetragener Losentscheid lässt sich nicht mehr ändern.
      </p>
      <div class="actions">
        <button
          type="button"
          :disabled="busy"
          @click="record"
        >
          Ja, eintragen
        </button>
        <button
          type="button"
          class="secondary"
          :disabled="busy"
          @click="checking = false"
        >
          Ändern
        </button>
      </div>
    </fieldset>
    <p
      v-if="error"
      class="message error"
      role="alert"
    >
      {{ error }}
    </p>
  </form>
</template>
