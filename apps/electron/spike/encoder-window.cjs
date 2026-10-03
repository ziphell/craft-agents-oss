/**
 * Encoder-window spike — temporary, not part of the app.
 *
 * Question it answers: **does the whole agent-side chain actually produce a playable file?**
 * `capture-hidden-frames.cjs` settled that frames keep coming; `recording-encoder-page.ts` is
 * where they are supposed to become one. This runs the two together, with the *real* page and
 * the *real* preload (bundled here, not re-written), and then reads the file back — a file whose
 * duration a `<video>` can report is a container that was finished properly, which is the part
 * that is easy to get wrong.
 *
 *   subject tab (repaints every frame)
 *     → `Page.startScreencast`              the agent's capture, `browser-cdp.ts`
 *     → `webContents.send` per frame        what `RecordingEncoder.push` does
 *     → the real encoder page + preload     canvas → captureStream(10fps) → MediaRecorder
 *     → chunks appended to one file         what `TabRecorder.appendFor` does
 *   then: read the file back, and report its container, size and duration.
 *
 * Run (from the repo root):
 *   node_modules/electron/dist/electron.exe apps/electron/spike/encoder-window.cjs
 *
 * It bundles two of the app's own modules with esbuild first, so what is measured is the shipped
 * page and the shipped bridge rather than a copy of them.
 */
const { spawnSync } = require('node:child_process')
const { appendFileSync, mkdtempSync, writeFileSync, statSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { app, BrowserWindow } = require('electron')

const ROOT = process.cwd()
const W = 640
const H = 480
const FPS = 10
const RECORD_MS = Number(process.env.SPIKE_RECORD_MS || 3000)
const WATCHDOG_MS = 90_000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const progress = (message) => console.log(`SPIKE_STEP ${new Date().toISOString().slice(11, 23)} ${message}`)

const SUBJECT_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}</style></head>
<body><script>
  let n = 0
  function paint() {
    n += 1
    document.body.style.background = 'hsl(' + (n % 360) + ' 100% 50%)'
    document.body.style.color = '#000'
    document.body.style.font = '48px sans-serif'
    document.body.textContent = String(n)
    requestAnimationFrame(paint)
  }
  requestAnimationFrame(paint)
</script></body></html>`

/**
 * A page that changes a lot over the recording and a little between two samples.
 *
 * This is the shape the `changes` sampler has to cope with and the repaint above cannot show: a
 * slow, self-driven drift — a progress bar, a panel scrolling — where the whole recording differs
 * from one end to the other while any two neighbouring samples are close.
 *
 * Two things about it are deliberate, and the first attempt got both wrong:
 *
 * - **It is a block growing across the frame, not a colour fading.** The comparison counts the
 *   *fraction of sampled bytes that differ*, so a flat colour drifting by one level reads as
 *   "everything changed" — there is nothing for a threshold to separate. Changing the width of a
 *   white block on black changes an area, which is the thing a threshold can be set against.
 * - **The step is twice the sampling interval.** The block advances one sampled column (16px,
 *   the comparison's own stride) every 1000ms while the sampler looks every 500ms, so a sample
 *   lands one step away from the last with room to spare on both sides: 2.5% of the frame per
 *   sample, never a step straddling two samples. Equal cadences alias, and the readings come back
 *   as irregular zeroes and doubles.
 */
const DRIFT_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#000}
  #grow{position:absolute;top:0;left:0;height:100%;width:0;background:#fff}
</style></head>
<body><div id="grow"></div><script>
  const STEP_MS = 1000
  const STEP_PX = 16
  const started = performance.now()
  const grow = document.getElementById('grow')
  setInterval(() => {
    grow.style.width = (Math.floor((performance.now() - started) / STEP_MS) * STEP_PX) + 'px'
  }, 50)
</script></body></html>`

/** Bundle one of the app's own modules so the spike can use the real thing. */
function bundle(entry, outfile) {
  // `shell: true` because on Windows the launcher is `bun.cmd`, which a bare spawn will not find.
  const result = spawnSync(
    'bun',
    ['run', 'esbuild', entry, '--bundle', '--format=cjs', '--platform=node', '--external:electron', `--outfile=${outfile}`],
    { cwd: ROOT, stdio: 'inherit', shell: true },
  )
  if (result.status !== 0) throw new Error(`esbuild failed for ${entry} (status ${result.status})`)
}

app.whenReady().then(async () => {
  setTimeout(() => {
    console.log('SPIKE_WATCHDOG — still running; nothing more came back')
    app.exit(3)
  }, WATCHDOG_MS)

  try {
    const work = mkdtempSync(join(tmpdir(), 'craft-encoder-spike-'))
    // The reader page is a file rather than a `data:` URL, so its origin is one that may load
    // the recording it is about to open.
    writeFileSync(join(work, 'reader.html'), '<!doctype html><meta charset="utf-8"><body></body>')
    progress(`bundling the app's own page and preload into ${work}`)
    bundle('apps/electron/src/main/recording-encoder-page.ts', join(work, 'page.cjs'))
    bundle('apps/electron/src/preload/recording-encoder.ts', join(work, 'preload.cjs'))
    bundle('apps/electron/src/shared/recording-formats.ts', join(work, 'formats.cjs'))

    const { encoderPageHtml } = require(join(work, 'page.cjs'))
    const { RECORDING_FORMATS } = require(join(work, 'formats.cjs'))

    // The subject: a page that repaints, so frames are available to capture.
    const subjectWindow = new BrowserWindow({ width: W, height: H, show: false, frame: false })
    const subject = process.env.SPIKE_SUBJECT === 'drift' ? DRIFT_HTML : SUBJECT_HTML
    progress(`subject: ${process.env.SPIKE_SUBJECT === 'drift' ? 'drift' : 'repaint'}, ${RECORD_MS}ms`)
    await subjectWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(subject)}`)
    subjectWindow.showInactive()
    await sleep(300)

    // The encoder: the real page, the real preload, hidden.
    const encoderWindow = new BrowserWindow({
      show: false,
      width: W,
      height: H,
      webPreferences: {
        preload: join(work, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    })
    await encoderWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(
      encoderPageHtml({ formats: RECORDING_FORMATS, fps: FPS }),
    )}`)

    const format = await encoderWindow.webContents.executeJavaScript('window.__negotiate()')
    progress(`negotiated: ${format ? format.mimeType + ' → .' + format.extension : 'NOTHING'}`)
    if (!format) throw new Error('this build records into no container it knows')

    // Chunks land in one file, the way the recorder's `appendFor` does it.
    const file = join(work, `spike.${format.extension}`)
    writeFileSync(file, '')
    let chunks = 0
    require('electron').ipcMain.on('recording-encoder:chunk', (event, chunk) => {
      if (event.sender.id !== encoderWindow.webContents.id || !chunk) return
      chunks += 1
      appendFileSync(file, Buffer.from(chunk))
    })

    await encoderWindow.webContents.executeJavaScript(
      `window.__start(${JSON.stringify(format.mimeType)}, ${W}, ${H})`,
    )

    // The agent's capture, feeding the encoder exactly as the production wiring will.
    const wc = subjectWindow.webContents
    wc.debugger.attach('1.3')
    let frames = 0
    wc.debugger.on('message', (_event, method, params) => {
      if (method !== 'Page.screencastFrame') return
      frames += 1
      encoderWindow.webContents.send('recording-encoder:frame', { data: params.data, offsetMs: 0 })
      wc.debugger.sendCommand('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {})
    })
    await wc.debugger.sendCommand('Page.startScreencast', { format: 'jpeg', quality: 70, everyNthFrame: 1 })

    progress(`recording for ${RECORD_MS}ms`)
    await sleep(RECORD_MS)

    await wc.debugger.sendCommand('Page.stopScreencast').catch(() => {})
    const stopped = await encoderWindow.webContents.executeJavaScript('window.__stop()')
    // Let the last chunk cross the wire before looking at the file.
    await sleep(600)

    const size = statSync(file).size
    const head = require('node:fs').readFileSync(file).subarray(0, 12)
    const container =
      head.length >= 12 && head.subarray(4, 8).toString('latin1') === 'ftyp' ? 'mp4'
        : head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3 ? 'webm'
          : 'unknown'
    progress(`file: ${size} bytes, container=${container}, chunks=${chunks}, frames=${frames}`)

    // Read it back: a container that was cut short reports no duration.
    //
    // `webSecurity: false` for the same reason `video-frames.ts` sets it: the page reading a
    // `file://` recording has to be allowed to, or the video reports "source not supported"
    // and says nothing about whether the container is any good.
    const reader = new BrowserWindow({ show: false, webPreferences: { webSecurity: false } })
    await reader.loadURL('file://' + join(work, 'reader.html'))
    const readBack = await reader.webContents.executeJavaScript(`(async () => {
      const video = document.createElement('video')
      video.preload = 'metadata'
      video.src = ${JSON.stringify('file://' + file.replace(/\\/g, '/'))}
      const outcome = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ verdict: 'no metadata after 5s' }), 5000)
        video.onloadedmetadata = () => { clearTimeout(timer); resolve({ verdict: 'metadata', duration: video.duration, width: video.videoWidth, height: video.videoHeight }) }
        video.onerror = () => { clearTimeout(timer); resolve({ verdict: 'error: ' + (video.error && video.error.code) }) }
      })
      return outcome
    })()`)
    progress('read back: ' + JSON.stringify(readBack))

    const ok =
      container === format.extension.split('.')[0] ||
      (container === 'mp4' && format.extension === 'mp4') ||
      (container === 'webm' && format.extension === 'webm')

    console.log('SPIKE_JSON ' + JSON.stringify({
      negotiated: format, container, bytes: size, chunks, frames, readBack, ok,
      file,
    }))
    console.log('')
    console.log(`negotiated   ${format.mimeType}  (.${format.extension})`)
    console.log(`container    ${container}${ok ? '' : '   ← MISMATCH with what was negotiated'}`)
    console.log(`bytes        ${size}  in ${chunks} chunk${chunks === 1 ? '' : 's'}, from ${frames} frames`)
    console.log(`read back    ${JSON.stringify(readBack)}`)
    console.log(`file         ${file}`)

    for (const window of [subjectWindow, encoderWindow, reader]) {
      if (!window.isDestroyed()) window.destroy()
    }
    app.quit()
  } catch (error) {
    console.log('SPIKE_ERROR ' + (error && error.stack ? error.stack : String(error)))
    app.exit(1)
  }
})
