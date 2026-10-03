<script setup lang="ts">
// A candidate's picture: drop a photo onto it, paste one (Ctrl+V) or pick
// one with "Bild auswählen". Any photo the browser can open will do; it is
// turned upright, scaled and re-encoded here (lib/picture.ts) before the
// page that embeds this component uploads it. The component itself talks
// to no API: it emits `select` with the prepared picture and `remove`, and
// shows `src` (the picture's URL) and `error` (a failed upload) as the
// page passes them.

import { computed, nextTick, ref, useId, watch } from 'vue'
import { PictureError, preparePicture, type PreparedPicture } from '../lib/picture.ts'
import { filesOf, pickFile, PICTURE_MESSAGES, type PictureProblem } from '../lib/picture-rules.ts'

const props = defineProps<{
  /** The candidate's name, for the picture's alternative text. */
  name: string
  /** The stored picture's URL, or null without one. */
  src?: string | null
  /** No changes, e.g. once voting has started. */
  disabled?: boolean
  /** The page is uploading or removing the picture. */
  busy?: boolean
  /** Why the page's last upload failed (see uploadMessage in lib/picture-rules.ts). */
  error?: string | null
}>()

const emit = defineEmits<{
  select: [picture: PreparedPicture]
  remove: []
}>()

const ids = { label: useId(), hint: useId() }
const zone = ref<HTMLElement>()
const input = ref<HTMLInputElement>()
const chooser = ref<HTMLButtonElement>()
const preparing = ref(false)
const dragging = ref(false)
const problem = ref<string | null>(null)
const status = ref('')
// The picture just prepared, shown until the page passes the stored one.
const preview = ref<string | null>(null)

watch(() => props.src, () => {
  preview.value = null
})

const shown = computed(() => preview.value ?? props.src ?? null)
const message = computed(() => problem.value ?? props.error ?? null)
const locked = computed(() => props.disabled === true || props.busy === true || preparing.value)

function fail(reason: PictureProblem): void {
  problem.value = PICTURE_MESSAGES[reason]
  status.value = ''
}

async function take(files: File[]): Promise<void> {
  if (locked.value) return
  const picked = pickFile(files)
  if (picked.kind === 'none') return fail('no-file')
  preparing.value = true
  problem.value = null
  status.value = 'Bild wird vorbereitet …'
  try {
    const picture = await preparePicture(picked.file)
    preview.value = picture.preview
    status.value = picked.others > 0 ? 'Bild übernommen. Von den abgelegten Dateien wurde nur dieses eine Bild verwendet.' : 'Bild übernommen.'
    emit('select', picture)
  } catch (err) {
    fail(err instanceof PictureError ? err.problem : 'failed')
  } finally {
    preparing.value = false
  }
}

function onDragOver(event: DragEvent): void {
  dragging.value = true
  if (event.dataTransfer) event.dataTransfer.dropEffect = locked.value ? 'none' : 'copy'
}

function onDragLeave(event: DragEvent): void {
  // Moving onto an element inside the zone is not leaving it.
  if (!(event.relatedTarget instanceof Node && zone.value?.contains(event.relatedTarget))) dragging.value = false
}

function onDrop(event: DragEvent): void {
  dragging.value = false
  void take(filesOf(event.dataTransfer))
}

function onPaste(event: ClipboardEvent): void {
  const files = filesOf(event.clipboardData)
  // Text pasted here is none of our business.
  if (files.length === 0) return
  event.preventDefault()
  void take(files)
}

function onChosen(): void {
  const files = Array.from(input.value?.files ?? [])
  // So that choosing the same file again fires change again.
  if (input.value) input.value.value = ''
  void take(files)
}

function choose(): void {
  input.value?.click()
}

function remove(): void {
  preview.value = null
  problem.value = null
  status.value = 'Bild entfernt.'
  emit('remove')
  focusChooser()
}

// After a removal the button that had the focus is gone: the focus moves
// to "Bild auswählen", once the page has finished (a disabled button takes
// no focus).
let refocus = false

function focusChooser(): void {
  void nextTick(() => {
    if (locked.value) refocus = true
    else chooser.value?.focus()
  })
}

watch(locked, (now) => {
  if (now || !refocus) return
  refocus = false
  void nextTick(() => chooser.value?.focus())
})
</script>

<template>
  <div
    class="candidate-picture"
    role="group"
    :aria-labelledby="ids.label"
  >
    <span
      :id="ids.label"
      class="visually-hidden"
    >Bild von {{ name }}</span>
    <div
      ref="zone"
      class="drop-zone"
      :class="{ dragging, locked }"
      tabindex="-1"
      @dragenter.prevent="onDragOver"
      @dragover.prevent="onDragOver"
      @dragleave="onDragLeave"
      @drop.prevent="onDrop"
      @paste="onPaste"
    >
      <div class="frame">
        <img
          v-if="shown"
          :src="shown"
          :alt="`Bild von ${name}`"
        >
        <span
          v-else
          class="placeholder"
          aria-hidden="true"
        >Kein Bild</span>
      </div>
      <div class="controls">
        <p
          :id="ids.hint"
          class="hint"
        >
          Foto hierher ziehen oder mit Strg+V einfügen. Jedes Foto passt: Größe und Ausrichtung werden automatisch angepasst.
        </p>
        <div class="actions">
          <button
            ref="chooser"
            type="button"
            :disabled="locked"
            :aria-describedby="ids.hint"
            @click="choose"
          >
            Bild auswählen
          </button>
          <button
            v-if="shown"
            type="button"
            :disabled="locked"
            @click="remove"
          >
            Bild entfernen
          </button>
        </div>
      </div>
      <input
        ref="input"
        class="visually-hidden"
        type="file"
        accept="image/*"
        tabindex="-1"
        aria-hidden="true"
        @change="onChosen"
      >
    </div>
    <p
      class="status"
      role="status"
    >
      {{ preparing ? 'Bild wird vorbereitet …' : status }}
    </p>
    <p
      v-if="message"
      class="problem"
      role="alert"
    >
      {{ message }}
    </p>
  </div>
</template>

<style scoped>
.candidate-picture {
  display: grid;
  gap: 0.5rem;
  max-width: 32rem;
}

.drop-zone {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  align-items: center;
  padding: 0.75rem;
  border: 2px dashed #8a8f98;
  border-radius: 0.5rem;
  background: #fafafa;
}

.drop-zone:focus-visible,
.drop-zone:focus-within {
  outline: 2px solid #1d5fbf;
  outline-offset: 2px;
}

.drop-zone.dragging {
  border-color: #1d5fbf;
  background: #eaf1fb;
}

.drop-zone.locked {
  opacity: 0.7;
}

/* A fixed square: any picture fills it without being distorted, and the top,
   where a portrait has the face, stays in view. */
.frame {
  flex: none;
  width: 7.5rem;
  height: 7.5rem;
  overflow: hidden;
  border-radius: 0.375rem;
  background: #e4e6ea;
  display: grid;
  place-items: center;
}

.frame img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: 50% 25%;
}

.placeholder {
  color: #4b5160;
  font-size: 0.875rem;
}

.controls {
  flex: 1 1 12rem;
  display: grid;
  gap: 0.5rem;
}

.hint {
  margin: 0;
  color: #333a45;
  font-size: 0.9rem;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.actions button {
  min-height: 2.5rem;
  padding: 0.25rem 0.875rem;
  font: inherit;
}

.status {
  margin: 0;
  min-height: 1.25em;
  font-size: 0.9rem;
}

.problem {
  margin: 0;
  color: #a1161b;
  font-size: 0.9rem;
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}
</style>
