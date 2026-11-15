/**
 * Put a GenOffice checkout where the office build reads it: `vendor/genoffice`.
 *
 * The same discipline as `fetch-drawio-assets.ts`, one level lower: drawio ships a release bundle
 * and we vendor the **artifact**; the document engines are libraries we import and patch around,
 * so what has to be versioned is the **source**. Either way the rule is the same — a pinned
 * revision fetched on demand, gitignored, and a stamp recording exactly what is on disk, so
 * "which upstream is this?" is answerable without reading a lockfile.
 *
 *   bun scripts/fetch-genoffice-source.ts [--from <checkout>] [--ref <sha>] [--force]
 *
 * `--from` copies an existing checkout (a machine that already has one, offline, no 77 MB of
 * history). Without it the repo is cloned from GitHub and checked out at `--ref`.
 *
 * What is copied is the **source tree**: `apps/<app>/src`, `packages/<pkg>`, and the build configs.
 * What is not: `node_modules`, `.git`, and every `out/`, `dist/` or `build/` the build regenerates —
 * a vendored tree that carries build output is a tree nobody can tell from a stale one.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { reconcilePatches, reportPatches, hasUnresolved } from './lib/genoffice-patches'

const ROOT = resolve(import.meta.dir, '..')
const TARGET = join(ROOT, 'vendor', 'genoffice')
const STAMP = join(TARGET, '.genoffice-source.json')
const REPO = 'https://github.com/genspark-ai/genoffice.git'

/** The revision this app is built against. Bump it here, rerun, rebuild the engine bundle. */
const PINNED_REF = 'b239d2e5'

const argv = process.argv.slice(2)
const force = argv.includes('--force')
const fromIndex = argv.indexOf('--from')
const fromDir = fromIndex >= 0 ? resolve(argv[fromIndex + 1] ?? '') : process.env.GENOFFICE_SOURCE ?? null
const refIndex = argv.indexOf('--ref')
const ref = refIndex >= 0 ? (argv[refIndex + 1] ?? PINNED_REF) : PINNED_REF

/** Directories that are build output or installed dependencies: never copied. */
const SKIP = new Set(['node_modules', '.git', 'out', 'dist', 'build', 'release', '.turbo'])

function shaOf(dir: string): string | null {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

/** Copy the tree, minus what the build regenerates. Returns the file count for the report. */
function copyTree(from: string, to: string): number {
  let files = 0
  const walk = (src: string, dst: string) => {
    mkdirSync(dst, { recursive: true })
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue
      const s = join(src, entry.name)
      const d = join(dst, entry.name)
      if (entry.isDirectory()) walk(s, d)
      else if (entry.isFile()) {
        cpSync(s, d)
        files += 1
      }
    }
  }
  walk(from, to)
  return files
}

/**
 * The vendored tree is ours, so the patches are applied here rather than left to a person: a clone
 * without them builds an editor that can be looked at but not edited in place.
 */
function applyOurPatches(): void {
  const outcomes = reconcilePatches(TARGET, { apply: true })
  reportPatches(outcomes, 'vendor/genoffice')
  if (hasUnresolved(outcomes)) {
    console.error('\nA patch no longer applies to this GenOffice revision.')
    console.error('Update scripts/patches/ (see docs/office-creations-index.md), then re-run this script.')
    process.exit(1)
  }
}

if (existsSync(TARGET) && !force) {
  const stamp = existsSync(STAMP) ? JSON.parse(readFileSync(STAMP, 'utf8')) : null
  console.log(`vendor/genoffice already exists${stamp?.commit ? ` at ${stamp.commit.slice(0, 8)}` : ''}.`)
  console.log('Pass --force to replace it.')
  process.exit(0)
}

if (existsSync(TARGET)) rmSync(TARGET, { recursive: true, force: true })
mkdirSync(join(ROOT, 'vendor'), { recursive: true })

let source = fromDir
let commit: string | null = null

if (source) {
  if (!existsSync(join(source, 'apps', 'docs'))) {
    console.error(`No GenOffice checkout at ${source} (it has no apps/docs).`)
    process.exit(1)
  }
  commit = shaOf(source)
} else {
  // A shallow clone at the pinned revision: one commit, no history to carry.
  console.log(`Cloning ${REPO} at ${ref}…`)
  execFileSync('git', ['clone', '--filter=blob:none', '--no-checkout', REPO, TARGET], { stdio: 'inherit' })
  execFileSync('git', ['-C', TARGET, 'checkout', ref], { stdio: 'inherit' })
  commit = shaOf(TARGET)
  const files = 1
  writeFileSync(STAMP, JSON.stringify({ source: 'clone', repo: REPO, ref, commit, files, fetchedAt: new Date().toISOString() }, null, 2) + '\n')
  console.log(`✓ ${TARGET} (${commit?.slice(0, 8) ?? 'unknown'})`)
  applyOurPatches()
  process.exit(0)
}

const files = copyTree(source!, TARGET)
writeFileSync(
  STAMP,
  JSON.stringify({ source: source, ref: commit ?? ref, commit, files, fetchedAt: new Date().toISOString() }, null, 2) + '\n',
)

const bytes = statSync(join(TARGET, 'package.json')).isFile() ? null : null
console.log(`✓ ${files} files → ${TARGET}`)
console.log(`  commit: ${commit ?? '(not a git checkout)'}${bytes ? '' : ''}`)
console.log('  build the engine next: bun scripts/build-office-engine.ts')
applyOurPatches()
