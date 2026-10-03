/**
 * Sampler-window spike — temporary, not part of the app.
 *
 * Question: **does the sampler actually do what the options say?** The command-layer tests stub
 * `sampleVideo`, so nothing else exercises `sampleVideoFrames` — and it is where the frame-collection
 * rules live (the window, the two ends, the scale, and what `changes` compares against).
 *
 * It runs the real function (bundled here, not copied) against a real recording: one the encoder
 * spike left behind, or any file passed as argv[2].
 *
 *   node_modules/electron/dist/electron.exe apps/electron/spike/sampler-window.cjs [file.mp4]
 *
 * Switches, for measuring rather than eyeballing:
 *
 * - `SPIKE_THRESHOLDS=0.05,0.1` — run `changes` at these thresholds.
 * - `SPIKE_PROBE=1` (with `SPIKE_PROBE_STEP`, `SPIKE_PROBE_SIZE`) — print the per-sample ratios,
 *   computed by a copy of the metric.
 * - `SPIKE_SPY=1` — print the ratios the sampler itself computes. When the two disagree, this is
 *   the one to believe: a copy is only as good as the thing it was checked against.
 * - `SPIKE_SOURCE=<file.ts>` — bundle a different copy of the module, so a change to a rule can be
 *   measured against the rule it replaced rather than against nothing.
 *
 * The drift recording the `changes` rule exists for comes from the encoder spike:
 *
 *   SPIKE_SUBJECT=drift SPIKE_RECORD_MS=12000 \
 *     node_modules/electron/dist/electron.exe apps/electron/spike/encoder-window.cjs
 */
const { spawnSync } = require('node:child_process')
const { mkdtempSync, readdirSync, existsSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')
const { app, BrowserWindow } = require('electron')

const WATCHDOG_MS = 120_000

/** The recording the encoder spike wrote, if it is still there. */
function findRecording() {
  if (process.argv[2]) return process.argv[2]
  const root = tmpdir()
  for (const name of readdirSync(root)) {
    if (!name.startsWith('craft-encoder-spike-')) continue
    for (const file of readdirSync(join(root, name))) {
      if (file.endsWith('.mp4') || file.endsWith('.webm')) return join(root, name, file)
    }
  }
  return null
}

app.whenReady().then(async () => {
  setTimeout(() => { console.log('SPIKE_WATCHDOG'); app.exit(3) }, WATCHDOG_MS)

  // Electron says which process died and why. Without this a native crash is just "no output",
  // and "no output" is indistinguishable from "still working" or "exited early".
  app.on('render-process-gone', (_event, _contents, details) => {
    console.log('SPIKE_RENDER_GONE ' + JSON.stringify(details))
  })
  app.on('child-process-gone', (_event, details) => {
    console.log('SPIKE_CHILD_GONE ' + JSON.stringify(details))
  })
  process.on('uncaughtException', (error) => {
    console.log('SPIKE_UNCAUGHT ' + (error && error.stack ? error.stack : String(error)))
  })

  // Without this the spike cannot run twice. `sampleVideoFrames` destroys its window when it is
  // done, and Electron's default answer to "the last window closed" is to quit — so the first
  // run's window closing ends the process, mid-report, with a success code. The encoder spike
  // never noticed because it holds its windows until the very end.
  app.on('window-all-closed', () => {})

  const file = findRecording()
  if (!file || !existsSync(file)) {
    console.log('SPIKE_ERROR no recording to sample. Pass one: ... sampler-window.cjs <file>')
    app.exit(1)
    return
  }
  console.log(`SPIKE_FILE ${file}`)

  const work = mkdtempSync(join(tmpdir(), 'craft-sampler-spike-'))
  const bundled = join(work, 'video-frames.cjs')
  // Pointable at another copy of the module so the same script can measure a change to the rule
  // against the version it replaced, rather than against nothing.
  const source = process.env.SPIKE_SOURCE || 'apps/electron/src/main/video-frames.ts'
  console.log(`SPIKE_SOURCE ${source}`)
  const built = spawnSync(
    'bun',
    ['run', 'esbuild', source, '--bundle', '--format=cjs',
      '--platform=node', '--external:electron', `--outfile=${bundled}`],
    { cwd: process.cwd(), stdio: 'inherit', shell: true },
  )
  if (built.status !== 0) {
    console.log('SPIKE_ERROR bundling failed')
    app.exit(1)
    return
  }

  // The ratios the sampler itself computes, taken from the script it actually runs.
  //
  // The probe above is a copy of the metric, and a copy is only worth reading once it has been
  // checked against the shipped code — the first measurement taken here was wrong precisely
  // because the thing it was compared against was not the shipped rule. This is the check: the page
  // script is rewritten on its way through `executeJavaScript` to also return its ratios, and the
  // reply is read back. Production code is untouched. (Subclassing `BrowserWindow` does not work:
  // that export is a read-only getter, and `WebContents` is not exported at all.)
  if (process.env.SPIKE_SPY) {
    const { BrowserWindow } = require('electron')
    // `WebContents` is not exported in the main process; the class that owns the method is found
    // by walking up from a real instance.
    const scout = new BrowserWindow({ show: false })
    let owner = scout.webContents
    while (owner && !Object.getOwnPropertyDescriptor(owner, 'executeJavaScript')) {
      owner = Object.getPrototypeOf(owner)
    }
    if (owner) {
      const original = owner.executeJavaScript
      owner.executeJavaScript = function (code, ...rest) {
        const withRatios = String(code)
          .replace('const frames = []', 'const frames = []\n  const RATIOS = []')
          .replace(
            /const ratio = diff\((\w+), pixels\)/,
            (_match, name) =>
              `const ratio = diff(${name}, pixels); RATIOS.push({ t: Math.round(video.currentTime * 1000), r: Number(ratio.toFixed(4)) })`,
          )
          .replace(
            'return { durationMs, width, height, truncated, frames }',
            'return { durationMs, width, height, truncated, frames, ratios: RATIOS }',
          )
        return original.call(this, withRatios, ...rest).then((reply) => {
          if (reply && reply.ratios) console.log('SPIKE_SPY ' + JSON.stringify(reply.ratios))
          return reply
        })
      }
      console.log('SPIKE_SPY installed=prototype')
    } else {
      console.log('SPIKE_SPY installed=none')
    }
    if (!scout.isDestroyed()) scout.destroy()
  }

  const { sampleVideoFrames } = require(bundled)
  const base = { mode: 'timeline', everyMs: 500, maxFrames: 40 }

  const report = {}
  const run = async (name, options) => {
    // Printed per run, not at the end: if one crashes the process, the last line printed is the
    // only record of how far it got.
    console.log(`SPIKE_RUN ${name} start ` + JSON.stringify(options))
    const started = Date.now()
    try {
      const out = await sampleVideoFrames(file, { ...base, ...options })
      report[name] = {
        frames: out.frames.length,
        durationMs: out.durationMs,
        viewport: out.viewport,
        truncated: out.truncated,
        offsets: out.frames.map((f) => f.offsetMs),
        firstFrameBytes: out.frames[0] ? out.frames[0].bytes.length : 0,
      }
      console.log(`SPIKE_RUN ${name} done ${Date.now() - started}ms ` + JSON.stringify(report[name]))
    } catch (error) {
      report[name] = { error: String(error && error.message ? error.message : error) }
      console.log(`SPIKE_RUN ${name} threw ` + JSON.stringify(report[name]))
    }
  }

  // A recording's per-sample ratios, measured rather than assumed.
  //
  // Whether a threshold is meaningful depends on how far a given recording moves between two
  // samples — a property of that recording. `diff` is not exported (it lives inside the page
  // script), so this is a deliberate copy of the metric: same 64-byte stride, same "fraction of
  // sampled bytes that differ". `vsFirst` is what the sampler's baseline rule thresholds on, so a
  // threshold between the two columns is exactly the drift case the rule exists for.
  if (process.env.SPIKE_PROBE) {
    const step = Number(process.env.SPIKE_PROBE_STEP || 500)
    const probeWindow = new BrowserWindow({
      show: false,
      width: Number(process.env.SPIKE_PROBE_SIZE || 800),
      height: Number(process.env.SPIKE_PROBE_SIZE ? 800 : 600),
      webPreferences: { webSecurity: false, backgroundThrottling: false },
    })
    await probeWindow.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent('<!doctype html><meta charset="utf-8"><body></body>')}`,
    )
    try {
      const probe = await probeWindow.webContents.executeJavaScript(`(async () => {
  const video = document.createElement('video')
  video.muted = true
  video.preload = 'auto'
  video.src = ${JSON.stringify(pathToFileURL(file).toString())}
  await new Promise((resolve, reject) => {
    video.addEventListener('loadedmetadata', resolve, { once: true })
    video.addEventListener('error', () => reject(new Error('the recording did not load')), { once: true })
    setTimeout(() => reject(new Error('the recording did not load in time')), 20000)
  })
  const width = video.videoWidth, height = video.videoHeight
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  const seek = (seconds) => new Promise((resolve) => {
    const done = () => { video.removeEventListener('seeked', done); resolve(true) }
    video.addEventListener('seeked', done)
    video.currentTime = Math.min(seconds, Math.max(0, (video.duration * 1000 - 40) / 1000))
    setTimeout(done, 3000)
  })
  const pixels = []
  const times = []
  for (let t = 0; t <= video.duration * 1000; t += ${step}) {
    await seek(t / 1000)
    context.drawImage(video, 0, 0, width, height)
    times.push(Math.round(video.currentTime * 1000))
    pixels.push(context.getImageData(0, 0, width, height).data)
  }
  const area = (a, b) => {
    let sampled = 0, changed = 0
    for (let k = 0; k < b.length; k += 64) { sampled += 1; if (a[k] !== b[k]) changed += 1 }
    return sampled ? changed / sampled : 0
  }
  return {
    durationMs: Math.round(video.duration * 1000),
    width, height, step: ${step},
    rows: times.map((t, i) => ({
      t,
      vsPrevious: i ? Number(area(pixels[i - 1], pixels[i]).toFixed(4)) : null,
      vsFirst: i ? Number(area(pixels[0], pixels[i]).toFixed(4)) : null,
    })),
  }
})()`)
      console.log('SPIKE_PROBE ' + JSON.stringify(probe))
    } catch (error) {
      console.log('SPIKE_PROBE threw ' + String(error && error.message ? error.message : error))
    }
    if (!probeWindow.isDestroyed()) probeWindow.destroy()
  }

  await run('timeline', {})
  await run('last', { last: true })
  await run('firstAndLast', { first: true, last: true })
  await run('window', { fromMs: 1_000, toMs: 2_000 })
  await run('fromToEnd', { fromMs: 1_000 })
  await run('scaled', { maxEdge: 160 })
  await run('changes', { mode: 'changes' })
  // The threshold is the knob that decides whether a drift is a change. Overridable because how
  // much a given recording moves between two samples is a property of that recording, not
  // something to guess at.
  for (const threshold of (process.env.SPIKE_THRESHOLDS || '0.1').split(',').map(Number)) {
    await run(`changes@${threshold}`, { mode: 'changes', changeThreshold: threshold })
  }

  console.log('SPIKE_JSON ' + JSON.stringify(report, null, 2))
  app.quit()
})
