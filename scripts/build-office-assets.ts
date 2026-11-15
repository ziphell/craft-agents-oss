/**
 * Copy the GenOffice editor bundles into `apps/electron/resources/office/`.
 *
 * The editors are a vendored dependency, not source in this repo: they are built from the
 * GenOffice checkout (`GENOFFICE_ROOT`, default `../genoffice`) and copied in, exactly as
 * `resources/drawio` is fetched rather than committed. What is copied is each app's *renderer*
 * output only — this app hosts the documents in a frame, so the editors' main processes and
 * preloads are not part of the deal (the shim stands in for the preload, and the host owns
 * everything the main process would have done).
 *
 *   bun scripts/build-office-assets.ts              # copy (rebuilds nothing)
 *   bun scripts/build-office-assets.ts --check      # report what is missing, copy nothing
 *   GENOFFICE_ROOT=~/src/genoffice bun scripts/…
 *
 * Building the bundles is GenOffice's own job, and doing it here would hide a failure:
 *
 *   cd ../genoffice
 *   npm install
 *   npm run build -w @genoffice/docs
 *   npm run build -w @genoffice/pdf
 *   npm run build -w @genoffice/slides
 *   npx electron-vite build -w @genoffice/sheets    # or `npm run build` with a Rust toolchain
 *
 * (`apps/sheets` needs a Rust toolchain for its xlsx sidecar; the renderer builds without one.)
 */

import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { reconcilePatches, reportPatches } from './lib/genoffice-patches'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const CHECK = process.argv.includes('--check')
/**
 * Where the editors are built from.
 *
 * `GENOFFICE_ROOT` (the historical name) and `GENOFFICE_SOURCE` (what the engine build reads) both
 * work. With neither, the vendored tree this repo fetches comes first and a sibling checkout is the
 * fallback — one order for every office script, so a machine that builds on macOS and on Linux finds
 * the same tree without being told twice.
 */
function resolveGenOffice(): string {
  const explicit = process.env.GENOFFICE_ROOT?.trim() || process.env.GENOFFICE_SOURCE?.trim()
  if (explicit) return resolve(explicit)
  const vendored = join(ROOT, 'vendor', 'genoffice')
  if (existsSync(join(vendored, 'apps', 'docs'))) return vendored
  return join(ROOT, '..', 'genoffice')
}

const GENOFFICE = resolveGenOffice()
const DEST = join(ROOT, 'apps', 'electron', 'resources', 'office')
const ENGINE_DEST = join(ROOT, 'apps', 'electron', 'resources', 'office-engine')
const NATIVE_DEST = join(ROOT, 'apps', 'electron', 'resources', 'office-native')

/** The editors this app hosts, in the order a person would look for them. */
const APPS = ['docs', 'sheets', 'slides', 'pdf'] as const

/** The document tools run the same engine through this bundle (ELECTRON_RUN_AS_NODE). */
const CLI_SRC = join(GENOFFICE, 'packages', 'cli', 'dist')
const CLI_DEST = join(ROOT, 'apps', 'electron', 'resources', 'cli')

function sizeOf(dir: string): { files: number; bytes: number } {
  let files = 0
  let bytes = 0
  // A path may be a file (a bundle) or a directory (a copied editor).
  if (existsSync(dir) && statSync(dir).isFile()) {
    return { files: 1, bytes: statSync(dir).size }
  }
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else {
        files += 1
        bytes += statSync(full).size
      }
    }
  }
  walk(dir)
  return { files, bytes }
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

if (!existsSync(GENOFFICE)) {
  console.error(`No GenOffice checkout at ${GENOFFICE}.`)
  console.error('Fetch the pinned one:  bun scripts/fetch-genoffice-source.ts')
  console.error('Or point at your own:   GENOFFICE_SOURCE=/path/to/genoffice bun scripts/build-office-assets.ts')
  process.exit(1)
}

/**
 * The editors are built from **patched** source: `readMode` / `edit` / `replaceText` are ours, and a
 * checkout without them produces an editor that can be looked at but not changed in place. The
 * vendored tree (`vendor/genoffice`) is ours, so its patches are applied here; a checkout the person
 * owns is only checked — never modified behind their back.
 */
const vendoredCheckout = GENOFFICE === join(ROOT, 'vendor', 'genoffice')
const patchOutcomes = reconcilePatches(GENOFFICE, { apply: vendoredCheckout })
reportPatches(patchOutcomes, GENOFFICE)
if (patchOutcomes.some((outcome) => outcome.state === 'conflict')) {
  console.error('\nA patch does not apply to this checkout. Update scripts/patches/, then re-run.')
  process.exit(1)
}
if (patchOutcomes.some((outcome) => outcome.state === 'pending')) {
  console.warn('\n⚠ this checkout is missing scripts/patches/ — the editors will build without in-place editing.')
  console.warn('  Apply them: git -C <dir> apply <repo>/scripts/patches/*.patch')
}

/**
 * `--check`: is this checkout able to run the office editors at all?
 *
 * The editors, the command line, the sidecar and the engine bundles are five separately built
 * things, and a missing one fails at a different moment — a frame that never loads, a save that
 * says "jsdom not found", a workbook that cannot open, a deck that says the engine is not
 * installed. This walks all of them in one place, says which step produces each, and exits
 * non-zero if anything is missing. It checks **contents**, not just existence, because the
 * failures that cost the most were files that were there and wrong (a `package.json` named
 * `genoffice-cli` breaks jsdom resolution; a bundle without its wasm cannot redact).
 */
function checkInstallation(): boolean {
  const rows: Array<{ ok: boolean; label: string; detail: string; fix?: string }> = []
  const add = (ok: boolean, label: string, detail: string, fix?: string) => rows.push({ ok, label, detail, fix })

  // ── the editors ──
  for (const app of APPS) {
    const index = join(DEST, app, 'index.html')
    add(existsSync(index), `editors/${app}`, existsSync(index) ? mb(sizeOf(join(DEST, app)).bytes) : 'missing', 'bun scripts/build-office-assets.ts')
  }

  // ── the command line (the document tools spawn it) ──
  const cli = join(CLI_DEST, 'genoffice.cjs')
  const cliPkg = join(CLI_DEST, 'package.json')
  const jsdom = join(CLI_DEST, 'node_modules', 'jsdom', 'package.json')
  add(existsSync(cli), 'cli/genoffice.cjs', existsSync(cli) ? mb(sizeOf(cli).bytes) : 'missing', 'bun scripts/build-office-assets.ts')
  add(existsSync(jsdom), 'cli/node_modules/jsdom', existsSync(jsdom) ? 'present' : 'missing', 'bun scripts/build-office-assets.ts')
  let packageName = '(no package.json)'
  if (existsSync(cliPkg)) {
    try {
      packageName = JSON.parse(readFileSync(cliPkg, 'utf8')).name ?? '(unnamed)'
    } catch {
      packageName = '(unreadable)'
    }
  }
  // The CLI finds its dependencies by walking up for a package.json **named `genoffice`**.
  add(packageName === 'genoffice', 'cli/package.json', `name=${packageName}`, 'rerun the copy step (it writes the name)')

  // ── the sidecar (xlsx only) ──
  const sidecar = join(NATIVE_DEST, process.platform === 'win32' ? 'xlsx-sidecar.exe' : 'xlsx-sidecar')
  add(
    existsSync(sidecar),
    'native/xlsx-sidecar',
    existsSync(sidecar) ? mb(sizeOf(sidecar).bytes) : 'missing — .xlsx cannot open without it',
    'bun scripts/build-office-native.ts --from <extracted GenOffice installer> (no Rust needed)',
  )

  // ── the engines (separate script) ──
  const engineDirs = [
    ['pptx.cjs', 'decks cannot open (no engine)'],
    ['xlsx.cjs', 'workbooks cannot open (no sidecar client)'],
    ['pdf.cjs', 'pdf cannot be written'],
    ['html2docx.cjs', 'html → docx cannot run'],
  ] as const
  for (const [file, consequence] of engineDirs) {
    const path = join(ENGINE_DEST, file)
    add(existsSync(path), `office-engine/${file}`, existsSync(path) ? mb(sizeOf(path).bytes) : `missing — ${consequence}`, 'bun scripts/build-office-engine.ts')
  }
  const pdfium = join(ENGINE_DEST, 'node_modules', '@embedpdf', 'pdfium', 'dist', 'pdfium.wasm')
  add(existsSync(pdfium), 'office-engine/pdfium.wasm', existsSync(pdfium) ? mb(sizeOf(pdfium).bytes) : 'missing — redaction and text surgery would silently refuse', 'bun scripts/build-office-engine.ts')
  const jszip = join(ENGINE_DEST, 'node_modules', 'jszip', 'package.json')
  add(existsSync(jszip), 'office-engine/node_modules/jszip', existsSync(jszip) ? 'present' : 'missing — every save would fail with "nodestream is not supported"', 'bun scripts/build-office-engine.ts')

  const width = Math.max(...rows.map((r) => r.label.length))
  for (const row of rows) {
    console.log(`${row.ok ? '✓' : '✗'} ${row.label.padEnd(width)}  ${row.detail}`)
  }
  const failing = rows.filter((r) => !r.ok)
  if (!failing.length) {
    console.log('\nEverything the office editors need is installed.')
    return true
  }
  console.log('\nMissing pieces — run the fix for each:')
  for (const fix of [...new Set(failing.map((r) => r.fix).filter(Boolean))]) {
    console.log(`  ${fix}`)
  }
  console.log('\nSee docs/requirements/office-embed.md §3 for the full build order and §7 for the acceptance checklist.')
  return false
}

/**
 * A checkout that has never been built has `apps/<app>/src` but no `apps/<app>/out/renderer`.
 *
 * What gets copied is the **built** renderer, so without it every editor comes out empty — and the
 * package would ship a `resources/office/` whose apps have no `index.html`, which is discovered by
 * opening a document rather than by building. This is the normal state right after
 * `fetch-genoffice-source.ts` (the fetch copies source, not build output), so it is worth one clear
 * sentence instead of thirty missing files.
 */
if (!existsSync(join(GENOFFICE, 'apps', 'docs', 'out', 'renderer'))) {
  console.error(`The checkout at ${GENOFFICE} has no built editors (apps/docs/out/renderer is missing).`)
  console.error('Build them in that checkout first — docs/requirements/office-embed.md §3:')
  console.error('  cd <checkout> && npm install')
  console.error('  npm run build -w @genoffice/docs -w @genoffice/pdf -w @genoffice/slides')
  console.error('  npx electron-vite build -w @genoffice/sheets    # or `npm run build` with a Rust toolchain')
  process.exit(1)
}

if (CHECK) {
  process.exit(checkInstallation() ? 0 : 1)
}

let missing = 0

for (const app of APPS) {
  const source = join(GENOFFICE, 'apps', app, 'out', 'renderer')
  const target = join(DEST, app)

  if (!existsSync(join(source, 'index.html'))) {
    missing += 1
    console.error(`✗ ${app}: no built renderer at ${source}`)
    console.error(`  build it first:  cd ${GENOFFICE} && npm run build -w @genoffice/${app}`)
    continue
  }

  if (CHECK) {
    const present = existsSync(join(target, 'index.html'))
    console.log(`${present ? '✓' : '·'} ${app}: ${present ? 'installed' : 'not installed'} (source ${mb(sizeOf(source).bytes)})`)
    continue
  }

  // Replace wholesale: a half-copied bundle is a frame that loads and then cannot find an asset.
  rmSync(target, { recursive: true, force: true })
  cpSync(source, target, { recursive: true })
  const { files, bytes } = sizeOf(target)
  console.log(`✓ ${app}: ${files} files, ${mb(bytes)} → ${target}`)
}

if (CHECK) {
  if (missing) {
    console.error(`\n${missing} editor(s) have no build in ${GENOFFICE}.`)
    process.exit(1)
  }
  process.exit(checkInstallation() ? 0 : 1)
}

if (missing) {
  console.error(`\nCopied what existed; ${missing} editor(s) are still missing.`)
  process.exit(1)
}

// The command line the document tools spawn: one bundle plus its jsdom tree, run on the app's own
// runtime (ELECTRON_RUN_AS_NODE) — the way GenOffice itself ships it.
if (existsSync(join(GENOFFICE, 'packages', 'cli', 'dist', 'genoffice.cjs'))) {
  rmSync(CLI_DEST, { recursive: true, force: true })
  cpSync(CLI_SRC, CLI_DEST, { recursive: true })
  // The bundle finds its dependencies by walking up for a package.json **named `genoffice`**
  // (`repoRoot()` in the CLI's own `resources.ts`) and requiring from there. Without one beside
  // it, a copy outside a checkout reports "jsdom not found" for every Word/Markdown command —
  // measured, name included: any other name is rejected by that check.
  writeFileSync(join(CLI_DEST, 'package.json'), JSON.stringify({ name: 'genoffice', private: true, version: '0.0.0' }, null, 2) + '\n')
  const { files, bytes } = sizeOf(CLI_DEST)
  console.log(`✓ cli: ${files} files, ${mb(bytes)} → ${CLI_DEST}`)
} else {
  console.warn(`· cli: no build at ${CLI_SRC} — \`docx_tool\` will say the engine is not installed`)
  console.warn(`  build it:  cd ${GENOFFICE} && npm run build -w @genoffice/cli`)
}

console.log('\nDone. Restart the app: the origin is handed out at startup.')
