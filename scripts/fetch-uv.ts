#!/usr/bin/env bun
/**
 * Stage the bundled uv runtime into `apps/electron/resources/bin/<platform>-<arch>/uv`,
 * where `electron-builder.yml` picks it up through the per-platform `extraResources`
 * block and the packaged app resolves it (`resolve-script-runtime.ts`).
 *
 * uv is the **Python script runtime** — for the scripts a person writes (an automation
 * script, `transform_data`, `script_sandbox`). It is not for the agent's own tools:
 * those are Bun bundles in `resources/cli-tools` and need nothing here. A package built
 * without uv still runs; it just reports that no Python runtime is installed.
 *
 * `electron-builder` does not fail on a missing `extraResources` source — it logs
 * `file source doesn't exist` and ships the artifact without it. That is why this
 * staging step is explicit and why `validate-assets` treats uv as required.
 *
 * Usage: bun run scripts/fetch-uv.ts [darwin|win32|linux] [arch...]
 *   platform defaults to the host platform; arch defaults to the host arch.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { downloadUv, getPlatformKey, type Arch, type Platform } from './build/common'

const ROOT_DIR = join(import.meta.dir, '..')
const ELECTRON_DIR = join(ROOT_DIR, 'apps', 'electron')

const PLATFORMS: readonly Platform[] = ['darwin', 'win32', 'linux']
const ARCHES: readonly Arch[] = ['arm64', 'x64']

function hostPlatform(): Platform {
  if (process.platform === 'darwin') return 'darwin'
  if (process.platform === 'win32') return 'win32'
  if (process.platform === 'linux') return 'linux'
  throw new Error(`unsupported host platform ${process.platform}`)
}

function hostArch(): Arch {
  return process.arch === 'arm64' ? 'arm64' : 'x64'
}

function parsePlatform(value: string | undefined): Platform {
  if (!value) return hostPlatform()
  if (!PLATFORMS.includes(value as Platform)) {
    throw new Error(`unknown platform "${value}" — expected one of ${PLATFORMS.join(', ')}`)
  }
  return value as Platform
}

async function stage(platform: Platform, arch: Arch): Promise<void> {
  await downloadUv({
    platform,
    arch,
    upload: false,
    uploadLatest: false,
    uploadScript: false,
    rootDir: ROOT_DIR,
    electronDir: ELECTRON_DIR,
  })

  const binName = platform === 'win32' ? 'uv.exe' : 'uv'
  const staged = join(ELECTRON_DIR, 'resources', 'bin', getPlatformKey(platform, arch), binName)
  if (!existsSync(staged)) {
    throw new Error(`uv was not staged at ${staged}`)
  }
  console.log(`✓ uv ${platform}-${arch} staged — ${staged}`)
}

const platform = parsePlatform(process.argv[2])
const requested = process.argv.slice(3)
if (requested.length === 0) requested.push(hostArch())

for (const value of requested) {
  if (!ARCHES.includes(value as Arch)) {
    throw new Error(`unknown arch "${value}" — expected one of ${ARCHES.join(', ')}`)
  }
  await stage(platform, value as Arch)
}
