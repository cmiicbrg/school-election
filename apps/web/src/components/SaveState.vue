<script setup lang="ts">
// What a form says about its fields next to its button: "Nicht
// gespeichert" stands out, "Wird gespeichert …" and "Gespeichert" stay
// quiet, and nothing is shown while the form is untouched.
defineProps<{ state: string }>()
</script>

<template>
  <span
    v-if="state"
    class="save-state"
    :class="{ unsaved: state === 'Nicht gespeichert' }"
  >{{ state }}</span>
</template>

<style scoped>
.save-state {
  align-self: center;
  color: var(--muted);
}

.save-state.unsaved {
  color: var(--warn);
  font-weight: 600;
}
</style>
