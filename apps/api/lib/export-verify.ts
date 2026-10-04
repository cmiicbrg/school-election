// The offline verifier of an export: from the file alone, recomputes every
// snapshot's digest and result with election-core, the outcome of every
// snapshot as of its close and of every contest as it stands with the
// recorded lots, the declared outcomes of a final election against them,
// checks the audit chain and what its events say against the file, and
// looks for anything that could be a key. Pure, like the
// audit chain: election-core, canonical JSON, the audit chain, the digest
// module and the format, and nothing else, which ESLint keeps; the same
// functions the server tallies with, from a checkout, with no server and
// no database (scripts/verify.ts).

import { firstRoundResult, parseKey, pollOutcome, resolve, ROUND_STATES, runoffResult, TALLY_VERSION, type Contest, type FirstRoundResult, type LotDecision, type Outcome, type RulesetId, type RunoffResult } from '@school-election/election-core'
import { verifyAuditChain, type AuditEvent } from './audit-chain.ts'
import { canonicalJson } from './canonical-json.ts'
import { EXPORT_FORMAT, EXPORT_VERSION, type ExportDocument, type ExportedBox, type ExportedSnapshot } from './export-format.ts'
import { ballotsOf, inputDigest, sortedByContent, TallyError } from './tally-digest.ts'

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

type RoundResult = FirstRoundResult | RunoffResult

/** What the checks share: the document, the report they write to, and what they look up in the file. */
interface Run {
  document: ExportDocument
  check: (name: string, ok: boolean, detail: string) => void
  titleOf: (contestId: string) => string
  /** The recomputed result of every box of a closed round, by contest and round kind. */
  results: Map<string, RoundResult>
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
  const { document } = shape
  const contests = new Map(document.contests.map((contest) => [contest.id, contest]))
  const run: Run = { document, check, titleOf: (contestId) => contests.get(contestId)?.title ?? contestId, results: new Map() }
  try {
    check('format', true, `${EXPORT_FORMAT} version ${EXPORT_VERSION}, election ${document.election.title}, exported ${document.exportedAt}`)
    checkSnapshotsOnePerBox(run)
    for (const round of document.rounds) {
      if (round.state === 'closed') {
        for (const box of round.boxes) checkBox(run, round.kind, box)
      } else {
        checkRoundNotClosed(run, round)
      }
    }
    checkOutcomes(run)
    checkFinalization(run)
    checkChain(run)
    checkImpliedEvents(run)
    checkEvents(run)
    checkBatches(run)
    checkLots(run)
    checkNoKey(run)
  } catch (err) {
    check('document', false, `the file is damaged: ${err instanceof Error ? err.message : String(err)}`)
  }
  return { ok: checks.every((entry) => entry.ok), checks }
}

/** One snapshot per box of a closed round, and none for anything else: the checks read the one. */
function checkSnapshotsOnePerBox({ document, check }: Run): void {
  const boxes = document.rounds.filter((round) => round.state === 'closed').flatMap((round) => round.boxes.map((box) => `${box.contestId}/${round.kind}`))
  const keys = document.snapshots.map((snapshot) => `${snapshot.contestId}/${snapshot.round}`)
  const oneEach = boxes.every((key) => keys.filter((entry) => entry === key).length === 1) && keys.length === boxes.length
  check('snapshots: one per box', oneEach, `${keys.length} snapshots for ${boxes.length} boxes of closed rounds`)
}

/** A round that is not closed: in a state the lifecycle knows, with no ballots in any box, as the export writes it. */
function checkRoundNotClosed({ check }: Run, round: ExportDocument['rounds'][number]): void {
  const known = (ROUND_STATES as readonly string[]).includes(round.state)
  const empty = round.boxes.every((box) => box.ballots.length === 0)
  let detail = 'no ballots, as a round not closed has none in the file'
  if (!known) detail = 'a state the lifecycle does not know'
  else if (!empty) detail = 'a box of a round not closed carries ballots'
  check(`${round.kind} round, ${round.state}`, known && empty, detail)
}

/** A box of a closed round: the rows as written, the ballots, the digest, the result and the outcome as of the close. */
function checkBox(run: Run, kind: string, box: ExportedBox): void {
  const { document, check, titleOf } = run
  const label = `${kind} round, ${titleOf(box.contestId)}`
  const contest = contestOf(document, box)
  if (!contest) {
    check(`ballots: ${label}`, false, 'the box belongs to no contest of the file')
    return
  }
  const bare = box.ballots.every((ballot) => ballot.kind === 'ranking' || ballot.ranking.length === 0)
  check(`rows: ${label}`, bare, bare ? `${box.ballots.length} rows, "Nein" and invalid votes naming nobody` : 'a "Nein" or an invalid vote names a candidate')
  const inOrder = canonicalJson(box.ballots) === canonicalJson(sortedByContent(contest, box.ballots))
  check(`order: ${label}`, inOrder, inOrder ? 'in content order' : 'the rows are not in content order')
  let ballots
  try {
    ballots = ballotsOf(contest, box.ballots)
  } catch (err) {
    check(`ballots: ${label}`, false, err instanceof TallyError ? err.message : String(err))
    return
  }
  const counts = ballots.length === box.entitlements.used && box.entitlements.used <= box.entitlements.issued && box.entitlements.used >= 0
  check(`ballots: ${label}`, counts, `${ballots.length} ballots, ${box.entitlements.used} of ${box.entitlements.issued} entitlements used`)
  const snapshot = document.snapshots.find((entry) => entry.contestId === box.contestId && entry.round === kind)
  if (!snapshot) {
    check(`snapshot: ${label}`, false, 'no snapshot in the file')
    return
  }
  const digest = inputDigest(contest, ballots)
  check(`digest: ${label}`, digest === snapshot.inputSha256, digest === snapshot.inputSha256 ? digest : `recomputed ${digest}, the snapshot says ${snapshot.inputSha256}`)
  const result = resultOf(contest, ballots, kind)
  run.results.set(`${box.contestId}/${kind}`, result)
  const same = canonicalJson(result) === canonicalJson(snapshot.result)
  check(`result: ${label}`, same, same ? `${result.kind}, recomputed from ${ballots.length} ballots` : 'the recomputed result differs from the snapshot')
  checkOutcomeAtClose(run, label, box, kind, result, snapshot)
}

/** The result of a box as the count computes it: a runoff over its pair, a poll's one round, or a ranked first round. */
function resultOf(contest: Contest, ballots: ReturnType<typeof ballotsOf>, kind: string): RoundResult {
  if (kind === 'runoff') return runoffResult(contest, ballots, contest.id)
  if (contest.rulesetId === 'single-choice-v1') return runoffResult(contest, ballots, null)
  return firstRoundResult(contest, ballots)
}

/** The outcome the snapshot stored at its close: the runoff's with the lots recorded before the runoff closed, as the log dates them. */
function checkOutcomeAtClose(run: Run, label: string, box: ExportedBox, kind: string, result: RoundResult, snapshot: ExportedSnapshot): void {
  const { document, check } = run
  const rulesetId = document.contests.find((contest) => contest.id === box.contestId)?.rulesetId ?? 'single-choice-v1'
  let atClose: Outcome | undefined
  if (kind === 'runoff') {
    const closedAt = document.audit.events.find((event) => event.action === 'round.closed' && event.metadata.round === 'runoff')?.at
    atClose = outcomeOf(rulesetId, run.results.get(`${box.contestId}/regular`), result, closedAt === undefined ? [] : decisionsOf(document, box.contestId, closedAt))
  } else {
    atClose = outcomeOf(rulesetId, result, undefined, [])
  }
  if (atClose === undefined) {
    check(`outcome at close: ${label}`, false, 'could not be resolved')
    return
  }
  const same = canonicalJson(atClose) === canonicalJson(snapshot.outcome)
  check(`outcome at close: ${label}`, same, same ? atClose.kind : 'the outcome at the close differs from the snapshot')
}

/** Every contest has its outcome as it stands, once; each is the stored results and every recorded lot resolved. */
function checkOutcomes(run: Run): void {
  const { document, check, titleOf } = run
  const listed = document.outcomes.map((entry) => entry.contestId)
  const complete = document.contests.every((contest) => listed.filter((id) => id === contest.id).length === 1) && listed.length === document.contests.length
  check('outcomes: one per contest', complete, complete ? `${document.contests.length} contests, ${document.outcomes.length} outcomes` : `${document.contests.length} contests, but outcomes for ${listed.map(titleOf).join(', ') || 'none'}`)
  for (const entry of document.outcomes) {
    const label = titleOf(entry.contestId)
    const contest = document.contests.find((candidate) => candidate.id === entry.contestId)
    const first = run.results.get(`${entry.contestId}/regular`)
    if (!contest || !first) {
      check(`outcome: ${label}`, false, 'no verified first-round result for this contest')
      continue
    }
    const outcome = outcomeOf(contest.rulesetId, first, run.results.get(`${entry.contestId}/runoff`), decisionsOf(document, entry.contestId))
    const same = outcome !== undefined && canonicalJson(outcome) === canonicalJson(entry.outcome)
    check(`outcome: ${label}`, same, same ? outcome.kind : 'the outcome resolved from the results and the lots differs from the file')
  }
}

/**
 * A final election has its declaration: one election.finalized event,
 * after which only exports follow; the declared outcome of every contest,
 * once, equal to the outcome resolved now from the results and the lots
 * (a later election-core deriving differently is named with both
 * versions); and the event's counts are the declared kinds'. An election
 * not final has neither.
 */
function checkFinalization(run: Run): void {
  const { document, check, titleOf } = run
  const final = document.election.state === 'final'
  const declarations = document.audit.events.filter((event) => event.action === 'election.finalized')
  const declaration = declarations[0]
  if (!final || declaration === undefined || declarations.length !== 1) {
    const none = !final && declarations.length === 0 && document.finalOutcomes.length === 0
    let detail = 'not final: no declaration and no declared outcome, as it should be'
    if (final) detail = `${declarations.length} election.finalized events for a final election`
    else if (declarations.length > 0) detail = 'an election.finalized event, but the election is not final'
    else if (document.finalOutcomes.length > 0) detail = 'declared outcomes, but the election is not final'
    check('finalization', none, detail)
    return
  }
  const later = document.audit.events.filter((event) => event.seq > declaration.seq && event.action !== 'export.generated').map((event) => event.action)
  check('finalization', later.length === 0, later.length === 0 ? `declared at ${declaration.at} by ${declaration.actor.name}, exports only since` : `changed after the declaration: ${later.join(', ')}`)
  const listed = document.finalOutcomes.map((entry) => entry.contestId)
  const complete = document.contests.every((contest) => listed.filter((id) => id === contest.id).length === 1) && listed.length === document.contests.length
  check('final outcomes: one per contest', complete, complete ? `${document.contests.length} contests, ${document.finalOutcomes.length} declared outcomes` : `${document.contests.length} contests, but declared outcomes for ${listed.map(titleOf).join(', ') || 'none'}`)
  let resolved = 0
  for (const entry of document.finalOutcomes) {
    const label = titleOf(entry.contestId)
    const contest = document.contests.find((candidate) => candidate.id === entry.contestId)
    const first = run.results.get(`${entry.contestId}/regular`)
    if (!contest || !first) {
      check(`final outcome: ${label}`, false, 'no verified first-round result for this contest')
      continue
    }
    const outcome = outcomeOf(contest.rulesetId, first, run.results.get(`${entry.contestId}/runoff`), decisionsOf(document, entry.contestId))
    const same = outcome !== undefined && entry.kind === entry.outcome.kind && canonicalJson(outcome) === canonicalJson(entry.outcome)
    const versions = `declared with tally version ${entry.tallyVersion} by ${entry.appVersion} (${entry.gitSha})`
    check(`final outcome: ${label}`, same, same ? `${entry.kind}, ${versions}` : `the declared outcome differs from the one resolved now: ${versions}, verified with tally version ${TALLY_VERSION}`)
    if (entry.kind === 'final') resolved += 1
  }
  const unresolved = document.finalOutcomes.length - resolved
  const counted = declaration.metadata.resolved === resolved && declaration.metadata.unresolved === unresolved
  check(`event ${declaration.seq} election.finalized`, counted, counted ? `${resolved} resolved, ${unresolved} unresolved; reason: ${field(declaration.metadata, 'reason')}` : `says ${field(declaration.metadata, 'resolved')} resolved and ${field(declaration.metadata, 'unresolved')} unresolved, the declared outcomes give ${resolved} and ${unresolved}`)
}

/** The audit chain: of this election, recomputed, as exported, and not empty. */
function checkChain({ document, check }: Run): void {
  const { events } = document.audit
  const ofThisElection = events.length > 0 && events.every((event) => event.electionId === document.election.id)
  check('audit chain of this election', ofThisElection, ofThisElection ? `every event names election ${document.election.id}` : 'the events name another election than the file')
  const chain = verifyAuditChain(events)
  let detail = 'no events: an election has at least its creation'
  if (!chain.valid) detail = `broken at event ${chain.index}: ${chain.problem}`
  else if (chain.length > 0) detail = `${chain.length} events, head ${chain.head ?? 'none'}`
  check('audit chain', chain.valid && chain.length > 0, detail)
  const asExported = canonicalJson(chain) === canonicalJson(document.audit.chain)
  check('audit chain as exported', asExported, asExported ? 'the recomputed chain is the one the file states' : 'the file states another chain than its events give')
}

/** The events the file's rounds and snapshots imply: every close, the runoff's activation, every result with its digest. */
function checkImpliedEvents({ document, check, titleOf }: Run): void {
  const { events } = document.audit
  for (const round of document.rounds) {
    if (round.state !== 'closed') continue
    const closed = events.some((event) => event.action === 'round.closed' && event.metadata.round === round.kind)
    check(`event for the close of the ${round.kind} round`, closed, closed ? 'in the log' : 'no round.closed event in the file')
    if (round.kind !== 'runoff') continue
    const activated = events.some((event) => event.action === 'runoff.activated')
    check('event for the activation of the runoff', activated, activated ? 'in the log' : 'no runoff.activated event in the file')
  }
  for (const snapshot of document.snapshots) {
    const computed = events.some((event) => event.action === 'result.computed' && event.metadata.contest === snapshot.contestId && event.metadata.round === snapshot.round && event.metadata.inputSha256 === snapshot.inputSha256)
    check(`event for the result: ${snapshot.round} round, ${titleOf(snapshot.contestId)}`, computed, computed ? 'in the log, with the digest' : 'no result.computed event with this digest in the file')
  }
}

/** What the events say against the file: every count, digest and pair an event names is the file's. */
function checkEvents(run: Run): void {
  for (const event of run.document.audit.events) {
    switch (event.action) {
      case 'result.computed':
        checkResultEvent(run, event)
        break
      case 'round.closed':
        checkCloseEvent(run, event)
        break
      case 'runoff.pair':
        checkPairEvent(run, event)
        break
      case 'export.generated':
        run.check(`event ${event.seq} export.generated`, true, `an earlier export, ${field(event.metadata, 'bytes')} bytes, ${field(event.metadata, 'sha256')}`)
        break
      default:
        break
    }
  }
}

function checkResultEvent({ document, check, titleOf }: Run, event: AuditEvent): void {
  const contest = field(event.metadata, 'contest')
  const round = field(event.metadata, 'round')
  const snapshot = document.snapshots.find((entry) => entry.contestId === contest && entry.round === round)
  const ballots = document.rounds.find((entry) => entry.kind === round)?.boxes.find((box) => box.contestId === contest)?.ballots.length
  const ok = snapshot !== undefined && snapshot.inputSha256 === event.metadata.inputSha256 && ballots === event.metadata.ballots
  check(`event ${event.seq} result.computed: ${titleOf(contest)}`, ok, ok ? 'names the snapshot\'s digest and the ballots counted' : 'does not match the snapshot or the ballots in the file')
}

function checkCloseEvent({ document, check }: Run, event: AuditEvent): void {
  const round = field(event.metadata, 'round')
  const total = document.rounds.find((entry) => entry.kind === round)?.boxes.reduce((sum, box) => sum + box.ballots.length, 0)
  check(`event ${event.seq} round.closed: ${round}`, total === event.metadata.ballots, `${field(event.metadata, 'ballots')} ballots in the log, ${total ?? 'no such round'} in the file`)
}

function checkPairEvent({ document, check, titleOf }: Run, event: AuditEvent): void {
  const contest = field(event.metadata, 'contest')
  const box = document.rounds.find((round) => round.kind === 'runoff')?.boxes.find((entry) => entry.contestId === contest)
  const pair = sortedText([field(event.metadata, 'first'), field(event.metadata, 'second')])
  const ok = box?.runoffPair !== null && box !== undefined && sortedText(box.runoffPair).join() === pair.join()
  check(`event ${event.seq} runoff.pair: ${titleOf(contest)}`, ok, ok ? 'names the box\'s pair' : 'does not name the runoff box\'s pair')
}

/**
 * Batches and their events, both ways: every batch was issued, or issued
 * as a replacement, with as many keys, for its group and round, as the
 * log says; a void batch was replaced or voided, an issued one was not;
 * and every issuing event's batch is in the file.
 */
function checkBatches({ document, check }: Run): void {
  const { events } = document.audit
  for (const batch of document.batches) {
    const issued = events.find((event) => (event.action === 'credential-batch.issued' && event.metadata.batch === batch.id) || (event.action === 'credential-batch.replaced' && event.metadata.replacement === batch.id))
    const asIssued = issued?.metadata.keys === batch.keys && issued.metadata.group === batch.voterGroupId && issued.metadata.round === batch.roundKind
    const voided = events.some((event) => (event.action === 'credential-batch.replaced' || event.action === 'credential-batch.voided') && event.metadata.batch === batch.id)
    const stated = batch.state === 'issued' || batch.state === 'void'
    const ok = asIssued && stated && voided === (batch.state === 'void')
    let detail = 'no event issues this batch with these keys for this group and round'
    if (ok) detail = `${batch.keys} keys, as event ${issued.seq} says`
    else if (asIssued) detail = stated ? 'the log says otherwise about its state' : `a state the file does not know: ${batch.state}`
    check(`batch ${batch.id}: ${batch.roundKind}, ${batch.state}`, ok, detail)
  }
  for (const event of events) {
    const id = issuedBatchOf(event)
    if (id === undefined) continue
    const present = document.batches.some((batch) => batch.id === id)
    check(`event ${event.seq} ${event.action}`, present, present ? 'the batch it issues is in the file' : 'the batch it issues is not in the file')
  }
}

/** The batch an event issued, as a batch or as a replacement; undefined for any other event. */
function issuedBatchOf(event: AuditEvent): string | undefined {
  if (event.action === 'credential-batch.issued') return field(event.metadata, 'batch')
  if (event.action === 'credential-batch.replaced') return field(event.metadata, 'replacement')
  return undefined
}

/**
 * Lots and their events, both ways: every lot has its event with the same
 * set, order, reason and actor, recorded in the same moment (the row's
 * time is the transaction's start, the event's its end, so the event is
 * not before the row and not a minute after it), and every event its lot.
 */
function checkLots({ document, check, titleOf }: Run): void {
  const { events } = document.audit
  for (const lot of document.lots) {
    const event = lotEventOf(document, lot.contestId, lot.lotId)
    const same = event?.metadata.order === lot.drawn.join(',') && event.metadata.candidates === lot.candidates.join(',') && event.metadata.reason === lot.reason && event.actor.name === lot.actorName
    const timed = event?.at !== undefined && lot.recordedAt <= event.at && Date.parse(event.at) - Date.parse(lot.recordedAt) < 60_000
    const ok = same && timed
    let detail = 'no event records this lot with this set, order, reason and actor'
    if (ok) detail = `recorded by ${lot.actorName} at ${event.at}, as event ${event.seq} says`
    else if (same) detail = `recorded at ${lot.recordedAt}, but the event says ${event.at}`
    check(`lot ${lot.lotId}: ${titleOf(lot.contestId)}`, ok, detail)
  }
  for (const event of events) {
    if (event.action !== 'lot.recorded') continue
    const lot = document.lots.find((entry) => entry.lotId === event.metadata.lotId && entry.contestId === event.metadata.contest)
    const ok = lot !== undefined && lot.drawn.join(',') === event.metadata.order
    check(`event ${event.seq} lot.recorded: ${titleOf(field(event.metadata, 'contest'))}`, ok, ok ? 'the lot it records is in the file' : 'the lot it records is not in the file, or not with this order')
  }
}

/** Nothing that could be a key: no string of the file, however spaced or hyphenated, is well formed as one. */
function checkNoKey({ document, check }: Run): void {
  const keys = strings(document).filter((value) => value.length <= 60 && parseKey(value).ok)
  check('no key', keys.length === 0, keys.length === 0 ? 'no string of the file is a well-formed key' : `${keys.length} strings of the file are well-formed keys`)
}

/** The event that recorded a lot, if the log has it. */
function lotEventOf(document: ExportDocument, contestId: string, lotId: string): AuditEvent | undefined {
  return document.audit.events.find((entry) => entry.action === 'lot.recorded' && entry.metadata.lotId === lotId && entry.metadata.contest === contestId)
}

/**
 * The decisions of a contest as resolve takes them, in the order recorded;
 * `before` keeps those recorded before a time, as the log dates them: the
 * event's time, which the chain covers, never the row's own.
 */
function decisionsOf(document: ExportDocument, contestId: string, before?: string): LotDecision[] {
  return document.lots
    .filter((lot) => lot.contestId === contestId && (before === undefined || (lotEventOf(document, contestId, lot.lotId)?.at ?? '') < before))
    .map((lot) => ({ lotId: lot.lotId, order: lot.drawn }))
}

/** A metadata field as text: the log holds strings and numbers there, nothing else. */
function field(metadata: Readonly<Record<string, unknown>>, key: string): string {
  const value = metadata[key]
  if (typeof value === 'string') return value
  return typeof value === 'number' ? String(value) : ''
}

/** Code unit order, the same on every machine; never the locale's. */
function compareText(a: string, b: string): number {
  if (a < b) return -1
  return a > b ? 1 : 0
}

const sortedText = (values: readonly string[]): string[] => [...values].sort(compareText)

/** The box's contest as election-core sees it: the pair as a single-choice contest for a runoff box. */
function contestOf(document: ExportDocument, box: ExportedBox): Contest | undefined {
  const contest = document.contests.find((entry) => entry.id === box.contestId)
  if (!contest) return undefined
  const ids = contest.candidates.map((candidate) => candidate.id)
  if (box.runoffPair === null) return { id: contest.id, rulesetId: contest.rulesetId, candidateIds: ids }
  const pair = box.runoffPair
  return { id: contest.id, rulesetId: 'single-choice-v1', candidateIds: ids.filter((id) => pair.includes(id)) }
}

/**
 * election-core's outcome from a first-round result, a runoff's where there
 * is one, and decisions, for a contest of the given ruleset (the contest's
 * as configured: a runoff box is counted as a single choice, but it decides
 * a ranked contest); undefined where it cannot be resolved.
 */
function outcomeOf(rulesetId: RulesetId, first: RoundResult | undefined, runoff: RoundResult | undefined, decisions: LotDecision[]): Outcome | undefined {
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
const isNumber = (value: unknown): boolean => typeof value === 'number'
const isTextList = (value: unknown): boolean => isList(value, isText)
/** An object with exactly these keys: the export is an allow-list, and so is what the verifier accepts. */
const hasKeys = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => isObject(value) && Object.keys(value).sort(compareText).join() === [...keys].sort(compareText).join()

const isCandidate = (candidate: unknown): boolean => hasKeys(candidate, ['id', 'surname', 'givenName']) && isText(candidate.id) && isText(candidate.surname) && isText(candidate.givenName)
const isContest = (contest: unknown): boolean => hasKeys(contest, ['id', 'title', 'rulesetId', 'candidates']) && isText(contest.id) && isText(contest.title) && isText(contest.rulesetId) && isList(contest.candidates, isCandidate)
const isBallot = (ballot: unknown): boolean => hasKeys(ballot, ['kind', 'ranking']) && isText(ballot.kind) && isTextList(ballot.ranking)
const isBox = (box: unknown): boolean => hasKeys(box, ['id', 'contestId', 'runoffPair', 'entitlements', 'ballots']) && isText(box.id) && isText(box.contestId) && (box.runoffPair === null || isTextList(box.runoffPair))
  && hasKeys(box.entitlements, ['issued', 'used']) && isNumber(box.entitlements.issued) && isNumber(box.entitlements.used) && isList(box.ballots, isBallot)
const isRound = (round: unknown): boolean => hasKeys(round, ['kind', 'state', 'boxes']) && isText(round.kind) && isText(round.state) && isList(round.boxes, isBox)
const isSnapshot = (snapshot: unknown): boolean => hasKeys(snapshot, ['contestId', 'round', 'inputSha256', 'tallyVersion', 'appVersion', 'gitSha', 'result', 'outcome'])
  && isText(snapshot.contestId) && isText(snapshot.round) && isText(snapshot.inputSha256) && isNumber(snapshot.tallyVersion) && isText(snapshot.appVersion) && isText(snapshot.gitSha)
const isLot = (lot: unknown): boolean => hasKeys(lot, ['id', 'contestId', 'lotId', 'candidates', 'drawn', 'reason', 'actorName', 'recordedAt'])
  && isText(lot.id) && isText(lot.contestId) && isText(lot.lotId) && isTextList(lot.candidates) && isTextList(lot.drawn) && isText(lot.reason) && isText(lot.actorName) && isText(lot.recordedAt)
const isOutcome = (entry: unknown): boolean => hasKeys(entry, ['contestId', 'outcome']) && isText(entry.contestId) && isObject(entry.outcome) && isText(entry.outcome.kind)
const isFinalOutcome = (entry: unknown): boolean => hasKeys(entry, ['contestId', 'kind', 'outcome', 'tallyVersion', 'appVersion', 'gitSha'])
  && isText(entry.contestId) && isText(entry.kind) && isObject(entry.outcome) && isText(entry.outcome.kind) && isNumber(entry.tallyVersion) && isText(entry.appVersion) && isText(entry.gitSha)
const isEvent = (event: unknown): boolean => hasKeys(event, ['seq', 'electionId', 'at', 'actor', 'action', 'metadata', 'prevHash', 'hash'])
  && isNumber(event.seq) && isText(event.electionId) && isText(event.at) && hasKeys(event.actor, ['tid', 'oid', 'name']) && isText(event.action) && isObject(event.metadata) && (event.prevHash === null || isText(event.prevHash)) && isText(event.hash)
const isBatch = (batch: unknown): boolean => hasKeys(batch, ['id', 'voterGroupId', 'roundKind', 'state', 'keys']) && isText(batch.id) && isText(batch.voterGroupId) && isText(batch.roundKind) && isText(batch.state) && isNumber(batch.keys)
const isGroup = (group: unknown): boolean => hasKeys(group, ['id', 'name', 'contestIds']) && isText(group.id) && isText(group.name) && isTextList(group.contestIds)

/**
 * Whether `input` has the shape the checks read, section by section, so a
 * damaged file is a named failure and never a crash; what is wrong inside
 * a well-shaped file, the checks find.
 */
function asDocument(input: unknown): Shape {
  const problem = (what: string): Shape => ({ ok: false, problem: `not a ${EXPORT_FORMAT} document of version ${EXPORT_VERSION}: ${what}` })
  if (!isObject(input)) return problem('not an object')
  if (input.format !== EXPORT_FORMAT || input.version !== EXPORT_VERSION) return problem(`format ${String(input.format)}, version ${String(input.version)}`)
  if (!hasKeys(input, ['format', 'version', 'exportedAt', 'app', 'election', 'contests', 'voterGroups', 'batches', 'rounds', 'snapshots', 'lots', 'outcomes', 'finalOutcomes', 'audit'])) return problem('the sections are not exactly the format\'s')
  if (!isText(input.exportedAt) || !hasKeys(input.app, ['version', 'gitSha', 'tallyVersion']) || !isText(input.app.version) || !isText(input.app.gitSha) || !isNumber(input.app.tallyVersion)) return problem('the app section')
  if (!hasKeys(input.election, ['id', 'title', 'description', 'state', 'lifecycle']) || !isText(input.election.id) || !isText(input.election.title) || !isText(input.election.description) || !isText(input.election.state)
    || !hasKeys(input.election.lifecycle, ['election', 'regular', 'runoff'])) return problem('the election section')
  const sections: [string, unknown, (entry: unknown) => boolean][] = [
    ['contests', input.contests, isContest],
    ['voter groups', input.voterGroups, isGroup],
    ['batches', input.batches, isBatch],
    ['rounds', input.rounds, isRound],
    ['snapshots', input.snapshots, isSnapshot],
    ['lots', input.lots, isLot],
    ['outcomes', input.outcomes, isOutcome],
    ['final outcomes', input.finalOutcomes, isFinalOutcome],
  ]
  for (const [name, value, item] of sections) {
    if (!isList(value, item)) return problem(`the ${name} section`)
  }
  if (!hasKeys(input.audit, ['events', 'chain']) || !isObject(input.audit.chain) || !isList(input.audit.events, isEvent)) return problem('the audit section')
  return { ok: true, document: input as unknown as ExportDocument }
}

/** Every string anywhere in a JSON value. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(strings)
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(strings)
  return []
}
