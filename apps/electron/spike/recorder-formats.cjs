/**
 * Which containers can this build record — and can we read back what we recorded?
 *
 * Two questions the record button's format raises, and neither can be answered from the
 * docs: what `MediaRecorder` in this Chromium accepts (`isTypeSupported` is the only
 * authority, and it varies by platform and build), and whether the file we produce is one
 * Chromium can **play back and sample** — which is exactly what `sample-video` asks (it
 * loads the file into a hidden `<video>`, reads `video.duration` to work out a sampling
 * step, seeks, and draws to a canvas).
 *
 * That second half is the one worth measuring rather than assuming: a recording straight
 * out of `MediaRecorder` has no known duration until something resolves it, and an
 * unresolved duration is `Infinity` — which as a step size is not a slower sample, it is a
 * different program (`stride = Infinity`). So for every type it claims to support this
 * probe records a second of an animated canvas, writes out the container's first bytes,
 * then loads that blob into a `<video>` and reports: what `duration` says, whether the
 * seek-to-the-end trick resolves it, and whether sampling two different moments actually
 * produces two different pictures.
 *
 * Run: node_modules\electron\dist\electron.exe apps\electron\spike\recorder-formats.cjs
 * Log: apps\electron\spike\recorder-formats.log (NDJSON)
 */
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

const LOG = path.join(__dirname, 'recorder-formats.log')

const CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4;codecs=avc1',
  'video/mp4;codecs=av01.0.04M.08',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm;codecs=h264',
  'video/webm',
  'video/x-matroska;codecs=avc1',
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/webm;codecs=vp9,opus',
  'video/quicktime',
  'video/ogg',
]

const PLAYABLE = ['video/webm', 'video/mp4', 'video/x-matroska', 'video/quicktime', 'video/ogg']

/** Everything the probe answers, run inside the renderer that would do the recording. */
const PROBE = `(async () => {
  const CANDIDATES = ${JSON.stringify(CANDIDATES)}
  const PLAYABLE = ${JSON.stringify(PLAYABLE)}

  const supported = {}
  for (const type of CANDIDATES) supported[type] = MediaRecorder.isTypeSupported(type)

  const canPlay = {}
  for (const type of PLAYABLE) canPlay[type] = document.createElement('video').canPlayType(type) || ''

  const record = async (mimeType) => {
    const canvas = document.createElement('canvas')
    canvas.width = 320
    canvas.height = 240
    const ctx = canvas.getContext('2d')
    let frame = 0
    const draw = () => {
      // A moving block as well as a changing colour: a sampler that always lands on the
      // same frame would otherwise still see "different" pixels.
      ctx.fillStyle = 'hsl(' + ((frame * 17) % 360) + ' 80% 50%)'
      ctx.fillRect(0, 0, 320, 240)
      ctx.fillStyle = 'black'
      ctx.fillRect((frame * 9) % 300, 100, 40, 40)
      frame += 1
    }
    draw()
    const timer = setInterval(draw, 100)

    const stream = canvas.captureStream(10)
    const chunks = []
    const recorder = new MediaRecorder(stream, { mimeType })
    const stopped = new Promise((resolve) => { recorder.onstop = resolve })
    recorder.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data) }
    recorder.start(250)
    await new Promise((resolve) => setTimeout(resolve, 1500))
    recorder.stop()
    await stopped
    clearInterval(timer)

    const blob = new Blob(chunks, { type: mimeType })
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const head = Array.from(bytes.slice(0, 16)).map((b) => b.toString(16).padStart(2, '0')).join(' ')

    const url = URL.createObjectURL(blob)
    const video = document.createElement('video')
    video.muted = true
    const loaded = await new Promise((resolve) => {
      const timeout = setTimeout(() => resolve({ read: 'timeout' }), 8000)
      video.onloadedmetadata = () => { clearTimeout(timeout); resolve({ read: 'metadata' }) }
      video.onerror = () => { clearTimeout(timeout); resolve({ read: 'error', code: video.error && video.error.code }) }
      video.src = url
    })

    if (loaded.read !== 'metadata') {
      URL.revokeObjectURL(url)
      return { bytes: bytes.length, head, load: loaded }
    }

    const asRecorded = String(video.duration)

    // The trick every MediaRecorder consumer knows: seek past the end and the browser has
    // to read the file out to find out how long it really is.
    let resolved = null
    if (!Number.isFinite(video.duration)) {
      await new Promise((resolve) => {
        const settle = () => { clearTimeout(timeout); video.ondurationchange = null; resolve() }
        const timeout = setTimeout(settle, 5000)
        video.ondurationchange = settle
        try { video.currentTime = 1e101 } catch (error) { video.ondurationchange = null; clearTimeout(timeout); resolve() }
      })
      resolved = String(video.duration)
    }

    const canvas2 = document.createElement('canvas')
    canvas2.width = video.videoWidth
    canvas2.height = video.videoHeight
    const ctx2 = canvas2.getContext('2d')
    const shot = async (at) => {
      await new Promise((resolve) => {
        const done = () => { video.removeEventListener('seeked', done); resolve() }
        video.addEventListener('seeked', done)
        video.currentTime = at
        setTimeout(done, 3000)
      })
      ctx2.drawImage(video, 0, 0, canvas2.width, canvas2.height)
      const pixels = ctx2.getImageData(0, 0, canvas2.width, canvas2.height).data
      let sum = 0
      for (let i = 0; i < pixels.length; i += 37) sum = (sum * 31 + pixels[i]) % 1000003
      return { at: Math.round(video.currentTime * 1000), sum }
    }

    const first = await shot(0.1)
    const second = await shot(0.9)
    URL.revokeObjectURL(url)

    return {
      bytes: bytes.length,
      head,
      load: { read: 'metadata', width: video.videoWidth, height: video.videoHeight },
      durationAsRecorded: asRecorded,
      durationAfterSeekToEnd: resolved,
      sampled: { first, second, twoDifferentPictures: first.sum !== second.sum },
    }
  }

  const recordings = {}
  for (const type of CANDIDATES) {
    if (!supported[type]) continue
    try {
      recordings[type] = await record(type)
    } catch (error) {
      recordings[type] = { error: String(error) }
    }
  }

  return { supported, canPlay, recordings }
})()`

app.whenReady().then(async () => {
  const write = (tag, data) => fs.appendFileSync(LOG, `${new Date().toISOString()} ${tag} ${JSON.stringify(data)}\n`)
  write('start', { electron: process.versions.electron, chrome: process.versions.chrome })

  try {
    const window = new BrowserWindow({ show: false, width: 400, height: 300 })
    await window.loadURL('data:text/html;charset=utf-8,<html><body></body></html>')
    write('loaded', {})

    const answer = await window.webContents.executeJavaScript(PROBE, true)
    write('answer', answer)
  } catch (error) {
    write('failed', { error: error && error.stack ? error.stack : String(error) })
  }

  app.exit(0)
})
