// Presets are templates for a new election: the contests it starts with,
// each under its fixed ruleset. After that the election is configured like
// any other, so a Schulsprecherwahl can gain department and class contests,
// and a preset never changes how anything is counted.

import type { RulesetId } from '@school-election/election-core'

export interface PresetContest {
  readonly title: string
  readonly rulesetId: RulesetId
}

export const PRESET_IDS = ['school-speaker', 'department-representative', 'class-representative', 'poll'] as const
export type PresetId = typeof PRESET_IDS[number]

export const PRESETS: Readonly<Record<PresetId, readonly PresetContest[]>> = {
  // Schulsprecherwahl: six statutory slots, 6 to 1 points.
  'school-speaker': [{ title: 'Schulsprecher/in', rulesetId: 'at-school-speaker-v1' }],
  // Abteilungssprecherwahl and Klassensprecherwahl: representative and
  // deputy, 2 and 1 points. One contest to start with; a department or
  // class more is one contest more.
  'department-representative': [{ title: 'Abteilungssprecher/in', rulesetId: 'at-representative-v1' }],
  'class-representative': [{ title: 'Klassensprecher/in', rulesetId: 'at-representative-v1' }],
  // Anonyme Abstimmung: one choice per ballot; its candidates are the options.
  'poll': [{ title: 'Abstimmung', rulesetId: 'single-choice-v1' }],
}
