/**
 * Run the real poster pipeline once per format, outside the app, and print what it produced.
 *
 * The pipeline is the app's own (`createCreationThumbnailer` → `captureSurface` → the office
 * editors), so what this reports is what a card would show — without launching the app, taking the
 * single-instance lock, or waiting for a person to scroll.
 *
 * Build and run (from the repo root):
 *   bunx esbuild apps/electron/spike/capture-probe.ts --bundle --platform=node --format=cjs \
 *     --external:electron --outfile=apps/electron/spike/capture-probe.cjs
 *   (cd apps/electron && ../../node_modules/electron/dist/electron.exe spike/capture-probe.cjs)
 */
import { app } from 'electron'
import { mkdirSync, mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerPrivilegedSchemes } from '../src/main/thumbnail-protocol'
import { createCreationThumbnailer } from '../src/main/creation-thumbnailer'
import { registerLocalOriginHandler } from '../src/main/local-origin-router'
import { session } from 'electron'

console.log('[probe] starting')
process.on('uncaughtException', (error) => {
  console.log('[probe] uncaught', error)
  app.exit(2)
})
process.on('unhandledRejection', (error) => {
  console.log('[probe] unhandled', error)
  app.exit(3)
})

// Before `whenReady`, and exactly once — the same rule the app follows.
registerPrivilegedSchemes()
console.log('[probe] schemes registered')

const ROOT = 'C:\\Users\\Ryan\\.craft-agent\\workspaces\\my-workspace'
const BENCH = join(ROOT, 'sessions', '261102-rapid-diamond', 'data', 'bench')

const CASES: Array<{ format: string; path: string }> = [
  { format: 'docx', path: join(BENCH, 'long.docx') },
  { format: 'docx', path: join(BENCH, 'brief.docx') },
  { format: 'xlsx', path: join(BENCH, 'sheet.xlsx') },
  { format: 'pptx', path: join(BENCH, 'deck.pptx') },
  { format: 'pdf', path: join(ROOT, 'sessions', '261101-ready-comet', 'data', 'hubtest', 'self-deck.pdf') },
  { format: 'drawio', path: join(ROOT, 'sessions', '260927-pure-bear', 'diagrams', 'demo.drawio') },
  { format: 'html', path: join(ROOT, 'sessions', '261008-fluid-otter', 'data', 'piece-title.html') },
  { format: 'md', path: join(BENCH, 'brief.md') },
]

// A root of its own, so the probe's posters sit beside the app's instead of over them (the folder
// is keyed by this path). Changing `userData` before ready stops the app from ever becoming ready.
const PROBE_ROOT = mkdtempSync(join(tmpdir(), 'capture-probe-root-'))

// A hidden capture window being destroyed is the last window closing, and Electron answers that
// by quitting — which would end the probe after its first poster.
app.on('window-all-closed', () => {})

// The capture windows are invisible, so a page that fails to load its own assets fails silently.
// This is the only way to hear it.
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', (...args: unknown[]) => {
    const message = args.find((value) => typeof value === 'string' && value.length > 0)
    if (typeof message === 'string' && !message.includes('Autofill')) console.log('  [console]', message.slice(0, 200))
  })
  contents.on('did-fail-load', (_e, code, description, url) => {
    console.log('  [fail-load]', code, description, String(url).slice(0, 120))
  })
})

app
  .whenReady()
  .then(async () => {
    // The app installs the `craft-local` router at startup; the engine document needs it.
    registerLocalOriginHandler(session.defaultSession)
    console.log(`[probe] ready, writing under ${PROBE_ROOT}`)
    const thumbnailer = createCreationThumbnailer((message) => console.log(`  ${message}`))

    for (const item of CASES) {
      let size: { mtimeMs: number; size: number }
      try {
        const stat = statSync(item.path)
        size = { mtimeMs: stat.mtimeMs, size: stat.size }
      } catch {
        console.log(`${item.format.padEnd(6)} MISSING  ${item.path}`)
        continue
      }

      const started = Date.now()
      const file = await thumbnailer.ensure({
        workspaceRootPath: PROBE_ROOT,
        path: item.path,
        format: item.format,
        mtimeMs: size.mtimeMs,
        bytes: size.size,
      })
      const ms = Date.now() - started
      const name = item.path.split(/[\\/]/).pop()
      console.log(
        file
          ? `${item.format.padEnd(6)} OK   ${String(ms).padStart(5)} ms  ${String(statSync(file).size).padStart(6)} B  ${name}`
          : `${item.format.padEnd(6)} NULL ${String(ms).padStart(5)} ms                  ${name}`,
      )
    }

    console.log(`posters in ${join(app.getPath('userData'), 'creation-thumbs')} (look for the newest folder)`)

    // A picture that already exists must be a file read, not a job in a lane: measured, a millisecond
    // or two even right after captures filled both lanes.
    const first = CASES[0]!
    const cached = statSync(first.path)
    const startedAgain = Date.now()
    const again = await thumbnailer.ensure({
      workspaceRootPath: PROBE_ROOT,
      path: first.path,
      format: first.format,
      mtimeMs: cached.mtimeMs,
      bytes: cached.size,
    })
    console.log(`cache hit: ${again ? 'yes' : 'no'} · ${Date.now() - startedAgain} ms`)
    app.exit(0)
  })
  .catch((error: unknown) => {
    console.error('probe failed:', error)
    app.exit(1)
  })
