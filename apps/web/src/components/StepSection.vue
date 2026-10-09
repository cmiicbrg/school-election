<script setup lang="ts">
// A section of the termin's page that is one step: its heading, and a
// button that marks the step done by collapsing it to its summary, or
// opens it again. Collapsed, the section stays mounted and only hidden,
// so nothing typed or on its way in it is lost.

const props = defineProps<{
  /** The step's id: the section's anchor and its heading's id. */
  id: string
  title: string
  /** Whether the step is marked done; null for a step nobody marks. */
  collapsed: boolean | null
}>()

const emit = defineEmits<{ toggle: [] }>()
</script>

<template>
  <section
    :id="id"
    :aria-labelledby="`${id}-heading`"
  >
    <div class="step-head">
      <h2
        :id="`${id}-heading`"
        tabindex="-1"
      >
        {{ title }}
      </h2>
      <button
        v-if="props.collapsed !== null"
        type="button"
        class="secondary"
        :aria-expanded="!props.collapsed"
        :aria-controls="`${id}-body`"
        :aria-label="props.collapsed ? `${title} aufklappen` : `${title} als erledigt einklappen`"
        @click="emit('toggle')"
      >
        {{ props.collapsed ? 'Aufklappen' : 'Erledigt, einklappen' }}
      </button>
    </div>
    <div
      v-if="props.collapsed"
      class="muted"
    >
      <slot name="summary" />
    </div>
    <div
      v-show="!props.collapsed"
      :id="`${id}-body`"
    >
      <slot />
    </div>
  </section>
</template>

<style scoped>
.step-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin: 28px 0 10px;
  padding-top: 16px;
  border-top: 1px solid var(--line);
}

.step-head h2 {
  margin: 0;
  padding: 0;
  border: 0;
}
</style>
