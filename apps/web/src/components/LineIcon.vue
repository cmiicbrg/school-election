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
  'trash': ['M4 7h16', 'M10 11v6', 'M14 11v6', 'M6 7l1 13h10l1-13', 'M9 7V4h6v3'],
  'image': ['M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z', 'M9 8a2 2 0 1 0 0 4a2 2 0 1 0 0-4z', 'M21 16l-5-5-9 8'],
  'plus': ['M12 5v14', 'M5 12h14'],
  'copy': ['M11 9h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z', 'M5 15V5a1 1 0 0 1 1-1h9'],
  'alert': ['M12 3l10 18H2z', 'M12 10v4', 'M12 17.5v.5'],
  'user-plus': ['M9 4a4 4 0 1 0 0 8a4 4 0 1 0 0-8z', 'M2 21c0-4 3-6 7-6s7 2 7 6', 'M19 8v6', 'M16 11h6'],
  'info': ['M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z', 'M12 11v6', 'M12 7.5v.5'],
  'print': ['M7 9V3h10v6', 'M5 9h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2z', 'M7 14h10v7H7z'],
  'refresh': ['M4 4v6h6', 'M20 20v-6h-6', 'M5.5 15a7 7 0 0 0 12.5 2', 'M18.5 9A7 7 0 0 0 6 7'],
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
