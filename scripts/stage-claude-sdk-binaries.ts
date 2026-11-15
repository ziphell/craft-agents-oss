#!/usr/bin/env bun
/**
 * Ensure the per-platform native `claude` binary packages required by a build
 * are present in the ROOT node_modules.
 *
 * Since SDK 0.2.113 the Claude Agent SDK ships its ~208 MB native `claude`
 * binary in per-arch optional-dependency packages (e.g.
 * `@anthropic-ai/claude-agent-sdk-darwin-x64`). Bun (like npm) only installs
 * the *host-arch* optional dependency, so building for another arch — e.g. a
 * mac x64 DMG on an arm64 machine — would silently ship an app without the
 * binary and crash at runtime with "native binary not found".
 *
 * This script cross-fetches any missing packages via `npm pack` so
 * `electron-builder`'s `extraResources` rules can bundle them.
 *
 * Usage: bun run scripts/stage-claude-sdk-binaries.ts <platform> [arch...]
 *   platform: darwin | win32 | linux
 *   arch:     arm64 | x64   (default for darwin: arm64 x64; otherwise x64)
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $ } from 'bun'

const ROOT_DIR = join(import.meta.dir, '..')
const SCOPE = join(ROOT_DIR, 'node_modules', '@anthropic-ai')

function binaryName(platform: string): string {
  return platform === 'win32' ? 'claude.exe' : 'claude'
}

function defaultArches(platform: string): string[] {
  return platform === 'darwin' ? ['arm64', 'x64'] : ['x64']
}

/** Exact SDK version to fetch: prefer the installed SDK's own version, fall
 *  back to the root dependency spec (stripped of any range operator). */
function resolveSdkVersion(): string {
  const installed = join(SCOPE, 'claude-agent-sdk', 'package.json')
  if (existsSync(installed)) {
    const { version } = JSON.parse(readFileSync(installed, 'utf8')) as { version?: string }
    if (version) return version
  }
  const rootPkg = JSON.parse(readFileSync(join(ROOT_DIR, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
  }
  const spec = rootPkg.dependencies?.['@anthropic-ai/claude-agent-sdk']
  if (!spec) throw new Error('Root package.json has no @anthropic-ai/claude-agent-sdk dependency')
  return spec.replace(/^[\^~]/, '')
}

async function fetchPackage(pkgName: string, version: string, dest: string): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), 'claude-sdk-'))
  try {
    console.log(`  fetching @anthropic-ai/${pkgName}@${version} via npm pack...`)
    await $`npm pack @anthropic-ai/${pkgName}@${version} --pack-destination ${tmp}`.quiet()
    const tarball = readdirSync(tmp).find((f) => f.endsWith('.tgz'))
    if (!tarball) throw new Error(`npm pack produced no tarball for ${pkgName}`)
    await $`tar -xzf ${join(tmp, tarball)} -C ${tmp}`.quiet()

    rmSync(dest, { recursive: true, force: true })
    mkdirSync(dest, { recursive: true })
    cpSync(join(tmp, 'package'), dest, { recursive: true, dereference: true })
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  const [platform, ...archArgs] = process.argv.slice(2)
  if (!platform) {
    throw new Error('Usage: bun run scripts/stage-claude-sdk-binaries.ts <darwin|win32|linux> [arch...]')
  }
  const arches = archArgs.length ? archArgs : defaultArches(platform)
  const version = resolveSdkVersion()

  for (const arch of arches) {
    const pkgName = `claude-agent-sdk-${platform}-${arch}`
    const dest = join(SCOPE, pkgName)
    const binary = join(dest, binaryName(platform))

    if (existsSync(binary)) {
      console.log(`✓ ${pkgName} already staged`)
      continue
    }

    await fetchPackage(pkgName, version, dest)

    if (!existsSync(binary)) {
      throw new Error(`${pkgName} staged but native binary missing at ${binary}`)
    }
    const size = statSync(binary).size
    if (size < 50_000_000) {
      throw new Error(`${pkgName} native binary too small (${size} bytes, expected ~210 MB)`)
    }
    console.log(`✓ ${pkgName} staged (${(size / 1024 / 1024).toFixed(1)} MB)`)
  }
}

await main()
