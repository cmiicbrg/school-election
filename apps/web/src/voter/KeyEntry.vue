<script setup lang="ts">
// The code from the card, typed: where the card has it, shown as the card
// prints it while typing, checked here for its length, its symbols and its
// check symbol before anything is sent, and handed up as typed. The page's
// message, a refusal of the code or an ended session, is shown in the same
// place.

import { computed, onMounted, ref } from 'vue'
import { groupedKey, keyHint } from './voter-rules.ts'

const props = defineProps<{
  message: string | null
  busy: boolean
}>()

const emit = defineEmits<{
  submit: [key: string]
}>()

const input = ref('')
const field = ref<HTMLInputElement | null>(null)
const problem = ref<string | null>(null)
const grouped = computed(() => groupedKey(input.value))
const shown = computed(() => problem.value ?? props.message)

onMounted(() => field.value?.focus())

function submit(): void {
  const hint = keyHint(input.value)
  problem.value = hint
  if (hint === null) emit('submit', input.value)
}
</script>

<template>
  <form
    class="key-entry"
    aria-labelledby="voter-heading"
    @submit.prevent="submit"
  >
    <h1
      id="voter-heading"
      tabindex="-1"
    >
      Stimmabgabe
    </h1>
    <p>Geben Sie den Code von Ihrer Stimmkarte ein.</p>
    <label for="voter-key">Code</label>
    <p
      id="voter-key-hint"
      class="hint muted"
    >
      Der Code steht auf der Stimmkarte unter dem QR-Code: 20 Zeichen in Gruppen zu vier. Wenn Sie den QR-Code scannen, ist der Code schon eingetragen.
    </p>
    <input
      id="voter-key"
      ref="field"
      v-model="input"
      type="text"
      inputmode="text"
      autocapitalize="characters"
      autocomplete="off"
      spellcheck="false"
      :disabled="busy"
      aria-describedby="voter-key-hint voter-key-shown"
    >
    <output
      id="voter-key-shown"
      for="voter-key"
      class="grouped"
    >{{ grouped }}</output>
    <p
      v-if="shown"
      class="message error"
      role="alert"
    >
      {{ shown }}
    </p>
    <div class="actions">
      <button
        type="submit"
        :disabled="busy"
      >
        Weiter
      </button>
    </div>
  </form>
</template>

<style scoped>
.key-entry input {
  max-width: none;
  font-size: 1.2rem;
  letter-spacing: 0.06em;
}

.grouped {
  display: block;
  min-height: 1.5em;
  margin: 6px 0 10px;
  font-family: ui-monospace, 'JetBrains Mono', monospace;
  font-size: 1.1rem;
  letter-spacing: 0.08em;
  color: var(--muted);
}

.hint {
  margin-bottom: 8px;
  font-size: 0.9rem;
}
</style>
