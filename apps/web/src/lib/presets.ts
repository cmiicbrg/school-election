// The presets a new election starts from, with their German names. The
// ids are the API's (apps/api/lib/presets.ts, PRESET_IDS), which refuses
// any other; a preset only gives the election its first contest.

export const PRESETS = [
  { id: 'school-speaker', label: 'Schulsprecherwahl', description: 'Schulsprecher/in mit Stellvertretungen und SGA-Stellvertretungen; weitere Wahlgänge (Abteilungen, Klassen) können dazukommen.' },
  { id: 'department-representative', label: 'Abteilungssprecherwahl', description: 'Abteilungssprecher/in und Stellvertretung; je Abteilung ein Wahlgang.' },
  { id: 'class-representative', label: 'Klassensprecherwahl', description: 'Klassensprecher/in und Stellvertretung; je Klasse ein Wahlgang.' },
  { id: 'poll', label: 'Anonyme Abstimmung', description: 'Eine Stimme pro Person; die Kandidat:innen sind die Optionen.' },
] as const

export type PresetId = typeof PRESETS[number]['id']

export function isPresetId(value: string): value is PresetId {
  return PRESETS.some((preset) => preset.id === value)
}
