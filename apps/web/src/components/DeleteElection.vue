<script setup lang="ts">
// Wahltermin löschen: for the owner, while nobody used the termin (a
// draft, or prepared while the 1. Wahlgang has not opened and no
// Probelauf runs: canDelete), with everything of it, the log included
// (DELETE /api/elections/:id). It asks first, in place, naming what goes;
// once deleted, a toast confirms it, and the page goes to "Meine
// Wahltermine" (ElectionPage, on `deleted`).

import { nextTick, ref } from 'vue'
import { apiDelete } from '../lib/api.ts'
import { errorMessage } from '../lib/api-rules.ts'
import { notify } from '../lib/toast.ts'

const props = defineProps<{
  electionId: string
  title: string
}>()

const emit = defineEmits<{ deleted: [] }>()

const asking = ref(false)
const busy = ref(false)
const error = ref<string | null>(null)
const askButton = ref<HTMLButtonElement | null>(null)
const cancelButton = ref<HTMLButtonElement | null>(null)

async function ask(): Promise<void> {
  asking.value = true
  error.value = null
  await nextTick()
  cancelButton.value?.focus()
}

async function cancel(): Promise<void> {
  asking.value = false
  await nextTick()
  askButton.value?.focus()
}

async function remove(): Promise<void> {
  busy.value = true
  error.value = null
  try {
    await apiDelete(`/api/elections/${props.electionId}`)
    notify(`Wahltermin „${props.title}“ gelöscht.`)
    emit('deleted')
  } catch (err) {
    asking.value = false
    error.value = errorMessage(err)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="delete">
    <p class="muted">
      Bis der 1. Wahlgang geöffnet ist, lässt sich der Wahltermin mit allem, was dazu gehört, löschen, das Protokoll eingeschlossen; nur nicht, während ein Probelauf läuft.
    </p>
    <button
      v-if="!asking"
      ref="askButton"
      type="button"
      class="danger"
      :disabled="busy"
      @click="ask"
    >
      Wahltermin löschen
    </button>
    <fieldset
      v-else
      class="confirm"
      aria-label="Löschen bestätigen: Wahltermin"
    >
      <span>Wahltermin „{{ title }}“ endgültig löschen? Wahlen, Kandidat:innen mit ihren Bildern, Klassen, Mitglieder, Stimmkarten und das Protokoll gehen mit.</span>
      <button
        type="button"
        class="danger"
        :disabled="busy"
        @click="remove"
      >
        Ja, löschen
      </button>
      <button
        ref="cancelButton"
        type="button"
        class="secondary"
        :disabled="busy"
        @click="cancel"
      >
        Abbrechen
      </button>
    </fieldset>
    <p
      v-if="error"
      class="message error"
      role="alert"
    >
      {{ error }}
    </p>
  </div>
</template>

<style scoped>
.delete {
  margin-top: 28px;
  padding-top: 16px;
  border-top: 1px solid var(--line);
}
</style>
