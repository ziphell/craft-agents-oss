/**
 * The last step of `bun run build`: are the assets a package needs actually there?
 *
 * `package.json` has pointed `build:validate` at this file for a while, but the file did not exist —
 * so every `bun run build` ended in `Cannot find module … validate-assets.ts`, which reads like a
 * broken checkout rather than "one asset is missing". This is the file.
 *
 * Required assets fail the build. Optional blocks (the office editors, the workbook sidecar, the
 * GenOffice command line) are **reported by name with the command that produces them** and do not
 * fail: a build without them is a legitimate build, and the app says which editor is not installed
 * when someone opens that format. `--strict` turns them into failures, for release builds that
 * intend to ship the office feature.
 */

import { join } from 'node:path'
import { checkAssets, formatChecks } from './lib/check-assets'

const electronDir = join(import.meta.dir, '..')
const strict = process.argv.includes('--strict')
const checks = checkAssets(electronDir)
const failed = checks.filter((check) => !check.ok && check.required)
const optional = checks.filter((check) => !check.ok && !check.required)

console.log('Asset check:')
for (const line of formatChecks(checks)) console.log(line)

if (optional.length > 0) {
  console.log(
    `\n${optional.length} optional block(s) absent — the app runs, and reports each one as not installed:`,
  )
  for (const check of optional) console.log(`  · ${check.label}${check.hint ? ` — ${check.hint}` : ''}`)
}

if (failed.length > 0) {
  console.error(`\n${failed.length} required asset(s) missing.`)
  process.exit(1)
}

if (strict && optional.length > 0) {
  console.error('\n--strict: optional blocks are required in this build.')
  process.exit(1)
}

console.log('\nAssets OK.')
