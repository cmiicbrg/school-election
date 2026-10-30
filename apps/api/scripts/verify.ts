// Verifies an export of an election from the file alone: no server, no
// database, no environment. Prints the file's SHA-256, to compare with
// the audit log's export.generated event, and one line per check; exits
// 1 when a check fails or the file is not an export.
//
//   npm run verify -- wahl-<id>.json

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { verifyExport } from '../lib/export-verify.ts'

/**
 * A value for the terminal: every control character (C0, newline, carriage
 * return and tab included, DEL, C1) as a \u escape. The checks quote the
 * file's titles and names, and the file may be a tampered one: written raw,
 * an escape sequence in a title could move the cursor, hide what follows or
 * overwrite the digest above with another.
 */
const printable = (text: string): string => text.replaceAll(/\p{Cc}/gu, (char) => `\\u${(char.codePointAt(0) ?? 0).toString(16).padStart(4, '0')}`)

const [file] = process.argv.slice(2)
if (!file) {
  console.error('usage: npm run verify -- <export.json>')
  process.exit(2)
}

let bytes: Buffer
try {
  bytes = readFileSync(file)
} catch (err) {
  console.error(printable(`cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`))
  process.exit(2)
}
console.log(`file:   ${printable(file)}`)
console.log(`bytes:  ${bytes.length}`)
console.log(`sha256: ${createHash('sha256').update(bytes).digest('hex')}`)

let parsed: unknown
try {
  parsed = JSON.parse(bytes.toString('utf8'))
} catch {
  console.error('the file is not JSON')
  process.exit(1)
}
const report = verifyExport(parsed)
for (const check of report.checks) console.log(`${check.ok ? 'ok  ' : 'FAIL'} ${printable(check.name)}: ${printable(check.detail)}`)
console.log(report.ok ? `OK: every check passed (${report.checks.length})` : `FAILED: ${report.checks.filter((check) => !check.ok).length} of ${report.checks.length} checks`)
process.exit(report.ok ? 0 : 1)
