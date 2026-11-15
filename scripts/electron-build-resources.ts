/**
 * Copy `apps/electron/resources` into `dist/resources`, which is what the package carries
 * (`files: dist/**\/*`).
 *
 * Not everything in `resources/` is meant to ship, and this is where that is decided — the copy is
 * the door, so an allowlist in `electron-builder.yml` alone would still let a stray file through:
 *
 * - **`scripts/` is not packed.** It holds the Python reference implementations of the command-line
 *   tools (`markitdown`, `img-tool`, `ical-tool` were once Python behind `uv`). They stay in the
 *   repository because they are the clearest statement of what each command means, and they are
 *   deliberately not part of a build: a host runs the Bun bundles in `cli-tools/dist`.
 * - **`cli-tools` is not copied here.** `bun run build:cli-tools` writes
 *   `resources/cli-tools/dist`, which electron-builder ships through its own
 *   `files: resources/cli-tools/**` entry. Copying it into `dist/resources` as well packed the
 *   same ~80 MB tree twice, and the runtime only reads `resources/cli-tools/dist`.
 * - **`bin/<platform>-<arch>/` is packed.** It holds `uv`, the Python **script runtime** — for
 *   scripts the person writes (`transform_data`, `script_sandbox`, an automation), never for the
 *   agent's tools. That is why only `scripts/` is excluded: the tools are Bun, Python is a
 *   capability, and the two reasons are not the same reason.
 */

import { cpSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const ROOT_DIR = join(import.meta.dir, '..')
const ELECTRON_DIR = join(ROOT_DIR, 'apps/electron')

const srcDir = join(ELECTRON_DIR, 'resources')
const destDir = join(ELECTRON_DIR, 'dist/resources')

/** Entries under `resources/` that are shipped by their own electron-builder rule, not this copy. */
const NOT_PACKED = new Set(['scripts', 'bin', 'cli-tools'])

if (!existsSync(srcDir)) {
  console.log('⚠️ No resources directory found')
  process.exit(0)
}

// A stale copy is worse than none: a file removed from resources/ would linger in dist/.
rmSync(destDir, { recursive: true, force: true })

for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
  if (NOT_PACKED.has(entry.name)) continue
  cpSync(join(srcDir, entry.name), join(destDir, entry.name), { recursive: true, force: true })
}

// `bin/`: the wrappers only. A **platform** directory under it (`win32-x64/`, `darwin-arm64/`)
// holds `uv` and ships through the per-platform `extraResources` block — copying it here as well
// would put 62 MB of the same runtime into the package twice.
const binDir = join(srcDir, 'bin')
if (existsSync(binDir)) {
  for (const entry of readdirSync(binDir, { withFileTypes: true })) {
    if (entry.isDirectory()) continue
    cpSync(join(binDir, entry.name), join(destDir, 'bin', entry.name), { force: true })
  }
}

console.log('📦 Copied resources to dist (tools built, Python sources left in the repository)')
