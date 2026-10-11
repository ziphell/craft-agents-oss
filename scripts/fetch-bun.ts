#!/usr/bin/env bun
/**
 * Stage the bundled Bun runtime into `apps/electron/vendor/bun`, where
 * electron-builder picks it up (`files: vendor/bun/**`) and the packaged app
 * resolves it (`runtime-resolver.ts`: `<appRoot>/vendor/bun/bun`).
 *
 * Only the Pi subprocess needs Bun. A packaged build that ships without it
 * falls back to the Electron binary, which never speaks the JSONL protocol, so
 * every Pi connection test (e.g. DeepSeek) hangs until the caller times out.
 *
 * The download is CACHED: a given `version-platform-arch` is fetched from the
 * network at most once and then reused offline (a plain file copy), so repeated
 * builds never re-download. The pinned version and checksum verification reuse
 * the canonical routine in `scripts/build/common.ts` — `build-dmg.sh` and
 * `build-win.ps1` download the same version.
 *
 * Usage: bun run scripts/fetch-bun.ts <darwin|win32|linux> [arch...]
 *   arch defaults to the host arch (arm64 | x64).
 */
import { copyFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { downloadBun, BUN_VERSION, type Arch, type BuildConfig, type Platform } from './build/common'

const ROOT_DIR = join(import.meta.dir, '..')
const ELECTRON_DIR = join(ROOT_DIR, 'apps', 'electron')
const VENDOR_DIR = join(ELECTRON_DIR, 'vendor', 'bun')
/** Cache lives outside `vendor/` (which build-dmg.sh wipes each run) and is gitignored. */
const CACHE_DIR = join(ROOT_DIR, '.build', 'bun')
const STAMP_FILE = join(VENDOR_DIR, '.staged')

function bunBinaryName(platform: Platform): string {
  return platform === 'win32' ? 'bun.exe' : 'bun'
}

function hostArch(): Arch {
  return process.arch === 'arm64' ? 'arm64' : 'x64'
}

/**
 * Copy the staged binary into `vendor/bun`, retrying briefly. Windows can hold
 * a transient handle on a just-written `bun.exe` (Defender / the previous
 * build), which makes a single `copyFileSync` fail with EBUSY.
 */
function copyWithRetry(src: string, dest: string, attempts = 5): void {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      copyFileSync(src, dest)
      return
    } catch (error) {
      if (attempt === attempts) throw error
      Bun.sleepSync(500)
    }
  }
}

async function stage(platform: Platform, arch: Arch): Promise<void> {
  const target = `${BUN_VERSION}-${platform}-${arch}`
  const binName = bunBinaryName(platform)
  const dest = join(VENDOR_DIR, binName)
  const cached = join(CACHE_DIR, target, binName)

  // Correct build already staged — nothing to do.
  if (existsSync(dest) && existsSync(STAMP_FILE) && readFileSync(STAMP_FILE, 'utf8').trim() === target) {
    console.log(`✓ Bun ${target} already staged — skipping`)
    return
  }

  if (existsSync(cached)) {
    console.log(`Reusing cached Bun ${target} (${cached})`)
  } else {
    // Network fetch happens only here, at most once per version+platform+arch.
    console.log(`Bun ${target} not cached — downloading once...`)
    const config: BuildConfig = {
      platform,
      arch,
      upload: false,
      uploadLatest: false,
      uploadScript: false,
      rootDir: ROOT_DIR,
      electronDir: ELECTRON_DIR,
    }
    await downloadBun(config)
    mkdirSync(dirname(cached), { recursive: true })
    copyFileSync(dest, cached)
  }

  mkdirSync(VENDOR_DIR, { recursive: true })
  // Drop the other platform's binary so a given build ships exactly one bun
  // (`bun` vs `bun.exe`) — electron-builder copies all of `vendor/bun/**`.
  for (const name of ['bun', 'bun.exe']) {
    if (name !== binName) rmSync(join(VENDOR_DIR, name), { force: true })
  }
  copyWithRetry(cached, dest)
  if (platform !== 'win32' && process.platform !== 'win32') chmodSync(dest, 0o755)
  writeFileSync(STAMP_FILE, target)
  console.log(`✓ Staged Bun ${target} -> ${dest}`)
}

async function main(): Promise<void> {
  const [platformArg, ...archArgs] = process.argv.slice(2)
  const platform = (platformArg ?? process.platform) as Platform
  const arches: Arch[] = archArgs.length ? (archArgs as Arch[]) : [hostArch()]

  for (const arch of arches) {
    await stage(platform, arch)
  }
}

await main()
