<script setup lang="ts">
// Neue Wahl: a title, a description and the preset the election starts
// from; then straight to the election's page.

import { ref, useId } from 'vue'
import { useRouter } from 'vue-router'
import { apiPost } from '../lib/api.ts'
import { errorMessage } from '../lib/api-rules.ts'
import { PRESETS, type PresetId } from '../lib/presets.ts'
import type { ElectionDetail } from '../lib/types.ts'

const router = useRouter()
const ids = { title: useId(), description: useId() }
const title = ref('')
const description = ref('')
const preset = ref<PresetId>('school-speaker')
const busy = ref(false)
const error = ref<string | null>(null)

async function create(): Promise<void> {
  busy.value = true
  error.value = null
  try {
    const body: { title: string, description?: string, preset: PresetId } = { title: title.value, preset: preset.value }
    if (description.value.trim() !== '') body.description = description.value
    const election = await apiPost<ElectionDetail>('/api/elections', body)
    await router.push(`/wahlen/${election.id}`)
  } catch (err) {
    error.value = errorMessage(err)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <h1>Neue Wahl</h1>
  <form @submit.prevent="create">
    <label :for="ids.title">Titel</label>
    <input
      :id="ids.title"
      v-model="title"
      type="text"
      required
      maxlength="200"
      autocomplete="off"
    >
    <label :for="ids.description">Beschreibung (optional)</label>
    <textarea
      :id="ids.description"
      v-model="description"
      maxlength="2000"
    />
    <fieldset>
      <legend>Vorlage</legend>
      <div
        v-for="option in PRESETS"
        :key="option.id"
        class="preset"
      >
        <label class="preset-label">
          <input
            v-model="preset"
            type="radio"
            name="preset"
            :value="option.id"
          >
          {{ option.label }}
        </label>
        <p class="muted">
          {{ option.description }}
        </p>
      </div>
    </fieldset>
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
        :disabled="busy"
      >
        Wahl anlegen
      </button>
    </div>
  </form>
</template>

<style scoped>
fieldset {
  border: 1px solid var(--line);
  border-radius: var(--radius);
  margin: 12px 0;
  padding: 8px 12px;
}

.preset {
  margin: 6px 0;
}

.preset-label {
  font-weight: 600;
  margin: 0;
}

.preset p {
  margin: 0 0 4px 24px;
}
</style>
