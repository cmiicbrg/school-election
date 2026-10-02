// SQLSTATE codes the application reacts to. Matched by code, never by
// message: messages are localised and may quote values.

export const SQLSTATE = {
  duplicateObject: '42710',
  insufficientPrivilege: '42501',
  undefinedTable: '42P01',
} as const

export function sqlState(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined
  const code = (err).code
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : undefined
}
