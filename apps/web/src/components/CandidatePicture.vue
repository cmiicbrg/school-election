<script setup lang="ts">
// A candidate's picture: drop a photo onto it, paste one (Ctrl+V) or pick
// one with "Bild auswählen". Any photo the browser can open will do; it is
// turned upright, scaled and re-encoded here (lib/picture.ts) before the
// page that embeds this component uploads it. The component itself talks
// to no API: it emits `select` with the prepared picture and `remove`, and
// shows `src` (the picture's URL) and `error` (a failed upload) as the
// page passes them. Its status says what the page's upload or removal
// came to, once the page is done with it, never before; removing asks
// first. The page shows it only while candidates can change, and the
// picture alone otherwise.

import { computed, nextTick, ref, useId, watch } from 'vue'
import { PictureError, preparePicture, type PreparedPicture } from '../lib/picture.ts'
import { filesOf, pickFile, PICTURE_MESSAGES, type PictureProblem } from '../lib/picture-rules.ts'

const props = defineProps<{
  /** The candidate's name, for the picture's alternative text. */
  name: string
  /** The stored picture's URL, or null without one. */
  src?: string | null
  /** The page is uploading or removing the picture. */
  busy?: boolean
  /**
   * Why the page's last upload failed (see uploadMessage in
   * lib/picture-rules.ts); the page clears it when it starts the next one.
   */
  error?: string | null
}>()

const emit = defineEmits<{
  select: [picture: PreparedPicture]
  remove: []
}>()

const ids = { hint: useId(), input: useId() }
const zone = ref<HTMLElement>()
const input = ref<HTMLInputElement>()
const chooser = ref<HTMLButtonElement>()
const removeButton = ref<HTMLButtonElement>()
const cancelButton = ref<HTMLButtonElement>()
const preparing = ref(false)
const dragging = ref(false)
const problem = ref<string | null>(null)
const status = ref('')
/** What the page is doing for this picture, so the status can say how it ended. */
const doing = ref<{ kind: 'select', others: number } | { kind: 'remove' } | null>(null)
const askingRemove = ref(false)
// The picture just prepared, shown while the page uploads it. Once the
// page is done it shows `src`: the new picture's URL, or after a failed
// upload the stored picture as before, next to the error.
const preview = ref<string | null>(null)

watch(() => props.src, () => {
  preview.value = null
})
watch(() => [props.busy, props.error] as const, ([busy, error], [wasBusy]) => {
  if ((wasBusy === true && busy !== true) || error) preview.value = null
  if (wasBusy !== true || busy === true || doing.value === null) return
  const done = doing.value
  doing.value = null
  if (error) status.value = ''
  else if (done.kind === 'remove') status.value = 'Bild entfernt.'
  else status.value = done.others > 0 ? 'Bild gespeichert. Von den abgelegten Dateien wurde nur dieses eine Bild verwendet.' : 'Bild gespeichert.'
})

const shown = computed(() => preview.value ?? props.src ?? null)
const message = computed(() => problem.value ?? props.error ?? null)
const locked = computed(() => props.busy === true || preparing.value)

function fail(reason: PictureProblem): void {
  problem.value = PICTURE_MESSAGES[reason]
  status.value = ''
}

async function take(files: File[]): Promise<void> {
  if (locked.value) return
  // A new picture answers an open question about the old one.
  askingRemove.value = false
  const picked = pickFile(files)
  if (picked.kind === 'none') return fail('no-file')
  preparing.value = true
  problem.value = null
  status.value = 'Bild wird vorbereitet …'
  try {
    const picture = await preparePicture(picked.file)
    preview.value = picture.preview
    status.value = 'Bild wird gespeichert …'
    doing.value = { kind: 'select', others: picked.others }
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

function askRemove(): void {
  askingRemove.value = true
  void nextTick(() => cancelButton.value?.focus())
}
function cancelRemove(): void {
  askingRemove.value = false
  void nextTick(() => removeButton.value?.focus())
}
function remove(): void {
  askingRemove.value = false
  preview.value = null
  problem.value = null
  status.value = 'Bild wird entfernt …'
  doing.value = { kind: 'remove' }
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
  <fieldset class="candidate-picture">
    <legend class="visually-hidden">
      Bild von {{ name }}
    </legend>
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
            v-if="shown && !askingRemove"
            ref="removeButton"
            type="button"
            :disabled="locked"
            @click="askRemove"
          >
            Bild entfernen
          </button>
        </div>
        <fieldset
          v-if="askingRemove"
          class="confirm"
          :aria-label="`Entfernen bestätigen: Bild von ${name}`"
        >
          <span>Bild von {{ name }} entfernen?</span>
          <button
            type="button"
            class="danger"
            :disabled="locked"
            @click="remove"
          >
            Ja, entfernen
          </button>
          <button
            ref="cancelButton"
            type="button"
            class="secondary"
            @click="cancelRemove"
          >
            Abbrechen
          </button>
        </fieldset>
      </div>
      <!-- Reached through "Bild auswählen"; the button is what keyboards and screen readers use. -->
      <label
        :for="ids.input"
        class="visually-hidden"
        aria-hidden="true"
      >Foto für {{ name }}</label>
      <input
        :id="ids.input"
        ref="input"
        class="visually-hidden"
        type="file"
        accept="image/*"
        tabindex="-1"
        aria-hidden="true"
        @change="onChosen"
      >
    </div>
    <output
      class="status"
      aria-live="polite"
    >
      {{ preparing ? 'Bild wird vorbereitet …' : status }}
    </output>
    <p
      v-if="message"
      class="problem"
      role="alert"
    >
      {{ message }}
    </p>
  </fieldset>
</template>

<style scoped>
.candidate-picture {
  display: grid;
  gap: 0.5rem;
  max-width: 32rem;
  min-inline-size: 0;
  margin: 0;
  padding: 0;
  border: 0;
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
  display: block;
  margin: 0;
  min-height: 1.25em;
  font-size: 0.9rem;
}

.problem {
  margin: 0;
  color: #a1161b;
  font-size: 0.9rem;
}
</style>
