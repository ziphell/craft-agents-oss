/**
 * Build the bundled command-line tools into `apps/electron/resources/cli-tools/dist/`.
 *
 * These are the tools that used to be Python behind `uv` (`resources/scripts/*.py`, kept in the
 * repository as the reference for what each command means). They keep their names, so the agent's
 * instructions and the permission rules are unchanged — what changed is that a host needs nothing
 * but the Bun it already has.
 *
 * One file per tool, because a script that resolves `node_modules` at run time cannot be shipped
 * into an app whose `node_modules` is not shipped. Bundling inlines everything except the native
 * packages — `sharp` for pictures, `onnxruntime-node` for `img-tool text` — whose `.node`/`.dll`
 * cannot be inlined; each is copied beside the bundles, exactly the way `office-engine` ships
 * `jszip`.
 *
 * `onnxruntime-node` is copied **pruned**: the installed package carries every platform's runtime
 * (293 MB), and only the target platform's CPU runtime is used. `--platform` / `--arch` default to
 * the host, which is the platform a release for that host is built on.
 *
 * The OCR models are fetched, not committed (`bun run fetch:ocr-models`) and staged as
 * `dist/models/ocr`, so every consumer of `cli-tools/dist` — the desktop package, the server
 * package, the bundled-assets copy — carries them without a second rule.
 *
 *   bun scripts/build-cli-tools.ts            # build
 *   bun scripts/build-cli-tools.ts --check    # report what is missing, build nothing
 *   bun scripts/build-cli-tools.ts --platform=win32 --arch=x64
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, cpSync, writeFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const SOURCE = join(ROOT, 'apps', 'electron', 'resources', 'cli-tools')
const OUT = join(SOURCE, 'dist')
const CHECK = process.argv.includes('--check')

const argValue = (flag: string): string | undefined => {
  const index = process.argv.indexOf(flag)
  return index === -1 ? undefined : process.argv[index + 1]
}
const PLATFORM = argValue('--platform') ?? process.platform
const ARCH = argValue('--arch') ?? process.arch

/** The models `img-tool text` reads, fetched by `scripts/fetch-ocr-models.ts`. */
const OCR_MODELS = join(SOURCE, 'models', 'ocr')

/** The local speech models that ship with the app (the VAD), fetched by `fetch:sherpa-vad`. */
const ASR_MODELS = join(ROOT, 'apps', 'electron', 'resources', 'models')

/** The tools, and the Node packages each one needs beside it (bundled unless listed here). */
const TOOLS: ReadonlyArray<{ name: string; entry: string; external?: readonly string[] }> = [
  { name: 'img-tool', entry: 'img-tool.ts', external: ['sharp', 'onnxruntime-node'] },
  { name: 'ical-tool', entry: 'ical-tool.ts' },
  { name: 'asr-tool', entry: 'asr-tool.ts', external: ['sherpa-onnx-node'] },
]

/**
 * The packages that cannot be bundled, copied beside the bundles.
 *
 * `sharp` resolves its platform build through `@img`, so all three travel together. Everything else
 * the tools need is inside the `.mjs` files, which is what lets a packaged app run them without
 * shipping `node_modules`.
 */
const BESIDE: ReadonlyArray<{ name: string; packages: (modules: string) => string[] }> = [
  {
    name: 'sharp',
    packages: (modules) => [
      join(modules, 'sharp'),
      join(modules, '@img', 'colour'),
      ...readdirSync(join(modules, '@img'), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith('sharp-'))
        .map((entry) => join(modules, '@img', entry.name)),
    ],
  },
]

function stageBeside(outDir: string): Array<{ ok: boolean; label: string; detail: string }> {
  const modules = join(ROOT, 'node_modules')
  const target = join(outDir, 'node_modules')
  return BESIDE.map((group) => {
    let sources: string[] = []
    try {
      sources = (group.packages(modules) as string[]).filter((path) => existsSync(path))
    } catch {
      sources = []
    }
    if (!sources.length) return { ok: false, label: group.name, detail: 'not installed in this checkout' }
    for (const source of sources) {
      cpSync(source, join(target, source.slice(modules.length + 1)), { recursive: true })
    }
    return { ok: true, label: group.name, detail: `${sources.length} package(s)` }
  })
}

function sizeOf(path: string): number {
  if (!existsSync(path)) return 0
  const stats = statSync(path)
  if (stats.isFile()) return stats.size
  return readdirSync(path, { withFileTypes: true }).reduce(
    (total, entry) => total + sizeOf(join(path, entry.name)),
    0,
  )
}

const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`

/**
 * `onnxruntime-node`, copied as the one platform this build runs on.
 *
 * Two prunes, each measured rather than guessed: the package installs every platform's runtime
 * (293 MB in this checkout — win32 136 MB, darwin 87 MB, linux 71 MB), and Windows additionally
 * carries `DirectML.dll` + `dxcompiler.dll` (35 MB) which are only loaded when a caller asks for
 * the `dml` execution provider. This tool asks for the CPU one. What ships is the platform's
 * runtime beside its binding: win32-x64 30.6 MB, darwin-arm64 43.2 MB, linux-x64 45.3 MB.
 *
 * `onnxruntime-common` is the package's own runtime dependency; `adm-zip` and `global-agent` are
 * used by its install script, not by inference, so they stay out.
 */
function stageOnnxruntime(outDir: string): { ok: boolean; label: string; detail: string } {
  const modules = join(ROOT, 'node_modules')
  const source = join(modules, 'onnxruntime-node')
  const native = join(source, 'bin', 'napi-v6', PLATFORM, ARCH)
  if (!existsSync(source)) return { ok: false, label: 'onnxruntime-node', detail: 'not installed in this checkout' }
  if (!existsSync(native)) {
    return { ok: false, label: 'onnxruntime-node', detail: `no ${PLATFORM}/${ARCH} runtime in this checkout` }
  }

  const target = join(outDir, 'node_modules')
  const dest = join(target, 'onnxruntime-node')
  rmSync(dest, { recursive: true, force: true })
  cpSync(join(source, 'package.json'), join(dest, 'package.json'))
  cpSync(join(source, 'dist'), join(dest, 'dist'), { recursive: true })
  cpSync(native, join(dest, 'bin', 'napi-v6', PLATFORM, ARCH), { recursive: true })
  for (const name of ['DirectML.dll', 'dxcompiler.dll']) {
    rmSync(join(dest, 'bin', 'napi-v6', PLATFORM, ARCH, name), { force: true })
  }

  const common = join(modules, 'onnxruntime-common')
  if (existsSync(common)) cpSync(common, join(target, 'onnxruntime-common'), { recursive: true })

  return { ok: true, label: 'onnxruntime-node', detail: `${PLATFORM}/${ARCH} CPU, ${mb(sizeOf(dest))}` }
}

const sherpaPlatformPackage = (): string =>
  `sherpa-onnx-${PLATFORM === 'win32' ? 'win' : PLATFORM}-${ARCH}`

/**
 * `sherpa-onnx-node`, copied beside the bundle with the one platform package it loads.
 *
 * The wrapper resolves its native addon through `../sherpa-onnx-<platform>-<arch>/sherpa-onnx.node`
 * (`addon.js`), so the pair must keep that sibling layout. Windows is `win` in the package name,
 * not `win32` — the same spelling electron-builder's extraResources use for the app itself.
 */
function stageSherpa(outDir: string): { ok: boolean; label: string; detail: string } {
  const modules = join(ROOT, 'node_modules')
  const source = join(modules, 'sherpa-onnx-node')
  const nativeName = sherpaPlatformPackage()
  const native = join(modules, nativeName)
  if (!existsSync(source)) return { ok: false, label: 'sherpa-onnx-node', detail: 'not installed in this checkout' }
  if (!existsSync(native)) {
    return { ok: false, label: 'sherpa-onnx-node', detail: `no ${nativeName} package in this checkout` }
  }

  const target = join(outDir, 'node_modules')
  cpSync(source, join(target, 'sherpa-onnx-node'), { recursive: true, force: true })
  cpSync(native, join(target, nativeName), { recursive: true, force: true })
  return {
    ok: true,
    label: 'sherpa-onnx-node',
    detail: `${nativeName}, ${mb(sizeOf(join(target, 'sherpa-onnx-node')) + sizeOf(join(target, nativeName)))}`,
  }
}

/**
 * The OCR models, staged where the bundle looks for them (`dist/models/ocr`).
 *
 * Missing models are not a build failure: every other `img-tool` command works without them, and
 * `img-tool text` says what to run. Fetching needs the network, which a build should not assume.
 */
function stageOcrModels(outDir: string): { ok: boolean; label: string; detail: string } {
  if (!existsSync(OCR_MODELS)) {
    return { ok: false, label: 'ocr-models', detail: 'not fetched — run `bun run fetch:ocr-models`' }
  }
  const dest = join(outDir, 'models', 'ocr')
  cpSync(OCR_MODELS, dest, { recursive: true, force: true })
  return { ok: true, label: 'ocr-models', detail: mb(sizeOf(dest)) }
}

/**
 * The Silero VAD model, staged where `asr-tool` looks for it (`dist/models/silero_vad.onnx`).
 *
 * Optional like the OCR models: without it a recording is decoded as one chunk, which still
 * transcribes — the subtitles just stop following the pauses.
 */
function stageAsrModels(outDir: string): { ok: boolean; label: string; detail: string } {
  if (!existsSync(ASR_MODELS)) {
    return { ok: false, label: 'asr-vad', detail: 'not fetched — run `bun run fetch:sherpa-vad`' }
  }
  const dest = join(outDir, 'models')
  cpSync(ASR_MODELS, dest, { recursive: true, force: true })
  return { ok: true, label: 'asr-vad', detail: mb(sizeOf(join(dest, 'silero_vad.onnx'))) }
}

if (CHECK) {
  const rows = TOOLS.map((tool) => {
    const file = join(OUT, `${tool.name}.mjs`)
    return {
      label: tool.name,
      detail: existsSync(file) ? `${(sizeOf(file) / 1024).toFixed(0)} KB` : 'missing',
      required: true,
    }
  })
  for (const group of BESIDE) {
    const dir = join(OUT, 'node_modules', group.name === 'sharp' ? 'sharp' : group.name)
    rows.push({
      label: group.name,
      detail: existsSync(dir) ? mb(sizeOf(dir)) : 'missing',
      required: true,
    })
  }
  const native = join(OUT, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6', PLATFORM, ARCH)
  rows.push({
    label: 'onnxruntime-node',
    detail: existsSync(native) ? `${PLATFORM}/${ARCH} CPU, ${mb(sizeOf(join(OUT, 'node_modules', 'onnxruntime-node')))}` : 'missing',
    required: true,
  })
  rows.push({
    label: 'ocr-models',
    detail: existsSync(join(OUT, 'models', 'ocr')) ? mb(sizeOf(join(OUT, 'models', 'ocr'))) : 'missing (optional)',
    required: false,
  })
  rows.push({
    label: 'sherpa-onnx-node',
    detail: (() => {
      const wrapper = join(OUT, 'node_modules', 'sherpa-onnx-node')
      const platform = sherpaPlatformPackage()
      if (!existsSync(wrapper) || !existsSync(join(OUT, 'node_modules', platform))) return 'missing'
      return mb(sizeOf(wrapper) + sizeOf(join(OUT, 'node_modules', platform)))
    })(),
    required: true,
  })
  rows.push({
    label: 'asr-vad',
    detail: existsSync(join(OUT, 'models', 'silero_vad.onnx')) ? mb(sizeOf(join(OUT, 'models', 'silero_vad.onnx'))) : 'missing (optional)',
    required: false,
  })
  const width = Math.max(...rows.map((row) => row.label.length))
  for (const row of rows) {
    const mark = row.detail === 'missing' || row.detail.startsWith('missing') ? (row.required ? '✗' : '·') : '✓'
    console.log(`${mark} ${row.label.padEnd(width)}  ${row.detail}`)
  }
  process.exit(rows.some((row) => row.required && row.detail === 'missing') ? 1 : 0)
}

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

for (const tool of TOOLS) {
  const entry = join(SOURCE, tool.entry)
  if (!existsSync(entry)) throw new Error(`missing entry: ${entry}`)
  const result = Bun.spawnSync({
    cmd: [
      'bun',
      'build',
      entry,
      '--target=bun',
      '--format=esm',
      `--outfile=${join(OUT, `${tool.name}.mjs`)}`,
      ...(tool.external ?? []).flatMap((name) => ['--external', name]),
    ],
    cwd: ROOT,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if (result.exitCode !== 0) throw new Error(`bun build failed for ${tool.name}`)
}

const staged = [...stageBeside(OUT), stageOnnxruntime(OUT), stageSherpa(OUT), stageOcrModels(OUT), stageAsrModels(OUT)]
writeFileSync(
  join(OUT, '.cli-tools.json'),
  JSON.stringify(
    {
      built: new Date().toISOString(),
      tools: TOOLS.map((tool) => tool.name),
      beside: Object.fromEntries(staged.map((group) => [group.label, group.detail])),
    },
    null,
    2,
  ),
)

console.log(`built ${TOOLS.length} tool(s) into ${OUT} (${PLATFORM}/${ARCH})`)
for (const group of staged) console.log(`  ${group.label}: ${group.ok ? group.detail : `NOT STAGED — ${group.detail}`}`)
for (const tool of TOOLS) console.log(`  ${tool.name}.mjs  ${(sizeOf(join(OUT, `${tool.name}.mjs`)) / 1024).toFixed(0)} KB`)
console.log(`  total ${mb(sizeOf(OUT))}`)

// A tool whose bundle exists but whose package is missing fails at run time with an import error,
// which reads as a broken install. Say it here instead. The OCR models are the one exception:
// without them the other commands still work, so a missing fetch is a warning, not a failed build.
for (const group of staged.filter((entry) => !entry.ok)) {
  const optional = group.label === 'ocr-models' || group.label === 'asr-vad'
  console.warn(`\n⚠ ${group.label} ${group.detail}; ${optional ? 'the tools that need it will say so until then.' : 'the tools that need it will fail until it is installed.'}`)
  if (!optional) process.exitCode = 1
}

// Keep the source readable in the packaged app: a build that consumed its own output as input
// would otherwise leave a stale `dist` nobody can date.
const stamp = join(OUT, '.cli-tools.json')
if (existsSync(stamp)) console.log(`  stamp: ${JSON.parse(readFileSync(stamp, 'utf-8')).built}`)
