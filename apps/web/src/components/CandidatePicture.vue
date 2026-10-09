<script setup lang="ts">
// A candidate's picture, the top of the candidate's card: drop a photo
// onto it, paste one (Ctrl+V) or pick one with "Bild auswählen". The page
// says how once, next to all cards, and names that hint (`hint`). Any
// photo the browser can open will do; it is
// turned upright, scaled and re-encoded here (lib/picture.ts) before the
// page that embeds this component uploads it. The component itself talks
// to no API: it emits `select` with the prepared picture and `remove`, and
// shows `src` (the picture's URL) and `error` (a failed upload) as the
// page passes them. Its status says what the page's upload or removal
// came to, once the page is done with it, never before; removing asks
// first. The page shows it only while candidates can change, and the
// picture alone otherwise.

import { computed, nextTick, ref, useId, watch } from 'vue'
import LineIcon from './LineIcon.vue'
import { PictureError, preparePicture, type PreparedPicture } from '../lib/picture.ts'
import { filesOf, pickFile, PICTURE_MESSAGES, type PictureProblem } from '../lib/picture-rules.ts'

const props = defineProps<{
  /** The candidate's name, for the picture's alternative text. */
  name: string
  /** The id of the page's hint on dropping and pasting, which describes "Bild auswählen". */
  hint?: string
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

const ids = { input: useId() }
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
      :class="{ dragging, locked, filled: shown }"
      tabindex="-1"
      @dragenter.prevent="onDragOver"
      @dragover.prevent="onDragOver"
      @dragleave="onDragLeave"
      @drop.prevent="onDrop"
      @paste="onPaste"
    >
      <img
        v-if="shown"
        :src="shown"
        :alt="`Bild von ${name}`"
      >
      <LineIcon
        v-else
        name="image"
        :size="28"
      />
      <div class="actions">
        <button
          ref="chooser"
          type="button"
          class="secondary small"
          :disabled="locked"
          :aria-describedby="hint"
          @click="choose"
        >
          Bild auswählen
        </button>
        <button
          v-if="shown && !askingRemove"
          ref="removeButton"
          type="button"
          class="secondary small remove"
          :disabled="locked"
          @click="askRemove"
        >
          Bild entfernen
        </button>
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
    <output
      class="status"
      aria-live="polite"
    >{{ preparing ? 'Bild wird vorbereitet …' : status }}</output>
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
  display: flex;
  flex-direction: column;
  min-inline-size: 0;
  margin: 0;
  padding: 0;
  border: 0;
}

/* The top of the card: a picture, or the place for one. */
.drop-zone {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  height: 132px;
  overflow: hidden;
  border-bottom: 1px dashed var(--line2);
  background: var(--soft);
  color: var(--muted);
}

.drop-zone.filled {
  justify-content: flex-end;
  border-bottom-style: solid;
  border-bottom-color: var(--line);
}

.drop-zone:focus-visible,
.drop-zone:focus-within {
  outline: 3px solid #9db0ee;
  outline-offset: -3px;
}

.drop-zone.dragging {
  outline: 2px dashed var(--accent);
  outline-offset: -6px;
  background: var(--info-bg);
}

.drop-zone.locked {
  opacity: 0.7;
}

/* Any picture fills the place without being distorted, and the top, where
   a portrait has the face, stays in view. */
.drop-zone img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: 50% 25%;
}

.actions {
  position: relative;
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 6px;
  margin: 0;
}

.filled .actions {
  padding: 0 8px 8px;
}

/* Over a picture, both buttons fit side by side. */
.filled .actions button {
  min-height: 30px;
  padding: 0 10px;
  font-size: 0.75rem;
}

@media (width <= 600px) {
  .filled .actions button {
    min-height: 44px;
  }
}

.remove {
  color: var(--danger);
}

.confirm {
  margin: 12px 12px 0;
}

.status {
  display: block;
  padding: 0 12px;
  font-size: 0.8rem;
}

.status:not(:empty) {
  padding-top: 8px;
}

.problem {
  margin: 8px 12px 0;
  color: var(--danger);
  font-size: 0.8rem;
}
</style>
