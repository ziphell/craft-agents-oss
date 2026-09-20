/**
 * Does a page follow a window that *grows*, as well as one that shrinks? — temporary, not part of the app.
 *
 * Reported (用户): 原生窗口从大变小，webcontent 能跟着变小；从小变大，webcontent 就不会跟随.
 * The earlier run of this file only ever shrank its window, so it could not have seen this.
 *
 * Two variants, both measured in the same window, grow and shrink in turn:
 *
 *   bare      one page in a frameless window: the page is the whole content area (no chrome)
 *   app       the app's shapes — 200 rail, 48 bar, 6px gutter, and the overlay BrowserView
 *             covering the whole tab area the way `updateNativeOverlayState` leaves it
 *
 * Run: node_modules/electron/dist/electron.exe apps/electron/spike/resize-follow.cjs   (repo root)
 */
const { app, BrowserWindow, BrowserView, WebContentsView, screen } = require('electron')
const { writeFileSync, appendFileSync } = require('node:fs')
const { join } = require('node:path')

const LOG = join(__dirname, 'resize-follow.log')
const TAB_RAIL = 200
const TOOLBAR = 48
const INSET = 6

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function pageHtml(color) {
  const html = `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;overflow:hidden;background:${color}}</style></head>
<body><script>
  window.__resizes = 0;
  window.__probe = () => ({ innerWidth, innerHeight, visibility: document.visibilityState, resizes: window.__resizes });
  window.addEventListener('resize', () => { window.__resizes += 1; });
</script></body></html>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

const DIM = `data:text/html;charset=utf-8,${encodeURIComponent(
  '<style>html,body{margin:0;height:100%;overflow:hidden;background:rgba(0,0,0,0.15)}</style>',
)}`

/** The app's arithmetic for the tab and page areas, and the bare case's single rectangle. */
function areas(win, kind) {
  const [width, height] = win.getContentSize()
  if (kind === 'bare') return { tabArea: { x: 0, y: 0, width, height }, page: { x: 0, y: 0, width, height } }
  const tabArea = {
    x: TAB_RAIL,
    y: TOOLBAR,
    width: Math.max(200, width - TAB_RAIL),
    height: Math.max(100, height - TOOLBAR),
  }
  return {
    tabArea,
    page: {
      x: tabArea.x + 1,
      y: tabArea.y + 1,
      width: tabArea.width - 1 - INSET,
      height: tabArea.height - 1 - INSET,
    },
  }
}

async function variant(kind) {
  const area = screen.getPrimaryDisplay().workArea
  const win = new BrowserWindow({
    x: area.x + 40,
    y: area.y + 40,
    width: 1000,
    height: 800,
    show: false,
    frame: false,
    opacity: 0.01,
    skipTaskbar: true,
    backgroundColor: '#222222',
  })

  const [throttled, overlayAbove] = kind.split(',')
  const page = new WebContentsView({ webPreferences: { backgroundThrottling: throttled === 'throttled' } })
  await page.webContents.loadURL(pageHtml('#00a000'))
  win.contentView.addChildView(page)

  const overlay = new BrowserView({ webPreferences: { transparent: true } })
  overlay.setBackgroundColor('#00000000')
  await overlay.webContents.loadURL(DIM)
  win.addBrowserView(overlay)

  const layout = () => {
    const a = areas(win, 'app')
    page.setBounds(a.page)
    overlay.setBounds(a.tabArea)
    // The app's two states: the overlay above the page is "the tab on screen is held".
    if (overlayAbove === 'over') win.setTopBrowserView(overlay)
    else { win.contentView.removeChildView(page); win.contentView.addChildView(page) }
  }
  win.on('resize', layout)
  win.on('resized', layout)
  layout()
  win.showInactive()
  await sleep(700)

  const probe = async () => {
    const p = await page.webContents.executeJavaScript('window.__probe()')
    return { w: p.innerWidth, vis: p.visibility, resizes: p.resizes, expected: Math.round(areas(win, 'app').page.width) }
  }

  const steps = []
  steps.push({ step: 'start 1000', ...(await probe()) })
  win.setContentSize(1300, 800)
  await sleep(700)
  steps.push({ step: 'grow → 1300', ...(await probe()) })
  win.setContentSize(1100, 800)
  await sleep(700)
  steps.push({ step: 'shrink → 1100', ...(await probe()) })

  /**
   * A drag, not a jump: what a person does is move the edge, which Windows reports as a stream of
   * sizes a few pixels apart. Programmatic jumps were correct both ways, so the direction the
   * report is about has to be measured the way a drag arrives.
   */
  const burst = async (dir) => {
    const from = 1100
    for (let i = 1; i <= 40; i += 1) {
      win.setContentSize(from + dir * 8 * i, 800)
      await sleep(8)
    }
    await sleep(700)
    return probe()
  }
  steps.push({ step: 'drag shrink → 780', ...(await burst(-1)) })
  steps.push({ step: 'drag grow → 1420', ...(await burst(1)) })

  appendFileSync(LOG, `${JSON.stringify({ kind, steps })}\n`)

  win.destroy()
  await sleep(300)
}

app.on('window-all-closed', () => {})

app.whenReady().then(async () => {
  writeFileSync(LOG, '')
  // The app's shapes as `buildTab` now builds them: covered pages are never throttled.
  await variant('never,over')
  await variant('never,over')
  await variant('throttled,over')
  app.quit()
}).catch((error) => {
  appendFileSync(LOG, `FAILED ${String(error)}\n`)
  app.quit()
})
