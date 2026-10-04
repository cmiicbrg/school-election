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
import { assertUnlinkable, castBallotCaster, seedPrivacyScenario, sqlCaster, voteInterleaved } from '../helpers/privacy.ts'

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
