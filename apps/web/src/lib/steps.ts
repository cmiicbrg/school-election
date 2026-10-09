// The steps of a termin, in order, for the step navigation and the
// sections: done, the current one, or still to come. A step is done when
// the lifecycle has finished it, or when the person marked it done by
// collapsing its section. A section is collapsed by its mark, and without
// one when its step is finished: opening a finished step's section only
// shows it again, the step stays done. The marks are a view of this
// browser, kept per termin in localStorage: nothing of them reaches the
// election, and a browser that cannot keep them still shows the page.

import { ref, watch, type Ref } from 'vue'
import type { Lifecycle } from '@school-election/election-core'

export const STEPS = ['einrichten', 'mitglieder', 'vorbereiten', 'stimmkarten', 'probelauf', 'wahltag', 'ergebnis'] as const
export type Step = typeof STEPS[number]
/** The steps a person can mark done, each with a section or block to collapse. */
export const MARKABLE = ['einrichten', 'mitglieder', 'vorbereiten', 'stimmkarten', 'probelauf'] as const satisfies readonly Step[]
export type Markable = typeof MARKABLE[number]
export type Marks = Partial<Record<Markable, boolean>>
export type StepState = 'done' | 'current' | 'open'

export const STEP_LABELS: Readonly<Record<Step, string>> = {
  einrichten: 'Einrichten',
  mitglieder: 'Mitglieder',
  vorbereiten: 'Vorbereiten',
  stimmkarten: 'Stimmkarten',
  probelauf: 'Probelauf',
  wahltag: 'Wahltag',
  ergebnis: 'Ergebnis',
}

/**
 * Whether the lifecycle has finished a step: the setup and the members
 * once prepared (names and members can still be corrected, in the
 * expanded section), the cards of the 1. Wahlgang and the Probelauf once
 * it opened, the day once the result is final. The result is never done:
 * it is the last step.
 */
export function finished(step: Step, lifecycle: Lifecycle): boolean {
  switch (step) {
    case 'einrichten':
    case 'mitglieder':
    case 'vorbereiten':
      return lifecycle.election !== 'draft'
    case 'stimmkarten':
    case 'probelauf':
      return lifecycle.election === 'active' || lifecycle.election === 'final'
    case 'wahltag':
      return lifecycle.election === 'final'
    case 'ergebnis':
      return false
  }
}

const testing = (step: Step, lifecycle: Lifecycle): boolean => step === 'probelauf' && lifecycle.regular === 'testing'

/** Whether a step's section is collapsed: by its mark, or finished without one. A running Probelauf never is. */
export function collapsed(step: Markable, lifecycle: Lifecycle, marks: Marks): boolean {
  return !testing(step, lifecycle) && (marks[step] ?? finished(step, lifecycle))
}

/** Each step's state: done when finished or marked done, then the first one that is not is the current one. A running Probelauf is never done. */
export function stepStates(lifecycle: Lifecycle, marks: Marks): Record<Step, StepState> {
  let current = false
  const states = {} as Record<Step, StepState>
  for (const step of STEPS) {
    const done = !testing(step, lifecycle) && (finished(step, lifecycle) || (marks as Partial<Record<Step, boolean>>)[step] === true)
    if (done) states[step] = 'done'
    else if (current) states[step] = 'open'
    else {
      states[step] = 'current'
      current = true
    }
  }
  return states
}

/** The marks as stored, keeping only known steps with a yes or no; anything else reads as no marks. */
export function parseMarks(stored: string | null): Marks {
  let value: unknown
  try {
    value = JSON.parse(stored ?? '{}')
  } catch {
    return {}
  }
  if (typeof value !== 'object' || value === null) return {}
  const marks: Marks = {}
  for (const step of MARKABLE) {
    const mark = (value as Record<string, unknown>)[step]
    if (typeof mark === 'boolean') marks[step] = mark
  }
  return marks
}

const keyOf = (electionId: string): string => `schulwahl.schritte.${electionId}`

/** The marks of the termin `electionId` names, read when it changes and kept when one is set. */
export function useStepMarks(electionId: () => string): { marks: Ref<Marks>, mark: (step: Markable, done: boolean) => void } {
  const marks = ref<Marks>({})
  watch(electionId, (id) => {
    try {
      marks.value = parseMarks(localStorage.getItem(keyOf(id)))
    } catch {
      marks.value = {}
    }
  }, { immediate: true })
  function mark(step: Markable, done: boolean): void {
    marks.value = { ...marks.value, [step]: done }
    try {
      localStorage.setItem(keyOf(electionId()), JSON.stringify(marks.value))
    } catch {
      // Not kept in this browser: the mark holds until the page is left.
    }
  }
  return { marks, mark }
}
