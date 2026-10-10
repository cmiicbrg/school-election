// What the pages know about the API's answers, free of the DOM so that
// node:test can check it: how a refusal is represented, and where a
// signed-out person is sent.

/** A refused request: the API's error code, for a validation error its message, and the whole body for a refusal that says more (void_required names batches). */
export class ApiError extends Error {
  override name = 'ApiError'
  readonly status: number
  readonly code: string
  readonly body: Record<string, unknown>

  constructor(status: number, code: string, message?: string, body: Record<string, unknown> = {}) {
    super(message ?? code)
    this.status = status
    this.code = code
    this.body = body
  }
}

/** The API's error body, as every refusal carries it. */
export function problemOf(status: number, payload: unknown): ApiError {
  const body = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : {}
  const code = typeof body.error === 'string' && body.error !== '' ? body.error : 'request_failed'
  const message = typeof body.message === 'string' ? body.message : undefined
  return new ApiError(status, code, message, body)
}

/** A path of this app, or the start page for anything else. */
export function ownPath(returnTo: string): string {
  return returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/'
}

/** The sign-in page, which comes back to `returnTo` once signed in. */
export function signInUrl(returnTo: string): string {
  return `/anmelden?returnTo=${encodeURIComponent(ownPath(returnTo))}`
}

/** Where the sign-in page sends the browser: Entra, and back to `returnTo`. */
export function loginUrl(returnTo: string): string {
  return `/api/auth/login?returnTo=${encodeURIComponent(ownPath(returnTo))}`
}

/** What a person is told when the API refuses, by its code; the validation message names a field, never a value. */
export const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  unauthenticated: 'Bitte melden Sie sich an.',
  forbidden: 'Dafür fehlt Ihnen die Berechtigung.',
  not_found: 'Das gibt es nicht, oder Sie sind nicht Mitglied dieses Wahltermins.',
  cross_site_request: 'Die Anfrage kam nicht von dieser Seite.',
  election_final: 'Das Ergebnis ist festgestellt; nichts ändert sich mehr.',
  not_draft: 'Das ist nur im Entwurf möglich.',
  not_prepared: 'Dafür muss der Wahltermin vorbereitet sein.',
  voting_started: 'Die Stimmabgabe hat bereits begonnen.',
  round_planned: 'Der Wahlgang hat noch nicht begonnen.',
  round_open: 'Der Wahlgang läuft noch.',
  round_closed: 'Der Wahlgang ist bereits beendet.',
  round_testing: 'Der Probelauf läuft; bitte zuerst den Probelauf beenden.',
  no_runoff: 'Es gibt keine Stichwahl.',
  runoff_activated: 'Die Stichwahl läuft bereits.',
  not_ready: 'Der Wahltermin kann noch nicht vorbereitet werden.',
  void_required: 'Stimmkarten würden ungültig; das muss bestätigt werden.',
  batch_void: 'Dieser Stapel wurde bereits ersetzt.',
  already_member: 'Diese Person ist bereits Mitglied.',
  owner_not_removable: 'Die Wahlleitung kann nicht entfernt werden.',
  lead_needs_co_admin: 'Die Wahlleitung geht nur an eine Person, die Co-Admin ist und sich schon angemeldet hat.',
  duplicate_candidate: 'Diesen Namen gibt es in dieser Wahl schon.',
  too_many_candidates: 'Eine Wahl hat höchstens 50 Kandidat:innen.',
  duplicate_title: 'Eine Wahl mit diesem Titel gibt es schon.',
  duplicate_name: 'Eine Klasse oder Gruppe mit diesem Namen gibt es schon.',
  last_candidate: 'In einer vorbereiteten Wahl bleibt mindestens eine Person zur Wahl.',
  unknown_contest: 'Diese Wahl gibt es nicht.',
  lot_required: 'Zuerst den Losentscheid eintragen.',
  lot_not_required: 'Dafür ist kein Los nötig.',
  duplicate_lot: 'Dieses Los ist bereits eingetragen.',
  not_the_tied_set: 'Die Reihenfolge muss genau die gleichauf liegenden Kandidat:innen enthalten, jede einmal.',
  cleanup_blocked: 'Die Datenbank ist gerade beschäftigt. Bitte in einer Minute noch einmal versuchen.',
  wal_retained: 'Der Server hält noch Protokolldaten zurück. Bitte die Betreiber:in verständigen.',
  election_changed: 'Der Wahltermin hat sich inzwischen geändert. Bitte die Seite neu laden.',
  too_long: 'Der Text ist zu lang.',
  FST_ERR_VALIDATION: 'Die Eingabe ist unvollständig oder zu lang.',
  request_failed: 'Das hat nicht geklappt. Bitte versuchen Sie es noch einmal.',
}

/**
 * Whether a failed request may succeed when sent again unchanged: no answer
 * at all (the connection), or a server or proxy error. A refusal (4xx)
 * stays one.
 */
export function isTransient(error: unknown): boolean {
  return !(error instanceof ApiError) || error.status >= 500
}

/** How long to wait before the `attempt`th retry (from 0): 2, 4, 8, 16 seconds, then every 30. */
export function retryDelay(attempt: number): number {
  return Math.min(30_000, 2_000 * 2 ** attempt)
}

/** The sentence for a refusal: its code's, or the general one. */
export function errorMessage(error: unknown): string {
  const code = error instanceof ApiError ? error.code : 'request_failed'
  return ERROR_MESSAGES[code] ?? ERROR_MESSAGES.request_failed ?? ''
}
