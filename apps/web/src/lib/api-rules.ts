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
  not_found: 'Das gibt es nicht, oder Sie sind nicht Mitglied dieser Wahl.',
  cross_site_request: 'Die Anfrage kam nicht von dieser Seite.',
  election_final: 'Die Wahl ist abgeschlossen; nichts ändert sich mehr.',
  not_draft: 'Das ist nur im Entwurf möglich.',
  not_prepared: 'Dafür muss die Wahl vorbereitet sein.',
  voting_started: 'Die Wahl hat bereits begonnen.',
  round_planned: 'Die Runde hat noch nicht begonnen.',
  round_open: 'Die Runde läuft noch.',
  round_closed: 'Die Runde ist bereits geschlossen.',
  round_testing: 'Die Wahl ist im Testmodus; bitte zuerst den Test beenden.',
  no_runoff: 'Es gibt keine Stichwahl.',
  runoff_activated: 'Die Stichwahl läuft bereits.',
  not_ready: 'Die Wahl kann noch nicht vorbereitet werden.',
  void_required: 'Stimmkarten würden ungültig; das muss bestätigt werden.',
  batch_void: 'Dieser Stapel wurde bereits ersetzt.',
  already_member: 'Diese Person ist bereits Mitglied.',
  owner_not_removable: 'Die Wahlleitung kann nicht entfernt werden.',
  duplicate_candidate: 'Diesen Namen gibt es in diesem Wahlgang schon.',
  duplicate_contest: 'Einen Wahlgang mit diesem Titel gibt es schon.',
  duplicate_voter_group: 'Eine Klasse oder Gruppe mit diesem Namen gibt es schon.',
  last_candidate: 'Die letzte Kandidatin oder der letzte Kandidat eines vorbereiteten Wahlgangs bleibt.',
  unknown_contest: 'Diesen Wahlgang gibt es nicht.',
  too_long: 'Der Text ist zu lang.',
  FST_ERR_VALIDATION: 'Die Eingabe ist unvollständig oder zu lang.',
  request_failed: 'Das hat nicht geklappt. Bitte versuchen Sie es noch einmal.',
}

/** The sentence for a refusal: its code's, or the general one. */
export function errorMessage(error: unknown): string {
  const code = error instanceof ApiError ? error.code : 'request_failed'
  return ERROR_MESSAGES[code] ?? ERROR_MESSAGES.request_failed ?? ''
}
