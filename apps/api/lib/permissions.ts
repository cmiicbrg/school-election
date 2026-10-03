// What each role in an election may do: a role and an action in, yes or no
// out. Whether the action is possible in the election's current state is
// the lifecycle's question (election-core), asked after this one.
//
//   owner    everything: the teacher who created the election;
//   admin    everything but managing members and finalizing: a co-admin;
//   witness  reading only, results only once their round has closed (as
//            for everyone: no role sees a result while voting is open).
//
// No global role appears here. Being a teacher lets a person create an
// election, never see another teacher's.

export const ELECTION_ROLES = ['owner', 'admin', 'witness'] as const
export type ElectionRole = typeof ELECTION_ROLES[number]

/** Co-admins and witnesses are invited; the owner is the creator. */
export const INVITED_ROLES = ['admin', 'witness'] as const
export type InvitedRole = typeof INVITED_ROLES[number]

export const ELECTION_ACTIONS = [
  'view', // the election, its members and its audit log
  'view-results', // a round's result
  'configure', // title, description, contests, candidates, voter groups
  'prepare', // prepare and unprepare
  'issue-keys', // issue, top up and replace batches of keys, print their sheets
  'run-rounds', // open and close rounds, activate the runoff
  'enter-lot', // record the outcome of a lot the officials drew
  'manage-members', // invite and remove co-admins and witnesses
  'finalize',
] as const
export type ElectionAction = typeof ELECTION_ACTIONS[number]

const READ_ONLY: ReadonlySet<ElectionAction> = new Set(['view', 'view-results'])
const OWNER_ONLY: ReadonlySet<ElectionAction> = new Set(['manage-members', 'finalize'])

export function isPermitted(role: ElectionRole, action: ElectionAction): boolean {
  switch (role) {
    case 'owner':
      return true
    case 'admin':
      return !OWNER_ONLY.has(action)
    case 'witness':
      return READ_ONLY.has(action)
  }
}

/** Every action the role may perform, in a fixed order; the web app shows what the caller may do. */
export function permissionsOf(role: ElectionRole): ElectionAction[] {
  return ELECTION_ACTIONS.filter((action) => isPermitted(role, action))
}
