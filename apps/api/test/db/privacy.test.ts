// The privacy regression at the SQL level: votes cast the way the ballot
// transaction will, and the seal, with the shared scenario and assertions
// of test/helpers/privacy.ts.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DB, withClient } from '../helpers/db.ts'
import { assertUnlinkable, seedPrivacyScenario, sqlCaster, voteInterleaved } from '../helpers/privacy.ts'

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
