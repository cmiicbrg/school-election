<script setup lang="ts">
// Where voters vote: the address the cards carry as a QR code, beside the
// termin's steps and, on a phone, in the strip under its title. A button
// copies it with its scheme, so that it pastes as a link; where the
// browser does not let the page write the clipboard, the address shown is
// selected for copying by hand.

import { ref } from 'vue'
import LineIcon from './LineIcon.vue'
import { BASE_URL } from '../lib/base.ts'
import { voterAddress } from '../lib/sheet.ts'
import { notify } from '../lib/toast.ts'

const address = voterAddress(BASE_URL)
const link = `${BASE_URL}/v`
const shown = ref<HTMLElement | null>(null)

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(link)
    notify('Adresse kopiert.')
  } catch {
    if (shown.value) window.getSelection()?.selectAllChildren(shown.value)
    notify('Kopieren ging nicht: Die Adresse ist markiert und lässt sich von Hand kopieren.')
  }
}
</script>

<template>
  <div class="address">
    <span class="caption">Stimmabgabe unter</span>
    <div class="line">
      <span
        ref="shown"
        class="url"
      >{{ address }}</span>
      <button
        type="button"
        class="ghost copy"
        aria-label="Adresse kopieren"
        @click="copy"
      >
        <LineIcon name="copy" />
      </button>
    </div>
    <span class="muted">Die Stimmkarten tragen diese Adresse als QR-Code.</span>
  </div>
</template>

<style scoped>
.address {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 14px 16px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--paper);
  font-size: 0.8rem;
}

.caption {
  color: var(--muted);
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.url {
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 0.75rem;
  overflow-wrap: anywhere;
}

.copy {
  min-height: 32px;
  padding: 0 8px;
}

@media (width <= 600px) {
  .copy {
    min-height: 44px;
  }
}
</style>
