<script setup lang="ts">
// A step of the termin's page as a card: "Schritt N" over its heading, a
// button that marks the step done by collapsing it, and its content. A
// collapsed step is a compact row with a check, its heading and what it
// holds, and the button that opens it again; collapsed steps that follow
// each other join into one card. A step that cannot start yet is drawn
// dashed, with a lock. Collapsed, the section stays mounted and is only
// hidden, so nothing typed or on its way in it is lost.

import LineIcon from './LineIcon.vue'

const props = withDefaults(defineProps<{
  /** The step's id: the section's anchor and its heading's id. */
  id: string
  title: string
  /** The step's number, shown over the heading. */
  number?: number
  /** Whether the step is marked done; null for a step nobody marks now. */
  collapsed: boolean | null
  /** 2 for a section of the page, 3 for a block within one. */
  level?: 2 | 3
  /** The step cannot start yet: drawn dashed, with a lock. */
  locked?: boolean
  /** Something runs in this step now (a Probelauf): drawn in the colour of a test. */
  running?: boolean
}>(), { level: 2, number: undefined, locked: false, running: false })

const emit = defineEmits<{ toggle: [] }>()
</script>

<template>
  <section
    :id="id"
    :aria-labelledby="`${id}-heading`"
    :class="['step', `level-${props.level}`, { closed: props.collapsed, locked: props.locked, running: props.running }]"
  >
    <div class="step-head">
      <span
        v-if="props.collapsed"
        class="mark done"
        aria-hidden="true"
      ><LineIcon
        name="check"
        :size="14"
      /></span>
      <span
        v-else-if="props.locked"
        class="mark lock"
        aria-hidden="true"
      ><LineIcon
        name="lock"
        :size="16"
      /></span>
      <div class="titles">
        <p
          v-if="props.number !== undefined && !props.collapsed"
          class="overline"
        >
          Schritt {{ props.number }}<template v-if="props.running">
            · läuft
          </template>
        </p>
        <component
          :is="`h${props.level}`"
          :id="`${id}-heading`"
          tabindex="-1"
        >
          {{ title }}
        </component>
        <span
          v-if="props.collapsed"
          class="visually-hidden"
        >erledigt</span>
        <div
          v-if="props.collapsed"
          class="summary"
        >
          <slot name="summary" />
        </div>
      </div>
      <button
        v-if="props.collapsed !== null && !props.locked"
        type="button"
        :class="['toggle', props.collapsed ? 'ghost' : 'secondary']"
        :aria-expanded="!props.collapsed"
        :aria-controls="`${id}-body`"
        :aria-label="props.collapsed ? `${title} aufklappen` : `${title} als erledigt einklappen`"
        @click="emit('toggle')"
      >
        <LineIcon :name="props.collapsed ? 'chevron-down' : 'chevron-up'" />
        {{ props.collapsed ? 'Aufklappen' : 'Erledigt, einklappen' }}
      </button>
    </div>
    <div
      v-show="!props.collapsed"
      :id="`${id}-body`"
      class="body"
    >
      <slot />
    </div>
  </section>
</template>

<style scoped>
.step-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 8px 14px;
}

.titles {
  flex: 1 1 240px;
  min-width: 0;
}

.overline {
  margin: 0 0 2px;
  color: var(--accent);
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.titles > h2,
.titles > h3 {
  margin: 0;
  padding: 0;
  border: 0;
}

.toggle {
  margin-left: auto;
}

.mark {
  flex: none;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
}

.mark.done {
  background: var(--ok-bg);
  color: var(--ok);
}

.mark.lock {
  border-radius: 10px;
  background: var(--soft);
  color: var(--muted);
}

.summary {
  margin-top: 4px;
  color: var(--muted);
  font-size: 0.9rem;
}

.summary :deep(ul),
.summary :deep(p) {
  margin: 0;
}

/* A section of the page: a white card. */
.level-2 {
  background: var(--paper);
  border: 1px solid var(--line);
  border-radius: var(--radius-card);
}

.level-2 > .step-head {
  padding: 18px 24px;
}

.level-2 > .step-head h2 {
  font-size: 1.3rem;
}

.level-2:not(.closed, .locked) > .step-head {
  border-bottom: 1px solid var(--line);
}

.level-2 > .body {
  padding: 20px 24px 24px;
}

/* Collapsed: a compact row; rows that follow each other are one card. */
.level-2.closed > .step-head {
  padding: 14px 20px;
}

.level-2.closed > .step-head h2 {
  font-size: 1rem;
}

.level-2.closed + .level-2.closed {
  margin-top: 0;
  border-top: 0;
  border-top-left-radius: 0;
  border-top-right-radius: 0;
}

.level-2.closed:has(+ .level-2.closed) {
  border-bottom-left-radius: 0;
  border-bottom-right-radius: 0;
  border-bottom-style: solid;
}

/* Not yet: dashed, with a lock, and what it waits for. */
.level-2.locked {
  background: transparent;
  border: 1.5px dashed var(--line2);
}

.level-2.locked > .step-head h2 {
  color: var(--muted);
  font-size: 1.05rem;
}

.level-2.locked .overline {
  color: var(--muted);
}

.level-2.locked > .body {
  padding: 0 24px 18px 66px;
  color: var(--muted);
}

/* A block within a section. */
.level-3 {
  margin: 20px 0;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: 12px;
}

.level-3.closed {
  padding: 12px 16px;
}

.level-3.closed > .step-head {
  align-items: center;
}

/* While a Probelauf runs. */
.running {
  border-color: var(--warn-line);
  background: var(--warn-soft);
}

.running .overline {
  color: var(--warn);
}

@media (width <= 600px) {
  .level-2 > .step-head,
  .level-2 > .body {
    padding-left: 16px;
    padding-right: 16px;
  }

  .level-2.locked > .body {
    padding-left: 16px;
  }
}
</style>
