/**
 * What a build needs on disk, checked in one place.
 *
 * Two callers ask this, and they ask slightly differently on purpose:
 *
 * - `validate-assets.ts` (`bun run build:validate`, the last step of `bun run build`) is the gate:
 *   anything `required` missing fails the build.
 * - `copy-assets.ts` runs it right after copying `resources/` → `dist/resources/` and only
 *   **reports** the optional blocks, because a build without the office editors is a legitimate
 *   build (the editors' origin answers "not installed in this build" per app) and turning that into
 *   a hard failure would make `bun run build` unusable on a machine that never fetched GenOffice.
 *
 * That distinction is the whole point of the module: before it existed, `build:validate` pointed at
 * a file that had never been written, so `bun run build` failed at its last step and nobody could
 * tell whether the assets were fine.
 */

import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface AssetCheck {
  /** What is being checked, as a person reads it in a build log. */
  label: string
  /** Absolute path that was looked at. */
  path: string
  ok: boolean
  /** Required for `build:validate`; a missing optional block is reported, never failed. */
  required: boolean
  /** How to produce it, when it is missing. */
  hint?: string
}

const fileExists = (path: string): boolean => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

const directoryExists = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Every path this build reads from `resources/`, as a list.
 *
 * `electronDir` is `apps/electron` (the directory the build scripts run from), so the two roots are
 * `resources/` and `dist/`.
 */
export function checkAssets(electronDir: string): AssetCheck[] {
  const resources = join(electronDir, 'resources')
  const dist = join(electronDir, 'dist')
  const checks: AssetCheck[] = []
  const addPath = (label: string, path: string, required: boolean, hint?: string) =>
    checks.push({ label, path, ok: fileExists(path) || directoryExists(path), required, hint })

  // ── the app itself ──
  addPath('dist/main.cjs', join(dist, 'main.cjs'), true, 'bun run electron:build:main')
  addPath('dist/renderer/index.html', join(dist, 'renderer', 'index.html'), true, 'bun run electron:build:renderer')

  // ── assets the Bun tools read by name ──
  addPath('cli-tools/img-tool.mjs', join(resources, 'cli-tools', 'dist', 'img-tool.mjs'), true, 'bun run build:cli-tools')
  addPath('cli-tools/ical-tool.mjs', join(resources, 'cli-tools', 'dist', 'ical-tool.mjs'), true, 'bun run build:cli-tools')
  addPath('cli-tools/asr-tool.mjs', join(resources, 'cli-tools', 'dist', 'asr-tool.mjs'), true, 'bun run build:cli-tools')
  // The OCR models `img-tool text` reads — each file, not just the folder, so a half-staged
  // `models/ocr` (one model missing) is caught too. Optional for a plain build: every other
  // img-tool command runs without them and the fetch needs the network. `--strict`, which the
  // release scripts run, does fail on a missing optional block, so a package whose "Read text"
  // cannot work is not shipped.
  for (const file of ['det.onnx', 'rec.onnx', 'dict.txt']) {
    addPath(
      `cli-tools/models/ocr/${file}`,
      join(resources, 'cli-tools', 'dist', 'models', 'ocr', file),
      false,
      'bun run fetch:ocr-models && bun run build:cli-tools',
    )
  }
  addPath('pi-agent-server/index.js', join(resources, 'pi-agent-server', 'index.js'), false, 'staged by electron:build:main')

  // ── assets every build carries ──
  addPath('resources/docs', join(resources, 'docs'), true)
  addPath('resources/themes', join(resources, 'themes'), true)
  addPath('resources/permissions/default.json', join(resources, 'permissions', 'default.json'), true)
  addPath('resources/tool-icons', join(resources, 'tool-icons'), true)
  addPath('resources/config-defaults.json', join(resources, 'config-defaults.json'), true)

  // ── bundled runtimes ──
  // uv runs the Python **scripts a person writes**, not the agent's own tools (those are the Bun
  // bundles above). electron-builder only logs `file source doesn't exist` for a missing
  // `extraResources` source and packages without it, so a missing uv has to fail here — otherwise
  // the package is built and "no Python runtime" is discovered at run time instead.
  const hostPlatform = process.platform === 'win32' ? 'win32' : process.platform === 'linux' ? 'linux' : 'darwin'
  const hostArch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const uvName = hostPlatform === 'win32' ? 'uv.exe' : 'uv'
  addPath(
    `resources/bin/${hostPlatform}-${hostArch}/${uvName}`,
    join(resources, 'bin', `${hostPlatform}-${hostArch}`, uvName),
    true,
    `bun run fetch:uv ${hostPlatform} ${hostArch}`,
  )

  // ── local speech recognition: optional, and only the tiny VAD model ships ──
  // Without it a recording is transcribed as one chunk: subtitles still come out, their boundaries
  // just stop following the pauses. The ASR model itself (SenseVoice) is the
  // person's own, placed under ~/.craft-agent/models.
  addPath(
    'models/silero_vad.onnx',
    join(resources, 'models', 'silero_vad.onnx'),
    false,
    'bun run fetch:sherpa-vad',
  )

  // ── the office editors: optional, and each one is a separate install ──
  for (const app of ['docs', 'sheets', 'slides', 'pdf']) {
    addPath(
      `office/${app}`,
      join(resources, 'office', app, 'index.html'),
      false,
      'bun scripts/build-office-assets.ts (needs a GenOffice checkout)',
    )
  }
  addPath(
    'office-engine/pptx.cjs',
    join(resources, 'office-engine', 'pptx.cjs'),
    false,
    'bun scripts/fetch-genoffice-source.ts && bun scripts/build-office-engine.ts',
  )
  addPath(
    'office-engine/pdfium.wasm',
    join(resources, 'office-engine', 'node_modules', '@embedpdf', 'pdfium', 'dist', 'pdfium.wasm'),
    false,
    'bun scripts/build-office-engine.ts',
  )
  addPath(
    'office-native/xlsx-sidecar',
    join(resources, 'office-native', process.platform === 'win32' ? 'xlsx-sidecar.exe' : 'xlsx-sidecar'),
    false,
    'copy a prebuilt sidecar from a GenOffice release',
  )
  addPath(
    'cli/genoffice.cjs',
    join(resources, 'cli', 'genoffice.cjs'),
    false,
    'bun scripts/build-office-assets.ts (the document tools spawn it)',
  )

  return checks
}

/** `✓ label` / `✗ label — hint`, one per line. */
export function formatChecks(checks: readonly AssetCheck[]): string[] {
  return checks.map((check) => {
    if (check.ok) return `  ✓ ${check.label}`
    const mark = check.required ? '✗' : '·'
    return `  ${mark} ${check.label} — missing${check.hint ? `; ${check.hint}` : ''}`
  })
}
