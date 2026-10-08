/**
 * One-off, pass 2: mop up the identifier families pass 1 missed
 * (`PageData*`, `PageAction*`, `PAGE_DATA_*`, …) plus the prose inside the
 * feature's own files.
 *
 * Boundary rules, because a blanket rename is a footgun:
 *  - `capturePage` must survive  → never match a `Page` that ends an identifier
 *    (the lookahead requires an uppercase letter after it).
 *  - CSS `@page` / `page-break-*` must survive → the bare-word rule excludes a
 *    preceding `@` and a following `-`.
 *  - Only feature-owned files are touched. Shared/integration files get explicit,
 *    hand-checked edits instead — `page`/`pages` mean other things there
 *    (`apps/electron/src/renderer/pages/` is the app's screen directory).
 */
import { readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()

const TARGETS = [
  'packages/core/src/types/design.ts',
  'packages/shared/src/designs',
  'packages/server-core/src/designs',
  'packages/server-core/src/handlers/rpc/designs.ts',
  'packages/session-tools-core/src/handlers/designs.ts',
  'packages/session-tools-core/src/handlers/designs.test.ts',
  'apps/electron/src/renderer/components/designs',
  'apps/electron/src/renderer/atoms/designs.ts',
  'apps/electron/src/renderer/hooks/useDesigns.ts',
  'apps/electron/src/shared/design-bridge.ts',
  'apps/electron/src/shared/__tests__/design-bridge.test.ts',
  'apps/electron/src/shared/__tests__/route-parser-designs.test.ts',
  'apps/electron/src/main/design-thumbnailer.ts',
  'apps/electron/src/main/design-thumbnail-host.ts',
  'apps/electron/src/main/__tests__/design-thumbnail-host.test.ts',
  'apps/electron/resources/docs/designs.md',
]

const RULES: Array<[RegExp, string]> = [
  [/PAGE_/g, 'DESIGN_'],
  [/(?<![A-Za-z])Page(?=[A-Z])/g, 'Design'],
  [/(?<=[a-z])Page(?=[A-Z])/g, 'Design'],
  [/(?<![A-Za-z])Pages(?=[A-Z])/g, 'Designs'],
  [/(?<![A-Za-z])pages(?=[A-Z])/g, 'designs'],
  [/(?<![A-Za-z@])Pages(?![A-Za-z-])/g, 'Designs'],
  [/(?<![A-Za-z@])pages(?![A-Za-z-])/g, 'designs'],
  [/(?<![A-Za-z@])Page(?![A-Za-z-])/g, 'Design'],
  [/(?<![A-Za-z@])page(?![A-Za-z-])/g, 'design'],
]

function walk(p: string, out: string[] = []): string[] {
  const st = statSync(join(ROOT, p))
  if (st.isFile()) {
    out.push(p)
    return out
  }
  for (const entry of readdirSync(join(ROOT, p))) walk(`${p}/${entry}`, out)
  return out
}

const files: string[] = []
for (const t of TARGETS) walk(t, files)

let touched = 0
let edits = 0
for (const rel of files) {
  const abs = join(ROOT, rel)
  const before = readFileSync(abs, 'utf-8')
  let after = before
  for (const [re, to] of RULES) {
    const matches = after.match(re)
    if (matches) {
      edits += matches.length
      after = after.replace(re, to)
    }
  }
  if (after !== before) {
    writeFileSync(abs, after, 'utf-8')
    touched++
  }
}
console.log(`pass 2 — files touched: ${touched}, replacements: ${edits}`)
