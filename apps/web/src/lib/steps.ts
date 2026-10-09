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
import { stateLabel } from './labels.ts'

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

/** Each step's number, as the steps' navigation and the sections count them. */
export const STEP_NUMBERS: Readonly<Record<Step, number>> = {
  einrichten: 1,
  mitglieder: 2,
  vorbereiten: 3,
  stimmkarten: 4,
  probelauf: 5,
  wahltag: 6,
  ergebnis: 7,
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
    // A Probelauf runs on the printed cards: starting one finishes them, as opening the 1. Wahlgang does.
    case 'stimmkarten':
      return lifecycle.regular === 'testing' || lifecycle.election === 'active' || lifecycle.election === 'final'
    case 'probelauf':
      return lifecycle.election === 'active' || lifecycle.election === 'final'
    case 'wahltag':
      return lifecycle.election === 'final'
    case 'ergebnis':
      return false
  }
}

const testing = (step: Step, lifecycle: Lifecycle): boolean => step === 'probelauf' && lifecycle.regular === 'testing'

/**
 * Whether the page marks the cards done now: a Probelauf runs, which
 * finishes them, and nothing marks them yet. The mark keeps them done in
 * this browser after the Probelauf ends; cards opened again on purpose
 * keep that.
 */
export function marksCards(lifecycle: Lifecycle, marks: Marks): boolean {
  return lifecycle.regular === 'testing' && marks.stimmkarten === undefined
}

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

/** What the page knows of a termin, for each step's line under its name. */
export interface StepFacts {
  lifecycle: Lifecycle
  contests: number
  groups: number
  members: number
  /** What preparing needs and does not have yet, as the checklist counts it. */
  missing: number
  /** Batches of keys that are valid. */
  batches: number
}

const counted = (n: number, one: string, many: string): string => (n === 1 ? `1 ${one}` : `${n} ${many}`)

/** The line under each step's name, step by step. */
const STATUS: Readonly<Record<Step, (facts: StepFacts) => string>> = {
  einrichten: (facts) => `${counted(facts.contests, 'Wahl', 'Wahlen')} · ${counted(facts.groups, 'Klasse oder Gruppe', 'Klassen oder Gruppen')}`,
  mitglieder: (facts) => counted(facts.members, 'Person', 'Personen'),
  vorbereiten: (facts) => {
    if (facts.lifecycle.election !== 'draft') return 'Aufbau steht fest'
    return facts.missing === 0 ? 'bereit' : `noch ${counted(facts.missing, 'Punkt', 'Punkte')} offen`
  },
  stimmkarten: (facts) => {
    if (facts.lifecycle.election === 'draft') return 'nach dem Vorbereiten'
    return facts.batches === 0 ? 'noch keine' : counted(facts.batches, 'gültiger Stapel', 'gültige Stapel')
  },
  probelauf: ({ lifecycle }) => {
    if (lifecycle.regular === 'testing') return 'läuft'
    return lifecycle.election === 'prepared' ? 'mehrmals möglich' : ''
  },
  wahltag: ({ lifecycle }) => (lifecycle.election === 'active' ? stateLabel(lifecycle) : ''),
  ergebnis: ({ lifecycle }) => {
    if (lifecycle.election === 'final') return 'festgestellt'
    return lifecycle.regular === 'closed' ? 'noch nicht festgestellt' : ''
  },
}

/** The line under a step's name in the steps' navigation; empty where there is nothing to say. */
export function stepStatus(step: Step, facts: StepFacts): string {
  return STATUS[step](facts)
}

/** The page's sections, in their order: every step but the Probelauf, a block of the day, and the result, a page of its own. */
export const SECTIONS = ['einrichten', 'mitglieder', 'vorbereiten', 'stimmkarten', 'wahltag'] as const
export type Section = typeof SECTIONS[number]

/**
 * Whether the day comes first: once a Probelauf runs or the 1. Wahlgang has
 * opened, and from then on, the page leads with the day's state and
 * controls (the turnout above all), since nothing above it changes during
 * a run. A Probelauf that ended gives the page its order back.
 */
export function dayFirst(lifecycle: Lifecycle): boolean {
  return lifecycle.regular === 'testing' || lifecycle.election === 'active' || lifecycle.election === 'final'
}

/** The sections in the order the page shows them: in their own order, or the day first, then what is open, then what is collapsed. */
export function sectionOrder(lifecycle: Lifecycle, isCollapsed: (step: Markable) => boolean): Section[] {
  if (!dayFirst(lifecycle)) return [...SECTIONS]
  const others = SECTIONS.filter((section): section is Exclude<Section, 'wahltag'> => section !== 'wahltag')
  return ['wahltag', ...others.filter((section) => !isCollapsed(section)), ...others.filter((section) => isCollapsed(section))]
}
