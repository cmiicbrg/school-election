<script setup lang="ts">
// The toasts of lib/toast.ts, in one polite live region that is on the
// page from the start: a region that appeared together with its text
// would often not be read out. A toast can be dismissed; it also goes by
// itself after a few seconds.
import { dismiss, toasts } from '../lib/toast.ts'
</script>

<template>
  <div
    class="toasts"
    role="status"
    aria-live="polite"
  >
    <p
      v-for="toast in toasts"
      :key="toast.id"
      class="toast"
    >
      <span>{{ toast.text }}</span>
      <button
        type="button"
        class="link"
        :aria-label="`Ausblenden: ${toast.text}`"
        @click="dismiss(toast.id)"
      >
        Ausblenden
      </button>
    </p>
  </div>
</template>

<style scoped>
.toasts {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 10;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: min(420px, calc(100vw - 32px));
}

.toast {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin: 0;
  padding: 10px 14px;
  border-radius: var(--radius);
  color: var(--ok);
  background: var(--ok-bg);
  border: 1px solid var(--ok);
  box-shadow: 0 2px 8px rgb(0 0 0 / 15%);
}

.toast span {
  flex: 1;
}

@media print {
  .toasts {
    display: none;
  }
}
</style>
