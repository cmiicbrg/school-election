<script setup lang="ts">
// Where voters vote: the address the cards carry as a QR code, beside the
// termin's steps and, on a phone, in the strip under its title.

import { BASE_URL } from '../lib/base.ts'
import { voterAddress } from '../lib/sheet.ts'

const address = voterAddress(BASE_URL)
</script>

<template>
  <div class="address">
    <span class="caption">Stimmabgabe unter</span>
    <strong class="url">{{ address }}</strong>
    <span class="muted">Die Stimmkarten tragen diese Adresse als QR-Code.</span>
  </div>
</template>

<style scoped>
.address {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 14px 16px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--paper);
  font-size: 0.85rem;
}

.caption {
  color: var(--muted);
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.url {
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 0.85rem;
  overflow-wrap: anywhere;
}
</style>
