// What preparing needs, and what a formal election usually has, as a
// neutral checklist: each item open or done, with what keeps it open. The
// API reports what blocks preparing (problems) and what is unusual
// (warnings); each kind is one item here, done while none of its kind is
// reported, so the list is whole even though the API names only what is
// missing. An item about every Wahl or every class is open while there is
// none yet.

import { problemText, warningText, type Names, type Problem, type Warning } from './labels.ts'

export interface CheckItem {
  text: string
  done: boolean
  /** What keeps the item open, one sentence each; empty when its text says it. */
  missing: string[]
}

const REQUIRED: readonly { text: string, kind: Problem['kind'], needs?: Problem['kind'] }[] = [
  { text: 'Eine Wahl ist angelegt', kind: 'no-contests' },
  { text: 'Jede Wahl hat Kandidat:innen', kind: 'contest-without-candidates', needs: 'no-contests' },
  { text: 'Eine Klasse oder Gruppe ist angelegt', kind: 'no-voter-groups' },
  { text: 'In jeder Wahl wählt eine Klasse oder Gruppe', kind: 'contest-without-voter-groups', needs: 'no-contests' },
  { text: 'Jede Klasse oder Gruppe wählt in einer Wahl', kind: 'voter-group-without-contests', needs: 'no-voter-groups' },
]

const RECOMMENDED: readonly { text: string, kind: Warning['kind'] }[] = [
  { text: 'Ein Co-Admin hat sich angemeldet', kind: 'no-co-admin' },
  { text: 'Zwei Zeug:innen haben sich angemeldet', kind: 'too-few-witnesses' },
  { text: 'Alle Eingeladenen haben sich angemeldet', kind: 'pending-invitations' },
]

/** What preparing needs. */
export function requiredItems(problems: readonly Problem[], names: Names): CheckItem[] {
  return REQUIRED.map(({ text, kind, needs }) => {
    const own = problems.filter((problem) => problem.kind === kind)
    const done = own.length === 0 && !problems.some((problem) => problem.kind === needs)
    return { text, done, missing: kind.startsWith('no-') ? [] : own.map((problem) => problemText(problem, names)) }
  })
}

/** What a formal election usually has; preparing goes ahead without. */
export function recommendedItems(warnings: readonly Warning[]): CheckItem[] {
  return RECOMMENDED.map(({ text, kind }) => {
    const own = warnings.filter((warning) => warning.kind === kind)
    return { text, done: own.length === 0, missing: kind === 'no-co-admin' ? [] : own.map(warningText) }
  })
}
