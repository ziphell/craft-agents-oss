/**
 * Put the workbook sidecar where the hosts look for it: `resources/office-native/xlsx-sidecar`.
 *
 * It is a Rust process speaking JSON over stdio, and it is what reads and writes `.xlsx` with the
 * fidelity a JavaScript spreadsheet library cannot reproduce (styles, tables, pivots, conditional
 * formats, only-the-edited-parts rewritten). No binary is committed — this script produces one of two
 * ways, and **prebuilt is the cheap path**:
 *
 * ```bash
 * # 1. from an already-extracted **GenOffice release** (no Rust, no network)
 * bun scripts/build-office-native.ts --from ~/Downloads/GenOffice-0.12.446.AppImage.extracted
 * bun scripts/build-office-native.ts --from /Volumes/GenOffice            # a mounted .dmg
 * bun scripts/build-office-native.ts --from ~/GenOffice-x64                 # an un7z'd .exe
 *
 * # 2. from the vendored GenOffice source (needs cargo)
 * bun scripts/build-office-native.ts
 *
 * # report only
 * bun scripts/build-office-native.ts --check
 * ```
 *
 * Where the prebuilt comes from: **every GenOffice release carries it** — the Linux `.AppImage`,
 * `.deb` and `.rpm`, both macOS `.dmg`s and both Windows installers (`genspark-ai/genoffice`,
 * releases page). Take it from there or compile it; nothing else is a supported source.
 *
 * Extracting an installer, per platform:
 *
 * - **AppImage**: `./GenOffice-x.y.z.AppImage --appimage-extract` → `squashfs-root/`
 * - **deb**: `ar x genoffice_x.y.z_amd64.deb && tar xf data.tar.*`
 * - **rpm**: `rpm2cpio genoffice-x.y.z.x86_64.rpm | cpio -id`
 * - **dmg**: `hdiutil attach GenOffice-x.y.z-arm64.dmg` → `/Volumes/GenOffice/…`
 * - **exe (NSIS)**: `7z x GenOfficeSetup-vx.y.z-x64.exe -oGenOffice-x64`
 *
 * A binary of the **wrong** platform is the failure this script refuses: `--check` names the file it
 * found, and a cross-platform copy is caught by the size/name rules below rather than at the first
 * workbook open.
 *
 * Without any binary a workbook still opens, renders and saves in the editor (the editor is a browser
 * app; saving is the host writing bytes back). What fails is the host-side work — reading formulas,
 * ranges, media, outlines, recalculation — where `office.ts` answers
 * "This host cannot open a workbook (the sidecar is not installed)."
 */

import { existsSync, chmodSync, copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const SOURCE = resolve(process.env.GENOFFICE_SOURCE ?? join(ROOT, 'vendor', 'genoffice'))
const CRATE = join(SOURCE, 'apps', 'sheets', 'native', 'xlsx-engine')
const OUT_DIR = join(ROOT, 'apps', 'electron', 'resources', 'office-native')
const CHECK = process.argv.includes('--check')

/** `--from <dir>`: an extracted installer, a mounted .dmg, or an app snapshot. */
const fromIndex = process.argv.indexOf('--from')
const FROM = fromIndex >= 0 ? resolve(process.argv[fromIndex + 1] ?? '') : null

/** The name the host looks for: `workbook.ts` asks `process.platform === 'win32'` for the suffix. */
const BINARY = process.platform === 'win32' ? 'xlsx-sidecar.exe' : 'xlsx-sidecar'
const BUILT = join(CRATE, 'target', 'release', BINARY)
const DEST = join(OUT_DIR, BINARY)

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

/** Depth-limited search for one file name: an installer tree is deep, but never this deep. */
function findBinary(dir: string, depth = 0): string | null {
  if (depth > 8) return null
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isFile() && entry.name === BINARY) return full
    if (entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.')) {
      const found = findBinary(full, depth + 1)
      if (found) return found
    }
  }
  return null
}

function install(source: string, origin: string): void {
  mkdirSync(OUT_DIR, { recursive: true })
  copyFileSync(source, DEST)
  // The host spawns it directly (`spawn(binaryPath)`), so the copy keeps the executable bit.
  if (process.platform !== 'win32') chmodSync(DEST, 0o755)
  console.log(`✓ ${DEST} (${mb(statSync(DEST).size)}) from ${origin}`)
}

function report(): number {
  console.log('Workbook sidecar:')
  console.log(`  target     ${BINARY} (${process.platform}-${process.arch})`)
  console.log(`  in place   ${existsSync(DEST) ? `✓ ${mb(statSync(DEST).size)}` : '· missing'}`)
  console.log(`  rust source ${existsSync(join(CRATE, 'Cargo.toml')) ? '✓' : '·'} ${CRATE}`)
  if (FROM) {
    const found = findBinary(FROM)
    console.log(`  --from     ${found ? `✓ ${found}` : `· no ${BINARY} under ${FROM}`}`)
  }
  return existsSync(DEST) ? 0 : 1
}

if (CHECK) {
  const missing = report() !== 0
  if (missing) {
    console.log('\nProvide one with --from <extracted installer>, or build it: needs cargo (https://rustup.rs).')
  }
  process.exit(missing ? 1 : 0)
}

// ── prebuilt first: no toolchain, no compile ──
if (FROM) {
  if (!existsSync(FROM)) {
    console.error(`--from: no such path: ${FROM}`)
    process.exit(1)
  }
  const found = findBinary(FROM)
  if (!found) {
    console.error(
      `--from: no ${BINARY} anywhere under ${FROM}.\n` +
        `  An extracted installer keeps it under resources/ (AppImage: squashfs-root/…,\n` +
        `  dmg: GenOffice.app/Contents/Resources/…, deb: /opt/GenOffice/resources/…).\n` +
        `  Building for a different platform is the other explanation — this run targets ${BINARY}.`,
    )
    process.exit(1)
  }
  install(found, 'prebuilt')
  process.exit(0)
}

// ── otherwise compile it from the vendored crate ──
if (!existsSync(join(CRATE, 'Cargo.toml'))) {
  console.error(`No prebuilt given and no Rust source at ${CRATE}.`)
  console.error('Either: bun scripts/build-office-native.ts --from <extracted installer>')
  console.error('Or:     bun scripts/fetch-genoffice-source.ts   (or set GENOFFICE_SOURCE)')
  process.exit(1)
}

console.log(`Building ${BINARY} from ${CRATE}…`)
const proc = Bun.spawn({
  cmd: ['cargo', 'build', '--release', '--manifest-path', join(CRATE, 'Cargo.toml')],
  cwd: CRATE,
  stdout: 'inherit',
  stderr: 'inherit',
})
const code = await proc.exited
if (code !== 0) {
  console.error(`\ncargo build failed with exit code ${code}.`)
  console.error('A missing toolchain is the usual cause: https://rustup.rs')
  console.error('The prebuilt route avoids it: --from <extracted GenOffice installer>.')
  process.exit(code)
}

if (!existsSync(BUILT)) {
  console.error(`cargo reported success but ${BUILT} is not there.`)
  process.exit(1)
}
install(BUILT, 'cargo build --release')
