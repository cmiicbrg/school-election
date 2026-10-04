// The privacy regression at the SQL level: votes cast the way the ballot
// transaction will, and the seal, with the shared scenario and assertions
// of test/helpers/privacy.ts.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateBallot } from '@school-election/election-core'
import { lockElection } from '../../lib/audit.ts'
import { castBallot } from '../../lib/ballot-box.ts'
import { createDatabase } from '../../lib/db.ts'
import { buildExport } from '../../lib/export.ts'
import type { ExportDocument, ExportedBox } from '../../lib/export-format.ts'
import { closeAndTally, closeRound } from '../../lib/rounds.ts'
import { DB, withClient } from '../helpers/db.ts'
import { accessAs } from '../helpers/elections.ts'
import { buildTestApp } from '../helpers/app.ts'
import { assertUnlinkable, ballotInput, castBallotCaster, openScenario, plannedRunoffVotes, runoffScenario, seedPrivacyScenario, sqlCaster, voteInterleaved, type Caster, type PrivacyScenario } from '../helpers/privacy.ts'

test('one key voting in three contests among fifty others leaves no trace of which ballots were its', DB, async (t) => {
  const scenario = await seedPrivacyScenario(t)
  await withClient(scenario.runtimeUrl, (client) => voteInterleaved(scenario, sqlCaster(client, scenario)))

  // Before the seal the link is there, which is what the seal is for: each
  // staged ballot shares its transaction id with the entitlement it used.
  await withClient(scenario.ownerUrl, async (client) => {
    const { rows: [linked] } = await client.query<{ n: number }>(
      `select count(*)::int as n from ballot_box b join credential_entitlement e on e.xmin = b.xmin where e.credential_id = $1`,
      [scenario.tracked],
    )
    assert.equal(linked?.n, 3)
  })

  await withClient(scenario.runtimeUrl, (client) => client.query('select seal_round($1)', [scenario.roundId]))
  await assertUnlinkable(scenario)
})

test('the same holds through castBallot and closeRound, the production code', DB, async (t) => {
  const scenario = await seedPrivacyScenario(t)
  const db = createDatabase(scenario.runtimeUrl, () => {})
  t.after(() => db.close())
  await voteInterleaved(scenario, castBallotCaster(db, scenario))
  const access = await accessAs(scenario.ownerUrl, scenario.electionId, 'owner')
  const { ballots } = await db.tx(async (client) => {
    await lockElection(client, scenario.electionId)
    return closeRound(client, access, 'regular')
  })
  assert.equal(ballots, scenario.castOrder.length)
  await assertUnlinkable(scenario)
})

test('and through closeAndTally, which the close route runs: the count reads only what the seal wrote', DB, async (t) => {
  const scenario = await seedPrivacyScenario(t)
  const db = createDatabase(scenario.runtimeUrl, () => {})
  t.after(() => db.close())
  await voteInterleaved(scenario, castBallotCaster(db, scenario))
  const access = await accessAs(scenario.ownerUrl, scenario.electionId, 'owner')
  const closed = await db.tx(async (client) => {
    await lockElection(client, scenario.electionId)
    return closeAndTally(client, access, { version: 'dev', gitSha: 'unknown' })
  })
  assert.equal(closed.ballots, scenario.castOrder.length)
  assert.equal(closed.contests.length, scenario.contests.length)
  await assertUnlinkable(scenario)
  await withClient(scenario.ownerUrl, async (client) => {
    const { rows } = await client.query<{ n: number }>('select count(*)::int as n from result_snapshot')
    assert.equal(rows[0]?.n, scenario.contests.length)
  })
})

test('a test before the election leaves nothing of itself: its ballots removed, its entitlements unused, and the real votes sealed as always', DB, async (t) => {
  const scenario = await seedPrivacyScenario(t, { opened: false })
  const db = createDatabase(scenario.runtimeUrl, () => {})
  t.after(() => db.close())
  // The test: the direct update along the transition row, every key voting, another interleaving.
  await db.query('update round set state = $2 where id = $1', [scenario.roundId, 'testing'])
  await voteInterleaved(scenario, castBallotCaster(db, scenario), 7)
  const { rows: [ended] } = await db.query<{ ballots: number, keys: number }>('select ballots, keys from end_test($1)', [scenario.roundId])
  assert.deepEqual(ended, { ballots: scenario.castOrder.length, keys: scenario.credentialIds.length })
  await withClient(scenario.ownerUrl, async (client) => {
    const { rows: [left] } = await client.query<{ staged: number, used: number, state: string }>(
      `select (select count(*)::int from ballot_box) as staged, (select count(*)::int from credential_entitlement where consumed) as used,
              (select state from round where id = $1) as state`,
      [scenario.roundId],
    )
    assert.deepEqual(left, { staged: 0, used: 0, state: 'planned' })
    await openScenario(client)
  })
  // The election, over what the test left: the test's transaction ids stay on the list of what the seal must not keep.
  scenario.castOrder.length = 0
  await voteInterleaved(scenario, castBallotCaster(db, scenario))
  const access = await accessAs(scenario.ownerUrl, scenario.electionId, 'owner')
  const { ballots } = await db.tx(async (client) => {
    await lockElection(client, scenario.electionId)
    return closeRound(client, access, 'regular')
  })
  assert.equal(ballots, scenario.castOrder.length)
  await assertUnlinkable(scenario)
})

/** Casts through the voter routes, as a browser does: one session per key, redeemed with the key as printed, the ballot as the page sends it. */
async function httpCaster(scenario: PrivacyScenario, t: Parameters<typeof seedPrivacyScenario>[0]): Promise<Caster> {
  const db = createDatabase(scenario.runtimeUrl, () => {})
  t.after(() => db.close())
  const { app } = await buildTestApp({}, db)
  t.after(() => app.close())
  const keys = new Map(await withClient(scenario.ownerUrl, async (client) =>
    (await client.query<{ id: string, key: string }>('select id, key from credential')).rows.map((row) => [row.id, row.key] as const)))
  const cookies = new Map<string, string>()
  const sameOrigin = { 'sec-fetch-site': 'same-origin' }
  return async (vote) => {
    let cookie = cookies.get(vote.credentialId)
    if (cookie === undefined) {
      const redeemed = await app.inject({ method: 'POST', url: '/api/voter/session', headers: sameOrigin, payload: { key: keys.get(vote.credentialId) } })
      assert.equal(redeemed.statusCode, 200, redeemed.body)
      cookie = redeemed.cookies.map((c) => `${c.name}=${encodeURIComponent(c.value)}`).join('; ')
      cookies.set(vote.credentialId, cookie)
    }
    const contest = scenario.contests.find((c) => c.boxId === vote.boxId) ?? assert.fail('no contest for the box')
    const cast = await app.inject({ method: 'POST', url: '/api/voter/ballot', headers: { ...sameOrigin, cookie }, payload: { roundContestId: vote.boxId, ballot: ballotInput(vote, contest) } })
    assert.equal(cast.statusCode, 200, cast.body)
    const { rows: [written] } = await withClient(scenario.ownerUrl, (client) => client.query<{ xid: string }>(
      'select xmin::text as xid from credential_entitlement where credential_id = $1 and round_contest_id = $2',
      [vote.credentialId, vote.boxId],
    ))
    scenario.voteXids.add(written?.xid ?? assert.fail('the entitlement the vote used up'))
  }
}

test('and through the voter routes, the whole way a browser takes: redeemed keys, sealed cookies, ballots as the page sends them', DB, async (t) => {
  const scenario = await seedPrivacyScenario(t)
  await voteInterleaved(scenario, await httpCaster(scenario, t))
  const db = createDatabase(scenario.runtimeUrl, () => {})
  t.after(() => db.close())
  const access = await accessAs(scenario.ownerUrl, scenario.electionId, 'owner')
  const { ballots } = await db.tx(async (client) => {
    await lockElection(client, scenario.electionId)
    return closeRound(client, access, 'regular')
  })
  assert.equal(ballots, scenario.castOrder.length)
  await assertUnlinkable(scenario)
})

test('and through the runoff: fresh keys, one choice between the pair, a seal of its own, and nothing linkable in either round', DB, async (t) => {
  const scenario = await seedPrivacyScenario(t)
  const db = createDatabase(scenario.runtimeUrl, () => {})
  t.after(() => db.close())
  await voteInterleaved(scenario, castBallotCaster(db, scenario))
  const access = await accessAs(scenario.ownerUrl, scenario.electionId, 'owner')
  await db.tx(async (client) => {
    await lockElection(client, scenario.electionId)
    return closeAndTally(client, access, { version: 'dev', gitSha: 'unknown' })
  })
  await assertUnlinkable(scenario)

  // The runoff: its own keys, its own boxes for the pairs the outcomes give, through castBallot as the voter route casts it.
  const runoff = await runoffScenario(scenario, db)
  assert.ok(runoff.contests.length >= 1)
  await voteInterleaved(runoff, castBallotCaster(db, runoff), 2027, plannedRunoffVotes)
  // A first-round key has no say in the runoff, before and after its seal.
  const [box] = runoff.contests
  assert.ok(box)
  const first = await db.tx((client) => castBallot(client, {
    credentialId: scenario.tracked, roundContestId: box.boxId,
    contest: { id: box.contestId, rulesetId: 'single-choice-v1', candidateIds: box.candidateIds },
    ballot: ranking(box, box.candidateIds[0] ?? ''),
  }))
  assert.deepEqual(first, { cast: false, reason: 'not-entitled' })
  await withClient(scenario.runtimeUrl, (client) => client.query('select seal_round($1)', [runoff.roundId]))
  await assertUnlinkable(runoff)
  // The first round's rows are as the first seal left them; the keys of both rounds were never touched.
  scenario.credentialXmins = runoff.credentialXmins
  await assertUnlinkable(scenario)
})

/** One choice of the pair, as election-core accepts it for the runoff box. */
function ranking(box: PrivacyScenario['contests'][number], candidateId: string) {
  const checked = validateBallot({ id: box.contestId, rulesetId: 'single-choice-v1', candidateIds: box.candidateIds }, { kind: 'ranking', ranking: [candidateId] })
  assert.ok(checked.ok)
  return checked.ballot
}

test('the export of the election carries the tracked key\'s ballots by content among the others, in content order, and nothing that names a key or an entitlement', DB, async (t) => {
  const scenario = await seedPrivacyScenario(t)
  const db = createDatabase(scenario.runtimeUrl, () => {})
  t.after(() => db.close())
  await voteInterleaved(scenario, castBallotCaster(db, scenario))
  const access = await accessAs(scenario.ownerUrl, scenario.electionId, 'owner')
  await db.tx(async (client) => {
    await lockElection(client, scenario.electionId)
    return closeAndTally(client, access, { version: 'dev', gitSha: 'unknown' })
  })
  const built = await db.tx((client) => buildExport(client, scenario.electionId, { version: 'dev', gitSha: 'unknown' }))
  const { document, text } = built
  // Every ballot of every box, in content order, with no id and nothing but its kind and ranking.
  const round: ExportDocument['rounds'][number] | undefined = document.rounds[0]
  if (!round) assert.fail('no round in the export')
  assert.deepEqual([round.kind, round.state, document.rounds.length], ['regular', 'closed', 1])
  for (const box of round.boxes) {
    assert.equal(box.ballots.length, scenario.credentialIds.length)
    assert.deepEqual(box.entitlements, { issued: scenario.credentialIds.length, used: scenario.credentialIds.length })
    for (const ballot of box.ballots) assert.deepEqual(Object.keys(ballot).sort(), ['kind', 'ranking'])
    const keys = box.ballots.map((ballot) => `${ballot.kind}:${ballot.ranking.join(',')}`)
    const contest = scenario.contests.find((entry) => entry.boxId === box.id) ?? assert.fail('a box of the scenario')
    const position = new Map(contest.candidateIds.map((id, index) => [id, index]))
    const byContent = box.ballots.map((ballot) => `${ballot.kind}:${ballot.ranking.map((id) => position.get(id)).join(',')}`)
    assert.deepEqual(byContent, [...byContent].sort(), `box ${box.id} is in content order`)
    assert.equal(new Set(keys).size <= keys.length, true)
  }
  // The tracked key's three distinctive ballots are there, by content; which three they are, nothing says.
  for (const vote of scenario.castOrder.filter((entry) => entry.credentialId === scenario.tracked)) {
    const box: ExportedBox | undefined = round.boxes.find((entry) => entry.id === vote.boxId)
    if (!box) assert.fail('the box')
    assert.ok(box.ballots.some((ballot) => ballot.kind === vote.kind && ballot.ranking.join(',') === vote.ranking.join(',')), `the tracked ${vote.kind} ballot is in its box`)
  }
  // No key, no credential id, no entitlement row, nothing of a session.
  const { rows: keys } = await withClient(scenario.ownerUrl, (client) => client.query<{ key: string }>('select key from credential where election_id = $1', [scenario.electionId]))
  for (const secret of [...keys.map((row) => row.key), ...scenario.credentialIds, 'consumed', 'credential_id', 'voter-session']) {
    assert.ok(!text.includes(secret), `the export holds ${secret}`)
  }
  assert.deepEqual(Object.keys(document).sort(), ['app', 'audit', 'batches', 'contests', 'election', 'exportedAt', 'format', 'lots', 'outcomes', 'rounds', 'snapshots', 'version', 'voterGroups'])
})
