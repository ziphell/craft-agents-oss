/**
 * Can a hidden window capture pixels beyond its viewport?
 *
 * The app captures every shot from a window that is not on screen (that is what makes "shoot a
 * background tab" possible), and there `captureBeyondViewport` came back as page background with
 * `fromSurface: true` and all black with `fromSurface: false`. This probes the four combinations on
 * one page, including the one that might actually work: an `Emulation.setDeviceMetricsOverride` to
 * the size being captured, then a plain capture.
 *
 * It samples pixels rather than trusting the image dimensions: a clip of the right size is not
 * evidence that anything was painted there.
 *
 * Run: electron spike/cdp-beyond-viewport.cjs          (from apps/electron)
 */
const { app, BrowserWindow, nativeImage } = require('electron')
const { writeFileSync } = require('node:fs')

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; background: #fff; font: 12px ui-monospace, monospace }
  #grid { display: grid; grid-template-columns: repeat(20, 80px); grid-auto-rows: 80px; width: 1600px }
  #grid div { background: #4f46e5; border: 1px solid #fff; color: #fff; display: grid; place-items: center }
  #marker { position: fixed; right: 0; bottom: 0; background: #111; color: #fff; padding: 3px 6px }
</style></head><body>
<div id="grid">${Array.from({ length: 20 * 13 }, (_, i) => `<div>${i}</div>`).join('')}</div>
<div id="marker"></div>
<script>
  var m = document.getElementById('marker')
  function draw() {
    m.textContent = innerWidth + 'x' + innerHeight + ' doc:' +
      document.documentElement.scrollWidth + 'x' + document.documentElement.scrollHeight
  }
  draw()
  addEventListener('resize', draw)
</script></body></html>`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const win = new BrowserWindow({
    show: false, // the same situation as the app's captures: a window nobody can see
    width: 400,
    height: 300,
    useContentSize: true,
    webPreferences: { sandbox: false, contextIsolation: true },
  })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE))
  await sleep(500)

  const dbg = win.webContents.debugger
  dbg.attach('1.3')
  const out = {}

  const sample = (img, x, y) => {
    const size = img.getSize()
    const bmp = img.toBitmap() // BGRA
    const i = (y * size.width + x) * 4
    return [bmp[i + 2], bmp[i + 1], bmp[i]] // rgb
  }

  const shot = async (label, { override, fromSurface }) => {
    if (override) {
      await dbg.sendCommand('Emulation.setDeviceMetricsOverride', {
        width: 1600,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      })
      await sleep(350)
    }
    const before = await win.webContents.executeJavaScript('document.getElementById("marker").textContent')
    const res = await dbg.sendCommand('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 0, y: 0, width: 1600, height: 1000, scale: 1 },
      captureBeyondViewport: true,
      fromSurface,
    })
    const img = nativeImage.createFromBuffer(Buffer.from(res.data, 'base64'))
    const size = img.getSize()
    // x=10 is inside the original 400-wide viewport; the rest is beyond it.
    out[label] = {
      imageSize: [size.width, size.height],
      markerWhileCapturing: before,
      sampleInsideViewport: sample(img, 10, 40),
      sampleBeyondViewport: sample(img, 1200, 40),
      sampleFarRight: sample(img, 1500, 900),
      looksPaintedBeyond: sample(img, 1200, 40).join(',') !== '255,255,255' && sample(img, 1200, 40).join(',') !== '0,0,0',
    }
    if (override) {
      await dbg.sendCommand('Emulation.clearDeviceMetricsOverride')
      await sleep(250)
    }
  }

  try {
    await shot('fromSurface_true__no_override', { override: false, fromSurface: true })
    await shot('fromSurface_true__with_override', { override: true, fromSurface: true })
    await shot('fromSurface_false__with_override', { override: true, fromSurface: false })
    await shot('fromSurface_false__no_override', { override: false, fromSurface: false })
  } catch (error) {
    out.error = String((error && error.message) || error)
  }

  console.log(JSON.stringify(out, null, 2))
  writeFileSync(process.argv[2] || 'spike-beyond-viewport.json', JSON.stringify(out, null, 2))
  app.quit()
}

app.whenReady().then(main)
