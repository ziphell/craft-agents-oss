#!/usr/bin/env bun
/**
 * Generic `electron:dist` — build + package for the CURRENT platform, staging
 * the Bun runtime that matches the host architecture.
 *
 * Deliberately host-platform + host-arch only. `electron-builder --config …`
 * on its own builds every arch listed in the config (macOS lists arm64 AND
 * x64), but `apps/electron/vendor/bun` holds a single binary — so it would ship
 * one arch's Bun inside the other arch's artifact. An arm64 DMG built on an
 * Intel host then carries an x86_64 Bun and aborts under Rosetta on Apple
 * Silicon ("runtime library is newer than runtime"). Keeping the staged Bun and
 * the artifact in step removes that whole failure mode.
 *
 * Use `electron:dist:mac` / `electron:dist:win` / `electron:dist:linux` for
 * explicit (possibly cross-arch) builds.
 */
import { $ } from 'bun'
import { join } from 'node:path'

const ROOT_DIR = join(import.meta.dir, '..')
const ELECTRON_DIR = join(ROOT_DIR, 'apps', 'electron')

const platform = process.platform === 'darwin'
  ? 'darwin'
  : process.platform === 'win32'
    ? 'win32'
    : 'linux'
const arch = process.arch === 'arm64' ? 'arm64' : 'x64'

// Stage the matching Bun (cached — reused offline when already present).
await $`bun run scripts/fetch-bun.ts ${platform} ${arch}`.cwd(ROOT_DIR)

const platformFlag = platform === 'darwin' ? '--mac' : platform === 'win32' ? '--win' : '--linux'
const archFlag = arch === 'arm64' ? '--arm64' : '--x64'

await $`npx electron-builder --config electron-builder.yml ${platformFlag} ${archFlag}`.cwd(ELECTRON_DIR)
