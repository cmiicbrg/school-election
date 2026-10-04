// The privacy regression at the SQL level: votes cast the way the ballot
// transaction will, and the seal, with the shared scenario and assertions
// of test/helpers/privacy.ts.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lockElection } from '../../lib/audit.ts'
import { createDatabase } from '../../lib/db.ts'
import { closeAndTally, closeRound } from '../../lib/rounds.ts'
import { DB, withClient } from '../helpers/db.ts'
import { accessAs } from '../helpers/elections.ts'
import { assertUnlinkable, castBallotCaster, openScenario, seedPrivacyScenario, sqlCaster, voteInterleaved } from '../helpers/privacy.ts'

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
