// The offline verifier of an export: from the file alone, recomputes every
// snapshot's digest and result with election-core, the outcome of every
// snapshot as of its close and of every contest as it stands with the
// recorded lots, checks the audit chain and what its events say against
// the file, and looks for anything that could be a key. Pure, like the
// audit chain: election-core, canonical JSON, the audit chain, the digest
// module and the format, and nothing else, which ESLint keeps; the same
// functions the server tallies with, from a checkout, with no server and
// no database (scripts/verify.ts).

import { firstRoundResult, parseKey, pollOutcome, resolve, runoffResult, type Contest, type FirstRoundResult, type LotDecision, type Outcome, type RulesetId, type RunoffResult } from '@school-election/election-core'
import { verifyAuditChain } from './audit-chain.ts'
import { canonicalJson } from './canonical-json.ts'
import { EXPORT_FORMAT, EXPORT_VERSION, type ExportDocument, type ExportedBox, type ExportedSnapshot } from './export-format.ts'
import { ballotsOf, inputDigest, TallyError } from './tally-digest.ts'

export interface Check {
  name: string
  ok: boolean
  /** What was found, or what differs. */
  detail: string
}

export interface Report {
  ok: boolean
  checks: Check[]
}

/** Checks `input`, a parsed export, and reports every check by name; `ok` when all passed. A damaged file is a failed check, never a crash. */
export function verifyExport(input: unknown): Report {
  const checks: Check[] = []
  const check = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail })
  }
  const shape = asDocument(input)
  if (!shape.ok) {
    check('format', false, shape.problem)
    return { ok: false, checks }
  }
  try {
    runChecks(shape.document, check)
  } catch (err) {
    check('document', false, `the file is damaged: ${err instanceof Error ? err.message : String(err)}`)
  }
  return { ok: checks.every((entry) => entry.ok), checks }
}

function runChecks(document: ExportDocument, check: (name: string, ok: boolean, detail: string) => void): void {
  check('format', true, `${EXPORT_FORMAT} version ${EXPORT_VERSION}, election ${document.election.title}, exported ${document.exportedAt}`)

  const contests = new Map(document.contests.map((contest) => [contest.id, contest]))
  const titleOf = (contestId: string): string => contests.get(contestId)?.title ?? contestId
  const snapshotOf = (contestId: string, round: string): ExportedSnapshot | undefined =>
    document.snapshots.find((snapshot) => snapshot.contestId === contestId && snapshot.round === round)
  const decisionsOf = (contestId: string, before?: string): LotDecision[] => document.lots
    .filter((lot) => lot.contestId === contestId && (before === undefined || lot.recordedAt < before))
    .map((lot) => ({ lotId: lot.lotId, order: lot.drawn }))
  const runoffClosedAt = document.audit.events.find((event) => event.action === 'round.closed' && event.metadata.round === 'runoff')?.at

  // Every box of every closed round: the ballots, the digest, the result, the outcome as of the close.
  const results = new Map<string, FirstRoundResult | RunoffResult>()
  for (const round of document.rounds) {
    if (round.state !== 'closed') continue
    for (const box of round.boxes) {
      const label = `${round.kind} round, ${titleOf(box.contestId)}`
      const contest = contestOf(document, box)
      if (!contest) {
        check(`ballots: ${label}`, false, 'the box belongs to no contest of the file')
        continue
      }
      let ballots
      try {
        ballots = ballotsOf(contest, box.ballots)
      } catch (err) {
        check(`ballots: ${label}`, false, err instanceof TallyError ? err.message : String(err))
        continue
      }
      check(`ballots: ${label}`, ballots.length === box.entitlements.used, `${ballots.length} ballots, ${box.entitlements.used} entitlements used`)
      const snapshot = snapshotOf(box.contestId, round.kind)
      if (!snapshot) {
        check(`snapshot: ${label}`, false, 'no snapshot in the file')
        continue
      }
      const digest = inputDigest(contest, ballots)
      check(`digest: ${label}`, digest === snapshot.inputSha256, digest === snapshot.inputSha256 ? digest : `recomputed ${digest}, the snapshot says ${snapshot.inputSha256}`)
      const result = round.kind === 'runoff'
        ? runoffResult(contest, ballots, contest.id)
        : contest.rulesetId === 'single-choice-v1' ? runoffResult(contest, ballots, null) : firstRoundResult(contest, ballots)
      results.set(`${box.contestId}/${round.kind}`, result)
      const same = canonicalJson(result) === canonicalJson(snapshot.result)
      check(`result: ${label}`, same, same ? `${result.kind}, recomputed from ${ballots.length} ballots` : 'the recomputed result differs from the snapshot')
      const configured = contests.get(box.contestId)?.rulesetId ?? contest.rulesetId
      const atClose = round.kind === 'runoff'
        ? outcomeOf(configured, results.get(`${box.contestId}/regular`), result, runoffClosedAt === undefined ? [] : decisionsOf(box.contestId, runoffClosedAt))
        : outcomeOf(configured, result, undefined, [])
      const sameOutcome = atClose !== undefined && canonicalJson(atClose) === canonicalJson(snapshot.outcome)
      check(`outcome at close: ${label}`, sameOutcome, sameOutcome ? atClose.kind : atClose === undefined ? 'could not be resolved' : 'the outcome at the close differs from the snapshot')
    }
  }

  // Every contest has its outcome as it stands, once; each is the stored results and every recorded lot resolved.
  const outcomeContests = document.outcomes.map((entry) => entry.contestId)
  const complete = document.contests.every((contest) => outcomeContests.filter((id) => id === contest.id).length === 1) && outcomeContests.length === document.contests.length
  check('outcomes: one per contest', complete, complete ? `${document.contests.length} contests, ${document.outcomes.length} outcomes` : `${document.contests.length} contests, but outcomes for ${outcomeContests.map(titleOf).join(', ') || 'none'}`)
  for (const entry of document.outcomes) {
    const label = titleOf(entry.contestId)
    const contest = contests.get(entry.contestId)
    const first = results.get(`${entry.contestId}/regular`)
    const runoff = results.get(`${entry.contestId}/runoff`)
    if (!contest || !first) {
      check(`outcome: ${label}`, false, 'no verified first-round result for this contest')
      continue
    }
    const outcome = outcomeOf(contest.rulesetId, first, runoff, decisionsOf(entry.contestId))
    const same = outcome !== undefined && canonicalJson(outcome) === canonicalJson(entry.outcome)
    check(`outcome: ${label}`, same, same ? outcome.kind : 'the outcome resolved from the results and the lots differs from the file')
  }

  // The audit chain: recomputed, as exported, and not empty; then the events the file's rounds and snapshots imply.
  const chain = verifyAuditChain(document.audit.events)
  check('audit chain', chain.valid && chain.length > 0, chain.valid ? (chain.length > 0 ? `${chain.length} events, head ${chain.head ?? 'none'}` : 'no events: an election has at least its creation') : `broken at event ${chain.index}: ${chain.problem}`)
  const asExported = canonicalJson(chain) === canonicalJson(document.audit.chain)
  check('audit chain as exported', asExported, asExported ? 'the recomputed chain is the one the file states' : 'the file states another chain than its events give')
  for (const round of document.rounds) {
    if (round.state !== 'closed') continue
    const closed = document.audit.events.some((event) => event.action === 'round.closed' && event.metadata.round === round.kind)
    check(`event for the close of the ${round.kind} round`, closed, closed ? 'in the log' : 'no round.closed event in the file')
    if (round.kind === 'runoff') {
      const activated = document.audit.events.some((event) => event.action === 'runoff.activated')
      check('event for the activation of the runoff', activated, activated ? 'in the log' : 'no runoff.activated event in the file')
    }
  }
  for (const snapshot of document.snapshots) {
    const computed = document.audit.events.some((event) => event.action === 'result.computed' && event.metadata.contest === snapshot.contestId && event.metadata.round === snapshot.round && event.metadata.inputSha256 === snapshot.inputSha256)
    check(`event for the result: ${snapshot.round} round, ${titleOf(snapshot.contestId)}`, computed, computed ? 'in the log, with the digest' : 'no result.computed event with this digest in the file')
  }
  for (const event of document.audit.events) {
    if (event.action === 'result.computed') {
      const snapshot = snapshotOf(field(event.metadata, 'contest'), field(event.metadata, 'round'))
      const ballots = document.rounds.find((round) => round.kind === event.metadata.round)?.boxes.find((box) => box.contestId === event.metadata.contest)?.ballots.length
      const ok = snapshot !== undefined && snapshot.inputSha256 === event.metadata.inputSha256 && ballots === event.metadata.ballots
      check(`event ${event.seq} result.computed: ${titleOf(field(event.metadata, 'contest'))}`, ok, ok ? 'names the snapshot\'s digest and the ballots counted' : 'does not match the snapshot or the ballots in the file')
    } else if (event.action === 'round.closed') {
      const total = document.rounds.find((round) => round.kind === event.metadata.round)?.boxes.reduce((sum, box) => sum + box.ballots.length, 0)
      check(`event ${event.seq} round.closed: ${field(event.metadata, 'round')}`, total === event.metadata.ballots, `${field(event.metadata, 'ballots')} ballots in the log, ${total ?? 'no such round'} in the file`)
    } else if (event.action === 'runoff.pair') {
      const box = document.rounds.find((round) => round.kind === 'runoff')?.boxes.find((entry) => entry.contestId === event.metadata.contest)
      const pair = [event.metadata.first, event.metadata.second].map(String).sort()
      const ok = box?.runoffPair !== null && box !== undefined && [...box.runoffPair].sort().join() === pair.join()
      check(`event ${event.seq} runoff.pair: ${titleOf(field(event.metadata, 'contest'))}`, ok, ok ? 'names the box\'s pair' : 'does not name the runoff box\'s pair')
    } else if (event.action === 'export.generated') {
      check(`event ${event.seq} export.generated`, true, `an earlier export, ${field(event.metadata, 'bytes')} bytes, ${field(event.metadata, 'sha256')}`)
    }
  }
  // Lots and their events, both ways: every lot has its event with the same set, order and reason, and every event its lot.
  for (const lot of document.lots) {
    const event = document.audit.events.find((entry) => entry.action === 'lot.recorded' && entry.metadata.lotId === lot.lotId && entry.metadata.contest === lot.contestId)
    const ok = event !== undefined && event.metadata.order === lot.drawn.join(',') && event.metadata.candidates === lot.candidates.join(',') && event.metadata.reason === lot.reason && event.actor.name === lot.actorName
    check(`lot ${lot.lotId}: ${titleOf(lot.contestId)}`, ok, ok ? `recorded by ${lot.actorName} at ${lot.recordedAt}, as event ${event.seq} says` : 'no event records this lot with this set, order, reason and actor')
  }
  for (const event of document.audit.events.filter((entry) => entry.action === 'lot.recorded')) {
    const lot = document.lots.find((entry) => entry.lotId === event.metadata.lotId && entry.contestId === event.metadata.contest)
    const ok = lot !== undefined && lot.drawn.join(',') === event.metadata.order
    check(`event ${event.seq} lot.recorded: ${titleOf(field(event.metadata, 'contest'))}`, ok, ok ? 'the lot it records is in the file' : 'the lot it records is not in the file, or not with this order')
  }

  // Nothing that could be a key.
  const keys = strings(document).filter((value) => /^[0-9a-z]{20}$/i.test(value) && parseKey(value).ok)
  check('no key', keys.length === 0, keys.length === 0 ? 'no string of the file is a well-formed key' : `${keys.length} strings of the file are well-formed keys`)
}

/** A metadata field as text: the log holds strings and numbers there, nothing else. */
function field(metadata: Readonly<Record<string, unknown>>, key: string): string {
  const value = metadata[key]
  if (typeof value === 'string') return value
  return typeof value === 'number' ? String(value) : ''
}

/** The box's contest as election-core sees it: the pair as a single-choice contest for a runoff box. */
function contestOf(document: ExportDocument, box: ExportedBox): Contest | undefined {
  const contest = document.contests.find((entry) => entry.id === box.contestId)
  if (!contest) return undefined
  const ids = contest.candidates.map((candidate) => candidate.id)
  return box.runoffPair === null
    ? { id: contest.id, rulesetId: contest.rulesetId, candidateIds: ids }
    : { id: contest.id, rulesetId: 'single-choice-v1', candidateIds: ids.filter((id) => box.runoffPair?.includes(id)) }
}

/**
 * election-core's outcome from a first-round result, a runoff's where there
 * is one, and decisions, for a contest of the given ruleset (the contest's
 * as configured: a runoff box is counted as a single choice, but it decides
 * a ranked contest); undefined where it cannot be resolved.
 */
function outcomeOf(rulesetId: RulesetId, first: FirstRoundResult | RunoffResult | undefined, runoff: FirstRoundResult | RunoffResult | undefined, decisions: LotDecision[]): Outcome | undefined {
  if (first === undefined) return undefined
  if (rulesetId === 'single-choice-v1') return 'runoffOf' in first ? pollOutcome(first) : undefined
  if ('runoffOf' in first) return undefined
  if (runoff !== undefined && !('runoffOf' in runoff)) return undefined
  try {
    const resolution = resolve(first, runoff, decisions)
    return resolution.ok ? resolution.outcome : undefined
  } catch {
    return undefined
  }
}

type Shape = { ok: true, document: ExportDocument } | { ok: false, problem: string }

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isList = (value: unknown, item: (entry: unknown) => boolean): boolean => Array.isArray(value) && value.every(item)
const isText = (value: unknown): boolean => typeof value === 'string'
const isTextList = (value: unknown): boolean => isList(value, isText)

/**
 * Whether `input` has the shape the checks read, section by section, so a
 * damaged file is a named failure and never a crash; what is wrong inside
 * a well-shaped file, the checks find.
 */
function asDocument(input: unknown): Shape {
  const problem = (what: string): Shape => ({ ok: false, problem: `not a ${EXPORT_FORMAT} document of version ${EXPORT_VERSION}: ${what}` })
  if (!isObject(input)) return problem('not an object')
  if (input.format !== EXPORT_FORMAT || input.version !== EXPORT_VERSION) return problem(`format ${String(input.format)}, version ${String(input.version)}`)
  if (!isText(input.exportedAt) || !isObject(input.app) || !isObject(input.election) || !isText(input.election.title) || !isObject(input.election.lifecycle)) return problem('the election or the app section')
  if (!isList(input.contests, (contest) => isObject(contest) && isText(contest.id) && isText(contest.title) && isText(contest.rulesetId)
    && isList(contest.candidates, (candidate) => isObject(candidate) && isText(candidate.id)))) return problem('the contests section')
  if (!isList(input.voterGroups, (group) => isObject(group) && isText(group.id) && isTextList(group.contestIds))) return problem('the voter groups section')
  if (!isList(input.batches, (batch) => isObject(batch) && isText(batch.id) && typeof batch.keys === 'number')) return problem('the batches section')
  if (!isList(input.rounds, (round) => isObject(round) && isText(round.kind) && isText(round.state)
    && isList(round.boxes, (box) => isObject(box) && isText(box.id) && isText(box.contestId) && (box.runoffPair === null || isTextList(box.runoffPair))
      && isObject(box.entitlements) && typeof box.entitlements.issued === 'number' && typeof box.entitlements.used === 'number'
      && isList(box.ballots, (ballot) => isObject(ballot) && isText(ballot.kind) && isTextList(ballot.ranking))))) return problem('the rounds section')
  if (!isList(input.snapshots, (snapshot) => isObject(snapshot) && isText(snapshot.contestId) && isText(snapshot.round) && isText(snapshot.inputSha256) && 'result' in snapshot && 'outcome' in snapshot)) return problem('the snapshots section')
  if (!isList(input.lots, (lot) => isObject(lot) && isText(lot.contestId) && isText(lot.lotId) && isTextList(lot.candidates) && isTextList(lot.drawn) && isText(lot.reason) && isText(lot.actorName) && isText(lot.recordedAt))) return problem('the lots section')
  if (!isList(input.outcomes, (entry) => isObject(entry) && isText(entry.contestId) && isObject(entry.outcome) && isText(entry.outcome.kind))) return problem('the outcomes section')
  if (!isObject(input.audit) || !isObject(input.audit.chain) || !isList(input.audit.events, (event) => isObject(event) && isText(event.action) && isObject(event.metadata) && isObject(event.actor) && isText(event.at))) return problem('the audit section')
  return { ok: true, document: input as unknown as ExportDocument }
}

/** Every string anywhere in a JSON value. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(strings)
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(strings)
  return []
}
