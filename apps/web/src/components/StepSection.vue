<script setup lang="ts">
// A step of the termin's page as an expansion panel: its heading, and a
// button with a chevron that marks the step done by collapsing it to its
// summary, or opens it again. Collapsed, it looks like a closed card with
// "erledigt" next to its title. It stays mounted and is only hidden, so
// nothing typed or on its way in it is lost.

const props = withDefaults(defineProps<{
  /** The step's id: the section's anchor and its heading's id. */
  id: string
  title: string
  /** Whether the step is marked done; null for a step nobody marks now. */
  collapsed: boolean | null
  /** 2 for a section of the page, 3 for a block within one. */
  level?: 2 | 3
}>(), { level: 2 })

const emit = defineEmits<{ toggle: [] }>()
</script>

<template>
  <section
    :id="id"
    :aria-labelledby="`${id}-heading`"
    :class="['step', `level-${props.level}`, { closed: props.collapsed }]"
  >
    <div class="step-head">
      <component
        :is="`h${props.level}`"
        :id="`${id}-heading`"
        tabindex="-1"
      >
        {{ title }}
      </component>
      <span
        v-if="props.collapsed"
        class="badge"
      >✓ erledigt</span>
      <button
        v-if="props.collapsed !== null"
        type="button"
        class="secondary toggle"
        :aria-expanded="!props.collapsed"
        :aria-controls="`${id}-body`"
        :aria-label="props.collapsed ? `${title} aufklappen` : `${title} als erledigt einklappen`"
        @click="emit('toggle')"
      >
        <span
          class="chevron"
          aria-hidden="true"
        />
        {{ props.collapsed ? 'Aufklappen' : 'Erledigt, einklappen' }}
      </button>
    </div>
    <div
      v-if="props.collapsed"
      class="summary muted"
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
  gap: 8px 12px;
}

.level-2 > .step-head {
  margin: 28px 0 10px;
  padding-top: 16px;
  border-top: 1px solid var(--line);
}

.level-3 > .step-head {
  margin: 16px 0 6px;
}

.step-head > h2,
.step-head > h3 {
  margin: 0;
  padding: 0;
  border: 0;
}

.badge {
  padding: 0 8px;
  border-radius: 999px;
  background: var(--ok-bg);
  color: var(--ok);
  font-size: 0.85rem;
  font-weight: 600;
}

.toggle {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

/* Down while closed (opens), up while open (closes). */
.chevron {
  width: 0.45em;
  height: 0.45em;
  border-right: 2px solid currentcolor;
  border-bottom: 2px solid currentcolor;
  transform: translateY(-0.15em) rotate(45deg);
  transition: transform 0.15s ease;
}

.toggle[aria-expanded='true'] .chevron {
  transform: translateY(0.1em) rotate(-135deg);
}

@media (prefers-reduced-motion: reduce) {
  .chevron {
    transition: none;
  }
}

/* A closed card: what the step holds, tinted, so a collapsed step does not
   read like an open section with little in it. */
.summary {
  padding: 10px 14px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--field);
}

.summary :deep(ul),
.summary :deep(p) {
  margin: 0;
}
</style>
