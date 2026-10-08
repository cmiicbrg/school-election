// The presets a new Wahltermin starts from, with their German names. The
// ids are the API's (apps/api/lib/presets.ts, PRESET_IDS), which refuses
// any other; a preset only gives the termin its first Wahl.

export const PRESETS = [
  { id: 'school-speaker', label: 'Schulsprecherwahl', description: 'Schulsprecher/in mit Stellvertretungen und SGA-Stellvertretungen; weitere Wahlen (Abteilungen, Klassen) können dazukommen.' },
  { id: 'department-representative', label: 'Abteilungssprecherwahl', description: 'Abteilungssprecher/in und Stellvertretung; je Abteilung eine Wahl.' },
  { id: 'class-representative', label: 'Klassensprecherwahl', description: 'Klassensprecher/in und Stellvertretung; je Klasse eine Wahl.' },
  { id: 'poll', label: 'Anonyme Abstimmung', description: 'Eine Stimme pro Person; die Kandidat:innen sind die Optionen.' },
] as const

export type PresetId = typeof PRESETS[number]['id']

export function isPresetId(value: string): value is PresetId {
  return PRESETS.some((preset) => preset.id === value)
}
