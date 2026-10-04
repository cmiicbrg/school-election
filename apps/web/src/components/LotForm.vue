<script setup lang="ts">
// Losentscheid eintragen: the officials drew, the page records the order
// drawn, exactly the tied set, with a reason; election-core's resolve on
// the server checks the set before anything is written, and the answer is
// the contest's outcome now. The software never draws.

import { computed, ref, useId } from 'vue'
import type { LotRequest } from '@school-election/election-core'
import { apiPost } from '../lib/api.ts'
import { errorMessage } from '../lib/api-rules.ts'
import type { Names } from '../lib/outcome-text.ts'

const props = defineProps<{
  electionId: string
  contestId: string
  lot: LotRequest
  names: Names
}>()

const emit = defineEmits<{ recorded: [] }>()

const id = useId()
const order = ref<(string | null)[]>(props.lot.candidates.map(() => null))
const reason = ref('')
const busy = ref(false)
const error = ref<string | null>(null)

/** The tied candidates still free for a place, and the one it holds. */
function offered(place: number): string[] {
  return props.lot.candidates.filter((candidate) => order.value[place] === candidate || !order.value.includes(candidate))
}

const complete = computed(() => order.value.every((candidate) => candidate !== null) && reason.value.trim() !== '')

async function record(): Promise<void> {
  busy.value = true
  error.value = null
  try {
    await apiPost(`/api/elections/${props.electionId}/lots`, { contestId: props.contestId, lotId: props.lot.id, order: order.value, reason: reason.value.trim() })
    emit('recorded')
  } catch (err) {
    error.value = errorMessage(err)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <form
    :aria-label="`Losentscheid eintragen: ${lot.id}`"
    @submit.prevent="record"
  >
    <div
      v-for="(candidate, place) in order"
      :key="place"
    >
      <label :for="`${id}-${place}`">{{ place + 1 }}. gezogen</label>
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
    <p
      v-if="error"
      class="message error"
      role="alert"
    >
      {{ error }}
    </p>
    <div class="actions">
      <button
        type="submit"
        :disabled="busy || !complete"
      >
        Losentscheid eintragen
      </button>
    </div>
  </form>
</template>
