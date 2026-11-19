#!/usr/bin/env bun
/**
 * Build the complete, self-contained Linux x64 server distribution.
 *
 * `server:build` alone produces a skeleton: no Web UI, no printing host, no
 * office-host workspace package, a partial node_modules (dev deps included,
 * runtime deps missing) and no Node runtime. This script runs that build, then
 * fills the gaps and trims artifacts for other platforms, so the tarball boots
 * on a machine with nothing installed.
 *
 *   bun run server:dist:linux
 *
 * Build host: Linux x64 with Bun 1.3.14, Node 22, git, unzip, ar and tar.
 * Existing artifacts (webui/dist, resources/*, playwright browsers) are reused;
 * only missing ones are built, so a re-pack after a code change is quick.
 */

import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const DIST_DIR = join(ROOT, 'dist')
const OUT = join(DIST_DIR, 'server')
const RES = join(ROOT, 'apps', 'electron', 'resources')
const GENOFFICE = join(ROOT, 'vendor', 'genoffice')
const PLAYWRIGHT_CACHE = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(process.env.HOME ?? '', '.cache', 'ms-playwright')
const GENOFFICE_RELEASE = 'v0.13.18'
const GENOFFICE_DEB = `genoffice_0.13.18_amd64.deb`

const VERSION: string = JSON.parse(readFileSync(join(ROOT, 'apps', 'electron', 'package.json'), 'utf8')).version

const PACKAGES = [
  'server',
  'server-core',
  'shared',
  'core',
  'session-tools-core',
  'messaging-gateway',
  'messaging-whatsapp-worker',
  'office-host',
]

/** Binaries whose contents other platforms' copies are useless for ours. */
const FOREIGN_ARTIFACTS = [
  '@github/copilot-linuxmusl-x64',
  '@anthropic-ai/claude-agent-sdk-linux-x64-musl',
  '@img/sharp-linuxmusl-x64',
  '@img/sharp-libvips-linuxmusl-x64',
  '@earendil-works/pi-tui/native/darwin',
  '@earendil-works/pi-tui/native/win32',
  '@github/copilot/prebuilds/darwin-arm64',
  '@github/copilot/prebuilds/darwin-x64',
  '@github/copilot/prebuilds/linux-arm64',
  '@github/copilot/prebuilds/win32-arm64',
  '@github/copilot/prebuilds/win32-x64',
  '@github/copilot/ripgrep/bin/darwin-arm64',
  '@github/copilot/ripgrep/bin/darwin-x64',
  '@github/copilot/ripgrep/bin/linux-arm64',
  '@github/copilot/ripgrep/bin/win32-arm64',
  '@github/copilot/ripgrep/bin/win32-x64',
]

/** Env the packaged launcher needs (server:build does not know about these). */
const LAUNCHER_ENV = `
# Added by scripts/build-server-dist.ts — the distribution's own assets.
# Web UI (apps/webui/dist) staged at package time, served on the RPC port.
export CRAFT_WEBUI_DIR="$ROOT/webui"

# Chromium for PDF export and drawio rendering, staged beside the launcher.
export PLAYWRIGHT_BROWSERS_PATH="$ROOT/resources/playwright"

# The WhatsApp worker is CommonJS and the printer launches Playwright through
# \`node\`; the package ships its own Node so the target machine needs nothing.
export CRAFT_MESSAGING_WA_WORKER="$ROOT/packages/messaging-whatsapp-worker/dist/worker.cjs"
export CRAFT_MESSAGING_NODE_BIN="$ROOT/vendor/node/bin/node"

# Prepend resource bin to PATH (doc tool wrappers + the printer's \`node\`).
export PATH="$ROOT/vendor/node/bin:$ROOT/resources/bin:$ROOT/vendor/bun:$PATH"
`

function step(title: string): void {
  console.log(`\n=== ${title} ===`)
}

function fail(message: string): never {
  console.error(`\n✗ ${message}`)
  process.exit(1)
}

function requireExecutable(name: string): string {
  const found = Bun.which(name)
  if (!found) fail(`Required executable not found in PATH: ${name}`)
  return found
}

function expectLinuxBinary(path: string, label: string): void {
  const fd = openSync(path, 'r')
  const head = Buffer.alloc(4)
  try {
    readSync(fd, head, 0, 4, 0)
  } finally {
    closeSync(fd)
  }
  if (!(head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46)) {
    fail(`${label} at ${path} is not a Linux ELF binary (a Windows shim is on PATH?)`)
  }
}

function dirSize(path: string): string {
  const result = Bun.spawnSync({ cmd: ['du', '-sh', path] })
  return result.stdout.toString().trim().split('\t')[0] ?? '?'
}

async function build(name: string, cmd: string[]): Promise<void> {
  console.log(`  → building ${name}...`)
  const proc = Bun.spawn({ cmd, cwd: ROOT, stdout: 'inherit', stderr: 'inherit' })
  const code = await proc.exited
  if (code !== 0) fail(`${name} failed with exit code ${code}`)
}

/**
 * Assert that a directory holds everything the package needs.
 *
 * The Windows and macOS builds verify their staged binaries (`Test-Path` on the SDK, renderer
 * `index.html`) rather than trusting that a copy step ran. The same rule here: a missing editor or
 * runtime must fail the build, not surface as a missing feature on the deployed host.
 */
function requirePaths(
  baseDir: string,
  entries: ReadonlyArray<readonly [path: string, label: string]>,
): void {
  const missing = entries
    .filter(([rel]) => !existsSync(join(baseDir, rel)))
    .map(([rel, label]) => `${rel} (${label})`)
  if (missing.length > 0) {
    fail(`Missing required files in ${baseDir}:\n  - ${missing.join('\n  - ')}`)
  }
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

step('Preflight')
if (process.platform !== 'linux' || process.arch !== 'x64') {
  fail(`This package targets linux-x64; the build host is ${process.platform}-${process.arch}.`)
}
if (!existsSync(join(ROOT, 'package.json'))) fail('Run from the repository root.')

const nodePath = realpathSync(requireExecutable('node'))
expectLinuxBinary(nodePath, 'node')
requireExecutable('tar')
requireExecutable('unzip')
requireExecutable('ar')
console.log(`  ✓ node ${nodePath}`)
console.log(`  ✓ bun ${process.execPath}`)

// The distribution keeps one archive name. Start clean so a stale copy from an
// earlier run — including a thin `server:build --compress` output, which uses the
// same name but is not deployable — can never be mistaken for this build.
rmSync(join(DIST_DIR, `craft-server-${VERSION}-linux-x64.tar.gz`), { force: true })

// ---------------------------------------------------------------------------
// Assets (built only when missing)
// ---------------------------------------------------------------------------

step('Assets')
if (existsSync(join(ROOT, 'apps', 'webui', 'dist', 'index.html'))) {
  console.log('  ✓ webui/dist')
} else {
  await build('webui', ['bun', 'run', 'webui:build'])
}

if (existsSync(join(RES, 'models', 'silero_vad.onnx'))) {
  console.log('  ✓ ASR VAD model')
} else {
  await build('sherpa VAD', ['bun', 'run', 'fetch:sherpa-vad'])
}

if (existsSync(join(RES, 'cli-tools', 'dist', 'img-tool.mjs'))) {
  console.log('  ✓ cli-tools/dist')
} else {
  if (!existsSync(join(RES, 'cli-tools', 'models', 'ocr', 'det.onnx'))) {
    await build('OCR models', ['bun', 'run', 'fetch:ocr-models'])
  }
  await build('cli-tools', ['bun', 'run', 'build:cli-tools'])
}

if (existsSync(join(RES, 'drawio', 'index.html'))) {
  console.log('  ✓ drawio')
} else {
  await build('drawio', ['bun', 'run', 'electron:fetch:drawio'])
}

if (existsSync(join(RES, 'office', 'docs', 'index.html'))) {
  console.log('  ✓ office editors')
} else {
  if (!existsSync(join(GENOFFICE, 'apps', 'docs'))) {
    await build('GenOffice source', ['bun', 'run', 'scripts/fetch-genoffice-source.ts'])
  }
  if (!existsSync(join(GENOFFICE, 'node_modules'))) {
    const proc = Bun.spawn({ cmd: ['npm', 'install', '--no-audit', '--no-fund'], cwd: GENOFFICE, stdout: 'inherit', stderr: 'inherit' })
    if ((await proc.exited) !== 0) fail('npm install in vendor/genoffice failed')
  }
  const editors = ['docs', 'pdf', 'slides']
  const built = editors.every((app) => existsSync(join(GENOFFICE, 'apps', app, 'out', 'renderer', 'index.html')))
  if (!built) {
    await build('office editors', ['npm', 'run', 'build', '-w', '@genoffice/docs', '-w', '@genoffice/pdf', '-w', '@genoffice/slides'])
  }
  if (!existsSync(join(GENOFFICE, 'apps', 'sheets', 'out', 'renderer', 'index.html'))) {
    const proc = Bun.spawn({ cmd: ['npx', 'electron-vite', 'build'], cwd: join(GENOFFICE, 'apps', 'sheets'), stdout: 'inherit', stderr: 'inherit' })
    if ((await proc.exited) !== 0) fail('sheets editor build failed')
  }
  if (!existsSync(join(GENOFFICE, 'packages', 'cli', 'dist', 'genoffice.cjs'))) {
    await build('GenOffice CLI', ['npm', 'run', 'build', '-w', '@genoffice/cli'])
  }
}

if (existsSync(join(RES, 'office-engine', 'pptx.cjs'))) {
  console.log('  ✓ office-engine')
} else {
  await build('office engine', ['bun', 'run', 'scripts/build-office-engine.ts'])
}

if (existsSync(join(RES, 'office', 'docs', 'index.html')) && existsSync(join(RES, 'cli', 'genoffice.cjs'))) {
  console.log('  ✓ office assets copied')
} else {
  await build('office assets', ['bun', 'run', 'scripts/build-office-assets.ts'])
}

if (existsSync(join(RES, 'office-native', 'xlsx-sidecar'))) {
  console.log('  ✓ xlsx sidecar')
} else {
  console.log('  → xlsx sidecar missing, taking it from the GenOffice release...')
  const cache = join(DIST_DIR, '.cache', `genoffice-${GENOFFICE_RELEASE}`)
  const extracted = join(cache, 'opt', 'GenOffice')
  if (!existsSync(extracted)) {
    mkdirSync(cache, { recursive: true })
    const deb = join(cache, GENOFFICE_DEB)
    const url = `https://github.com/genspark-ai/genoffice/releases/download/${GENOFFICE_RELEASE}/${GENOFFICE_DEB}`
    if ((await Bun.spawn({ cmd: ['curl', '-fL', '--retry', '3', '-o', deb, url], stdout: 'inherit', stderr: 'inherit' }).exited) !== 0) {
      fail(`Could not download ${url}`)
    }
    if ((await Bun.spawn({ cmd: ['ar', 'x', deb], cwd: cache, stdout: 'inherit', stderr: 'inherit' }).exited) !== 0) {
      fail('ar x failed on the GenOffice deb')
    }
    const data = readdirSync(cache).find((f) => f.startsWith('data.tar.'))
    if (!data) fail('No data.tar.* in the GenOffice deb')
    const tar = Bun.spawn({ cmd: ['env', '-u', 'LD_LIBRARY_PATH', 'tar', 'xf', data], cwd: cache, stdout: 'inherit', stderr: 'inherit' })
    if ((await tar.exited) !== 0) fail('tar xf failed on the GenOffice deb')
  }
  await build('xlsx sidecar', ['bun', 'run', 'scripts/build-office-native.ts', '--from', extracted])
}

if (existsSync(join(ROOT, 'packages', 'render-host', 'dist', 'cli.mjs'))) {
  console.log('  ✓ render-host bundle')
} else {
  await build('render-host', ['bun', 'run', '--cwd', 'packages/render-host', 'build:cli'])
}

const expectedRevision = (() => {
  const file = join(ROOT, 'node_modules', 'playwright-core', 'browsers.json')
  if (!existsSync(file)) return null
  const json = JSON.parse(readFileSync(file, 'utf8')) as { browsers?: Array<{ name: string; revision: string }> }
  return json.browsers?.find((b) => b.name === 'chromium-headless-shell')?.revision ?? null
})()
const browserDir = expectedRevision ? join(PLAYWRIGHT_CACHE, `chromium_headless_shell-${expectedRevision}`) : null
if (browserDir && existsSync(browserDir)) {
  console.log(`  ✓ Chromium (revision ${expectedRevision})`)
} else {
  await build('Chromium', ['node', 'node_modules/playwright-core/cli.js', 'install', 'chromium-headless-shell'])
}

step('Verify inputs')
requirePaths(ROOT, [
  ['apps/webui/dist/index.html', 'Web UI'],
  ['packages/render-host/dist/cli.mjs', 'render host bundle'],
  ['apps/electron/resources/drawio/index.html', 'drawio editor'],
  ['apps/electron/resources/office/docs/index.html', 'office editor'],
  ['apps/electron/resources/office-engine/pptx.cjs', 'office engine'],
  ['apps/electron/resources/cli/genoffice.cjs', 'GenOffice CLI'],
  ['apps/electron/resources/office-native/xlsx-sidecar', 'xlsx sidecar'],
  ['apps/electron/resources/cli-tools/dist/img-tool.mjs', 'command-line tools'],
  ['apps/electron/resources/models/silero_vad.onnx', 'ASR VAD model'],
])
if (expectedRevision) {
  requirePaths(PLAYWRIGHT_CACHE, [[`chromium_headless_shell-${expectedRevision}`, 'Chromium']])
}
console.log('  ✓ all build inputs present')

// ---------------------------------------------------------------------------
// Skeleton build
// ---------------------------------------------------------------------------

step('server:build')
if ((await Bun.spawn({ cmd: ['bun', 'run', 'scripts/build-server.ts', '--platform=linux', '--arch=x64'], cwd: ROOT, stdout: 'inherit', stderr: 'inherit' }).exited) !== 0) {
  fail('scripts/build-server.ts failed')
}

// ---------------------------------------------------------------------------
// Fill the gaps
// ---------------------------------------------------------------------------

step('Workspace packages')

// `server:build` copies a fixed list that predates office-host, but the server
// imports it at startup.
if (!existsSync(join(OUT, 'packages', 'office-host'))) {
  mkdirSync(join(OUT, 'packages', 'office-host'), { recursive: true })
  cpSync(join(ROOT, 'packages', 'office-host', 'package.json'), join(OUT, 'packages', 'office-host', 'package.json'))
  cpSync(join(ROOT, 'packages', 'office-host', 'src'), join(OUT, 'packages', 'office-host', 'src'), { recursive: true })
}
console.log('  ✓ office-host staged (links are created after install)')

step('Production dependencies')

// The monorepo's root package.json carries production deps the server uses,
// plus a few runtime imports that live in devDependencies (`tar`) or are only
// pulled in by packages outside the copied workspace set (playwright-core).
cpSync(join(ROOT, 'bunfig.toml'), join(OUT, 'bunfig.toml'))

const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>
}
const distPkgPath = join(OUT, 'package.json')
const distPkg = JSON.parse(readFileSync(distPkgPath, 'utf8')) as {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}
distPkg.dependencies = { ...(distPkg.dependencies ?? {}), ...(rootPkg.dependencies ?? {}) }
for (const name of Object.keys(distPkg.dependencies)) {
  const installed = join(ROOT, 'node_modules', name, 'package.json')
  if (existsSync(installed)) {
    distPkg.dependencies[name] = (JSON.parse(readFileSync(installed, 'utf8')) as { version: string }).version
  }
}
for (const name of ['tar', 'playwright-core']) {
  const installed = join(ROOT, 'node_modules', name, 'package.json')
  if (!existsSync(installed)) fail(`${name} is not installed in the repo — bun install first`)
  distPkg.dependencies[name] = (JSON.parse(readFileSync(installed, 'utf8')) as { version: string }).version
}
delete distPkg.devDependencies
writeFileSync(distPkgPath, JSON.stringify(distPkg, null, 2) + '\n')

for (const pkg of readdirSync(join(OUT, 'packages'))) {
  const meta = join(OUT, 'packages', pkg, 'package.json')
  if (!existsSync(meta)) continue
  const json = JSON.parse(readFileSync(meta, 'utf8')) as { devDependencies?: unknown }
  delete json.devDependencies
  writeFileSync(meta, JSON.stringify(json, null, 2) + '\n')
}

rmSync(join(OUT, 'node_modules'), { recursive: true, force: true })
for (const pkg of readdirSync(join(OUT, 'packages'))) {
  rmSync(join(OUT, 'packages', pkg, 'node_modules'), { recursive: true, force: true })
}
rmSync(join(OUT, 'bun.lock'), { force: true })

const install = Bun.spawn({
  cmd: ['env', '-u', 'CI', '-u', 'LD_LIBRARY_PATH', 'bun', 'install', '--production'],
  cwd: OUT,
  stdout: 'inherit',
  stderr: 'inherit',
})
if ((await install.exited) !== 0) fail('bun install --production failed')

// Bun does not always create the workspace links for the copied packages, so
// they are written explicitly after the install (it would remove them anyway).
const scope = join(OUT, 'node_modules', '@craft-agent')
mkdirSync(scope, { recursive: true })
let linked = 0
for (const pkg of PACKAGES) {
  const meta = join(OUT, 'packages', pkg, 'package.json')
  if (!existsSync(meta)) continue
  const { name } = JSON.parse(readFileSync(meta, 'utf8')) as { name?: string }
  if (!name?.startsWith('@craft-agent/')) continue
  const link = join(scope, name.slice('@craft-agent/'.length))
  rmSync(link, { force: true })
  symlinkSync(join('..', '..', 'packages', pkg), link, 'dir')
  linked += 1
}
console.log(`  ✓ node_modules ${dirSize(join(OUT, 'node_modules'))} · ${linked} workspace links`)

// ---------------------------------------------------------------------------
// Runtime assets
// ---------------------------------------------------------------------------

step('Runtime assets')

cpSync(join(ROOT, 'apps', 'webui', 'dist'), join(OUT, 'webui'), { recursive: true })
mkdirSync(join(OUT, 'resources', 'render-host'), { recursive: true })
cpSync(join(ROOT, 'packages', 'render-host', 'dist', 'cli.mjs'), join(OUT, 'resources', 'render-host', 'cli.mjs'))
cpSync(join(ROOT, 'packages', 'render-host', 'dist', 'craft-headless-export'), join(OUT, 'resources', 'render-host', 'craft-headless-export'))
chmodSync(join(OUT, 'resources', 'render-host', 'craft-headless-export'), 0o755)
cpSync(PLAYWRIGHT_CACHE, join(OUT, 'resources', 'playwright'), { recursive: true })
mkdirSync(join(OUT, 'vendor', 'node', 'bin'), { recursive: true })
cpSync(nodePath, join(OUT, 'vendor', 'node', 'bin', 'node'))
chmodSync(join(OUT, 'vendor', 'node', 'bin', 'node'), 0o755)

// License files travel with the artifact, the way the installers carry them.
for (const file of ['LICENSE', 'NOTICE']) {
  if (existsSync(join(ROOT, file))) cpSync(join(ROOT, file), join(OUT, file))
}
console.log('  ✓ webui, render-host, Chromium, node, licenses')

step('Trim other platforms')
for (const rel of FOREIGN_ARTIFACTS) {
  rmSync(join(OUT, 'node_modules', rel), { recursive: true, force: true })
}
console.log(`  ✓ removed ${FOREIGN_ARTIFACTS.length} non-linux-x64 artifacts`)

step('Launcher environment')
const launcherPath = join(OUT, 'bin', 'craft-server')
const launcher = readFileSync(launcherPath, 'utf8')
if (launcher.includes('CRAFT_WEBUI_DIR')) {
  console.log('  ✓ already present')
} else {
  const marker = '\n# Use bundled Bun runtime'
  if (!launcher.includes(marker)) fail('Unexpected bin/craft-server layout; cannot inject env')
  writeFileSync(launcherPath, launcher.replace(marker, `${LAUNCHER_ENV}${marker}`))
  console.log('  ✓ injected CRAFT_WEBUI_DIR / PLAYWRIGHT_BROWSERS_PATH / Node paths')
}

step('Verify distribution')
requirePaths(OUT, [
  ['bin/craft-server', 'launcher'],
  ['start.sh', 'entry script'],
  ['install.sh', 'installer'],
  ['package.json', 'manifest'],
  ['vendor/bun/bun', 'Bun runtime'],
  ['vendor/node/bin/node', 'Node runtime'],
  ['webui/index.html', 'Web UI'],
  ['resources/render-host/craft-headless-export', 'printing host'],
  ['resources/drawio/index.html', 'drawio editor'],
  ['resources/office/docs/index.html', 'office editor'],
  ['resources/office-engine/pptx.cjs', 'office engine'],
  ['resources/cli/genoffice.cjs', 'GenOffice CLI'],
  ['resources/office-native/xlsx-sidecar', 'xlsx sidecar'],
  ['resources/cli-tools/dist/img-tool.mjs', 'command-line tools'],
  ['resources/models/silero_vad.onnx', 'ASR VAD model'],
  ['node_modules/@craft-agent/office-host', 'office-host package'],
  ['packages/messaging-whatsapp-worker/dist/worker.cjs', 'WhatsApp worker'],
])
if (expectedRevision) {
  requirePaths(OUT, [[`resources/playwright/chromium_headless_shell-${expectedRevision}`, 'Chromium']])
}
console.log('  ✓ every required file is in place')

// ---------------------------------------------------------------------------
// Archive
// ---------------------------------------------------------------------------

step('Archive')
const archive = join(DIST_DIR, `craft-server-${VERSION}-linux-x64.tar.gz`)
const topLevel = `craft-server-${VERSION}`
rmSync(archive, { force: true })
// Name the members explicitly instead of passing `.`: that keeps the archive free
// of a bare `./` entry alongside the versioned root.
const topEntries = readdirSync(OUT)
const tar = Bun.spawn({
  cmd: [
    'env',
    '-u',
    'LD_LIBRARY_PATH',
    'tar',
    '-czf',
    archive,
    // One versioned root directory, like an installer: extracting into a shared
    // directory must not scatter `bin/ resources/ node_modules/` across it.
    '--transform',
    `s,^,${topLevel}/,`,
    '--sort=name',
    '--owner=0',
    '--group=0',
    '--numeric-owner',
    '-C',
    OUT,
    ...topEntries,
  ],
  stdout: 'inherit',
  stderr: 'inherit',
})
if ((await tar.exited) !== 0) fail('tar failed')

const checksumFile = `${archive}.sha256`
const checksum = Bun.spawnSync({ cmd: ['sha256sum', archive.split('/').pop()!], cwd: DIST_DIR })
if (checksum.exitCode !== 0) fail('sha256sum failed')
const digest = checksum.stdout.toString().split(/\s+/)[0]!
writeFileSync(checksumFile, checksum.stdout)

console.log(`\n✓ ${archive}`)
console.log(`  ${(statSync(archive).size / 1024 / 1024).toFixed(0)} MB archive · ${dirSize(OUT)} unpacked`)
console.log(`  sha256 ${digest}`)
console.log(`\nRun:`)
console.log(`  mkdir -p /opt/craft && tar xzf ${archive} -C /opt/craft --strip-components=1`)
console.log(`  cd /opt/craft && ./install.sh && ./start.sh`)
