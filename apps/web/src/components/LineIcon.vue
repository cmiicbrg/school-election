<script setup lang="ts">
// The few line icons the pages draw, inline, in the text's colour. They
// decorate a word that says the same, so screen readers skip them.

const PATHS = {
  'ballot': ['M4 11h16v9H4z', 'M9 11V4h6v7', 'M8 15h8'],
  'check': ['M5 12l5 5L20 7'],
  'chevron-down': ['M6 9l6 6 6-6'],
  'chevron-up': ['M6 15l6-6 6 6'],
  'lock': ['M5 11h14v9H5z', 'M8 11V8a4 4 0 0 1 8 0v3'],
  'page': ['M7 3h7l5 5v13H7z', 'M14 3v5h5', 'M10 13h6', 'M10 17h6'],
  'clock': ['M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z', 'M12 7v5l3 2'],
  'chart': ['M4 20V10', 'M10 20V4', 'M16 20v-7', 'M22 20H2'],
  'flask': ['M9 3h6', 'M10 3v6L4 20h16L14 9V3'],
} as const satisfies Readonly<Record<string, readonly string[]>>

export type IconName = keyof typeof PATHS

withDefaults(defineProps<{ name: IconName, size?: number }>(), { size: 16 })
</script>

<template>
  <svg
    class="icon"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path
      v-for="d in PATHS[name]"
      :key="d"
      :d="d"
    />
  </svg>
</template>

<style scoped>
.icon {
  flex: none;
}
</style>
