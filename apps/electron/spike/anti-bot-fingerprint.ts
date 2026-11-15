/**
 * Spike — 反爬虫视角下，这个内嵌浏览器"看起来像什么"？以及一个后台标签页能不能拿到焦点。
 *
 * 三个问题，各自决定一条改法能不能成立：
 *
 *   A  **UA 与 Client Hints**：页面自己读到的 `navigator.userAgent` / `navigator.userAgentData`，
 *      和服务器收到的请求头（`User-Agent` / `Sec-CH-UA*`）分别是什么？应用今天的清洗
 *      （`replace(/\sElectron\/[^\s]+/g, '')`）之后，还剩哪些非真实 Chrome 的 token？
 *   B  **自动化痕迹**：`navigator.webdriver`、`window.chrome`（有没有 `runtime`）、插件数、
 *      权限（Notification.permission 是否被静默 granted）在页面里是什么样子？
 *   C  **焦点**：一个住在离屏停车窗里的标签页（应用后台自动化用的正是这个），
 *      `document.hasFocus()` / `document.visibilityState` 是什么？
 *      调 `webContents.focus()` 之后能不能变成 `true` —— 代价是不是把人正在用的那个窗口
 *      的焦点抢走（`BrowserWindow.getFocusedWindow()` 会是谁）？
 *
 * 构建 + 运行（仓库根目录）：
 *   bunx esbuild apps/electron/spike/anti-bot-fingerprint.ts --bundle --platform=node --format=cjs \
 *     --external:electron --outfile=apps/electron/spike/anti-bot-fingerprint.cjs
 *   node_modules/electron/dist/electron.exe apps/electron/spike/anti-bot-fingerprint.cjs
 */
import { app, BrowserWindow, WebContentsView, screen } from 'electron'
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Windows 上 Electron 的 stdout 收不回来，读数落盘才拿得到。 */
const REPORT_PATH = process.env.SPIKE_REPORT || join(__dirname, 'anti-bot-fingerprint.report.json')

function writeReport(payload: unknown): void {
  try {
    writeFileSync(REPORT_PATH, JSON.stringify(payload, null, 2), 'utf8')
  } catch (error) {
    writeFileSync(REPORT_PATH.replace(/\.json$/, '.err.txt'), String(error), 'utf8')
  }
}

process.on('uncaughtException', (error) => writeReport({ uncaught: String(error && error.stack ? error.stack : error) }))
process.on('unhandledRejection', (reason) => writeReport({ unhandled: String(reason) }))

// 与应用一致：Chromium 对被完全遮挡的窗口停止出帧。
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

// 与应用一致（`index.ts` 里那句 `app.setName`），产品的名字正是从这里进 UA 的。
app.setName(process.env.CRAFT_APP_NAME || 'Craft Agents')

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;width:100%;height:100%;background:#123;color:#fff;font:14px sans-serif}</style>
</head><body><p id="note">probe</p>
<script>
window.__probe = async function () {
  const out = {
    ua: navigator.userAgent,
    webdriver: typeof navigator.webdriver === 'undefined' ? '(undefined)' : navigator.webdriver,
    webdriverType: typeof navigator.webdriver,
    brands: navigator.userAgentData ? navigator.userAgentData.brands.map((b) => b.brand + '/' + b.version) : null,
    uaDataPlatform: navigator.userAgentData ? navigator.userAgentData.platform : null,
    uaDataMobile: navigator.userAgentData ? navigator.userAgentData.mobile : null,
    fullVersionList: null,
    chromeType: typeof window.chrome,
    chromeKeys: window.chrome ? Object.keys(window.chrome).sort() : null,
    chromeRuntime: typeof (window.chrome && window.chrome.runtime),
    plugins: navigator.plugins.length,
    mimeTypes: navigator.mimeTypes.length,
    pdfViewerEnabled: navigator.pdfViewerEnabled,
    languages: (navigator.languages || []).join(','),
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory === undefined ? '(undefined)' : navigator.deviceMemory,
    notificationPermission: typeof Notification === 'undefined' ? '(no Notification)' : Notification.permission,
    hasFocus: document.hasFocus(),
    visibility: document.visibilityState,
    hidden: document.hidden,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    outerWidth: window.outerWidth,
    outerHeight: window.outerHeight,
    screenX: window.screenX,
    screenY: window.screenY,
    screen: window.screen.width + 'x' + window.screen.height,
    avail: window.screen.availWidth + 'x' + window.screen.availHeight,
    devicePixelRatio: window.devicePixelRatio,
    webglVendor: (function () {
      try {
        const gl = document.createElement('canvas').getContext('webgl')
        if (!gl) return '(no webgl)'
        const ext = gl.getExtension('WEBGL_debug_renderer_info')
        return ext ? String(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL)) : '(no debug ext)'
      } catch (e) { return 'err:' + e.message }
    })(),
    webglRenderer: (function () {
      try {
        const gl = document.createElement('canvas').getContext('webgl')
        if (!gl) return '(no webgl)'
        const ext = gl.getExtension('WEBGL_debug_renderer_info')
        return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '(no debug ext)'
      } catch (e) { return 'err:' + e.message }
    })(),
    permissionsState: null,
  }
  if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
    try {
      const hev = await navigator.userAgentData.getHighEntropyValues(['fullVersionList', 'platform', 'platformVersion', 'architecture', 'bitness', 'model'])
      out.fullVersionList = (hev.fullVersionList || []).map((b) => b.brand + '/' + b.version)
      out.hev = { platform: hev.platform, platformVersion: hev.platformVersion, architecture: hev.architecture, bitness: hev.bitness, model: hev.model }
    } catch (e) { out.fullVersionList = 'err:' + e.message }
  }
  try {
    const st = await navigator.permissions.query({ name: 'notifications' })
    out.permissionsState = st.state
  } catch (e) { out.permissionsState = 'err:' + e.message }
  return out
}
</script></body></html>`

/** 服务器收到的请求头 —— 页面 JS 读不到的那一半指纹。 */
const seenHeaders: Record<string, unknown>[] = []

function startServer(): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      seenHeaders.push({
        path: req.url,
        userAgent: req.headers['user-agent'],
        secChUa: req.headers['sec-ch-ua'],
        secChUaMobile: req.headers['sec-ch-ua-mobile'],
        secChUaPlatform: req.headers['sec-ch-ua-platform'],
        secChUaFullVersionList: req.headers['sec-ch-ua-full-version-list'],
        acceptLanguage: req.headers['accept-language'],
        secFetchSite: req.headers['sec-fetch-site'],
        secFetchMode: req.headers['sec-fetch-mode'],
      })
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(PAGE)
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() })
    })
  })
}

/** 加载一次并等到页面就绪。 */
async function load(wc: Electron.WebContents, url: string): Promise<void> {
  const loaded = new Promise((resolve) => wc.once('did-finish-load', resolve))
  await wc.loadURL(url)
  await loaded
}

async function probe(wc: Electron.WebContents): Promise<Record<string, unknown>> {
  try {
    return (await wc.executeJavaScript('window.__probe()')) as Record<string, unknown>
  } catch (error) {
    return { error: String(error && (error as Error).message ? (error as Error).message : error) }
  }
}

async function main(): Promise<void> {
  const server = await startServer()
  const report: Record<string, unknown> = {}
  writeReport({ phase: 'server-up' })

  const workArea = screen.getPrimaryDisplay().workArea
  const spot = { x: workArea.x + workArea.width + 20_000, y: workArea.y + 20_000 }
  const SIZE = { width: 900, height: 620 }

  // 人正在用的那扇窗口（屏幕上、前台）—— 对照组，也是"最好的情况"。
  const onscreen = new BrowserWindow({
    x: workArea.x + 40, y: workArea.y + 40, ...SIZE, frame: false, show: true, backgroundColor: '#123',
  })
  const tabA = new WebContentsView({ webPreferences: { backgroundThrottling: false } })
  tabA.setBounds({ x: 0, y: 0, ...SIZE })
  onscreen.contentView.addChildView(tabA)
  onscreen.focus()
  await load(tabA.webContents, `${server.url}/baseline`)
  await sleep(500)
  report.onscreenDefaults = { probe: await probe(tabA.webContents), windowIsFocused: onscreen.isFocused() }

  // 应用今天的清洗：只删 `Electron/x.y.z`。
  const rawUa = tabA.webContents.userAgent
  const sanitized = rawUa.replace(/\sElectron\/[^\s]+/g, '')
  tabA.webContents.setUserAgent(sanitized)
  await load(tabA.webContents, `${server.url}/sanitized`)
  await sleep(400)
  report.onscreenSanitizedUa = {
    rawUa,
    sanitized,
    probe: await probe(tabA.webContents),
    windowIsFocused: onscreen.isFocused(),
  }

  // 应用的后台自动化场景：标签页住在离屏停车窗里（shown、never activated）。
  const parking = new BrowserWindow({
    x: spot.x, y: spot.y, ...SIZE, show: false, frame: false, skipTaskbar: true, backgroundColor: '#123',
  })
  const tabB = new WebContentsView({ webPreferences: { backgroundThrottling: false } })
  tabB.setBounds({ x: 0, y: 0, ...SIZE })
  parking.contentView.addChildView(tabB)
  parking.showInactive()
  await load(tabB.webContents, `${server.url}/parked`)
  onscreen.focus()
  await sleep(500)
  report.parked = {
    probe: await probe(tabB.webContents),
    parkingVisible: parking.isVisible(),
    parkingFocused: parking.isFocused(),
    parkingBounds: parking.getBounds(),
    focusedWindow: BrowserWindow.getFocusedWindow() === onscreen ? 'onscreen' : String(BrowserWindow.getFocusedWindow()?.getTitle() ?? 'none'),
    onscreenIsFocused: onscreen.isFocused(),
  }

  // 改法一：向这个标签页要键盘（应用里 `focusTheTabOnScreen` 用的就是这一句）。
  tabB.webContents.focus()
  await sleep(600)
  report.parkedAfterWebContentsFocus = {
    probe: await probe(tabB.webContents),
    parkingFocused: parking.isFocused(),
    onscreenIsFocused: onscreen.isFocused(),
    focusedWindow: BrowserWindow.getFocusedWindow() === onscreen ? 'onscreen' : (BrowserWindow.getFocusedWindow() === parking ? 'parking' : 'other'),
  }

  // 改法二：把停车窗整个激活。
  parking.focus()
  await sleep(600)
  report.parkedAfterWindowFocus = {
    probe: await probe(tabB.webContents),
    parkingFocused: parking.isFocused(),
    onscreenIsFocused: onscreen.isFocused(),
    focusedWindow: BrowserWindow.getFocusedWindow() === onscreen ? 'onscreen' : (BrowserWindow.getFocusedWindow() === parking ? 'parking' : 'other'),
  }

  // 回到对照组，确认读数不是"忘了切回来"。
  onscreen.focus()
  tabA.webContents.focus()
  await sleep(500)
  report.onscreenAgain = {
    probe: await probe(tabA.webContents),
    parked: await probe(tabB.webContents),
    onscreenIsFocused: onscreen.isFocused(),
  }

  // ---- 第二轮：CDP 自己有没有现成的机制？两条都是 Chromium 的原生开关，不是 JS 伪装 ----
  const focusedWindowName = () => {
    const focused = BrowserWindow.getFocusedWindow()
    if (focused === onscreen) return 'onscreen'
    if (focused === parking) return 'parking'
    return focused ? 'other' : 'none'
  }
  const round2: Record<string, unknown> = {}
  const dbg = tabB.webContents.debugger
  round2.attachedBefore = dbg.isAttached()

  // 把前台还给屏幕上那扇窗口 —— 这才是应用里真正的场景（人在别处干活，agent 在后台跑）。
  onscreen.focus()
  tabA.webContents.focus()
  await sleep(400)

  try {
    if (!dbg.isAttached()) dbg.attach('1.3')
    round2.attached = dbg.isAttached()

    // (1) 焦点仿真：页面以为自己在前台，而窗口不动。
    await dbg.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await sleep(600)
    round2.focusEmulationOn = {
      probe: await probe(tabB.webContents),
      parkingFocused: parking.isFocused(),
      onscreenIsFocused: onscreen.isFocused(),
      focusedWindow: focusedWindowName(),
    }

    // (2) UA + Client Hints 一起换：`CraftAgents/x` 只删字符串是删不干净 brands 的。
    const cleanUa = rawUa
      .replace(/\sElectron\/[^\s]+/g, '')
      .replace(/\sCraftAgents\/[^\s]+/g, '')
    const brands = [
      { brand: 'Not_A Brand', version: '99' },
      { brand: 'Chromium', version: '142' },
      { brand: 'Google Chrome', version: '142' },
    ]
    await dbg.sendCommand('Emulation.setUserAgentOverride', {
      userAgent: cleanUa,
      acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8',
      userAgentMetadata: {
        brands,
        fullVersionList: [
          { brand: 'Not_A Brand', version: '99.0.0.0' },
          { brand: 'Chromium', version: '142.0.7444.235' },
          { brand: 'Google Chrome', version: '142.0.7444.235' },
        ],
        fullVersion: '142.0.7444.235',
        platform: 'Windows',
        platformVersion: '19.0.0',
        architecture: 'x86',
        bitness: '64',
        model: '',
        mobile: false,
      },
    })
    await load(tabB.webContents, `${server.url}/cdp-ua-override`)
    await sleep(500)
    round2.uaOverride = { probe: await probe(tabB.webContents), parkingFocused: parking.isFocused() }

    // (3) 调试器断开之后，上面两条还在不在？（应用里的 CDP 会话空闲 5s 会自己断）
    dbg.detach()
    await load(tabB.webContents, `${server.url}/after-detach`)
    await sleep(500)
    round2.afterDetach = {
      probe: await probe(tabB.webContents),
      parkingFocused: parking.isFocused(),
      onscreenIsFocused: onscreen.isFocused(),
      focusedWindow: focusedWindowName(),
    }
  } catch (error) {
    round2.error = String(error && (error as Error).stack ? (error as Error).stack : error)
  }
  report.round2 = round2

  // ---- 第三轮：权限。应用今天的 `setupSessionPermissions` 把 8 类权限直接 `return true`，
  // 而真实 Chrome 里一个从没问过的站点读到的是 `default`。这一轮量"拒绝"能不能拿回 `default`。
  const round3: Record<string, unknown> = {}
  try {
    const ses = tabB.webContents.session
    round3.before = await probe(tabB.webContents)
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    ses.setPermissionCheckHandler(() => false)
    await load(tabB.webContents, `${server.url}/permission-denied`)
    await sleep(500)
    round3.denied = await probe(tabB.webContents)
  } catch (error) {
    round3.error = String(error && (error as Error).stack ? (error as Error).stack : error)
  }
  report.round3 = round3

  // ---- 第四轮：不走 CDP 能做到哪一步？ ----
  // (0) 先说清一个前提：前面"一个 Sec-CH-UA 都没有"是在 http://127.0.0.1 上量的，而 client hints
  //     的头发送是有条件的。这一轮用 HTTPS 的回显服务重新量，分三段：
  //     今天 / 只用 session.setUserAgent / 再自己补 Sec-CH-UA*。
  const round4: Record<string, unknown> = {}
  const HTTPS_ECHOES = ['https://httpbin.org/headers', 'https://tls.peet.ws/api/all']
  const wanted = /^(sec-ch-ua|user-agent|accept-language|sec-fetch)/i

  /** 从回显页面的正文里挑出我们关心的那几行请求头。 */
  const echoHeaders = async (wc: Electron.WebContents): Promise<string[]> => {
    try {
      const text = String(await wc.executeJavaScript('document.body ? document.body.innerText : ""'))
      return text
        .split('\n')
        .map((line) => line.trim().replace(/^"/, '').replace(/",?$/, ''))
        .filter((line) => wanted.test(line))
    } catch (error) {
      return [`error: ${String(error && (error as Error).message ? (error as Error).message : error)}`]
    }
  }

  /** 换一个能通的 HTTPS 回显服务问一次"服务器看到了什么"。加载失败就换下一个，全都失败就记失败。 */
  const httpsEcho = async (wc: Electron.WebContents): Promise<Record<string, unknown>> => {
    let lastError = 'no candidate'
    for (const url of HTTPS_ECHOES) {
      try {
        await load(wc, url)
        await sleep(400)
        return { url, headers: await echoHeaders(wc) }
      } catch (error) {
        lastError = String(error && (error as Error).message ? (error as Error).message : error)
      }
    }
    return { failed: lastError }
  }

  try {
    round4.todayOverHttps = await httpsEcho(tabA.webContents)

    // 只用 Electron 自己的 API：session 级 UA + 语言。不碰 CDP。
    const ses = tabA.webContents.session
    const cleanUa = rawUa.replace(/\sElectron\/[^\s]+/g, '').replace(/\sCraftAgents\/[^\s]+/g, '')
    ses.setUserAgent(cleanUa, 'zh-CN,zh;q=0.9,en;q=0.8')
    await load(tabA.webContents, `${server.url}/session-ua`)
    await sleep(400)
    const afterSessionUa = await probe(tabA.webContents)
    round4.sessionSetUserAgent = {
      ua: afterSessionUa.ua,
      languages: afterSessionUa.languages,
      brands: afterSessionUa.brands,
      fullVersionList: afterSessionUa.fullVersionList,
      localHeaders: seenHeaders.filter((header) => String(header.path) === '/session-ua'),
    }

    // 再自己补 client hints 的请求头（session 级，持久）。
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      const headers = { ...details.requestHeaders }
      headers['Sec-CH-UA'] = '"Not_A Brand";v="99", "Chromium";v="142", "Google Chrome";v="142"'
      headers['Sec-CH-UA-Mobile'] = '?0'
      headers['Sec-CH-UA-Platform'] = '"Windows"'
      headers['Sec-CH-UA-Full-Version-List'] =
        '"Not_A Brand";v="99.0.0.0", "Chromium";v="142.0.7444.235", "Google Chrome";v="142.0.7444.235"'
      callback({ requestHeaders: headers })
    })
    await load(tabA.webContents, `${server.url}/session-ua-plus-headers`)
    await sleep(400)
    round4.ourHeadersOnHttp = seenHeaders.filter((header) => String(header.path) === '/session-ua-plus-headers')
    round4.afterWeAddHeader = await httpsEcho(tabA.webContents)
  } catch (error) {
    round4.error = String(error && (error as Error).stack ? (error as Error).stack : error)
  }
  report.round4 = round4

  // ---- 第五轮：外部 detach 什么时候发生？文档说"devtools 在这个页面被调用"也会断开会话，
  //      这一轮在真机上确认，并且看断开之后还能不能再 attach（两条会话是不是互斥）。----
  const round5: Record<string, unknown> = {}
  try {
    const wc = tabA.webContents
    const dbg = wc.debugger
    let detachEvents = 0
    dbg.on('detach', () => {
      detachEvents++
    })
    dbg.attach('1.3')
    round5.attachedByUs = dbg.isAttached()

    wc.openDevTools({ mode: 'detach' })
    await sleep(1500)
    round5.afterOpeningDevTools = {
      stillAttached: dbg.isAttached(),
      detachEvents,
      devToolsOpen: wc.isDevToolsOpened(),
    }

    let reattachError: string | null = null
    try {
      dbg.attach('1.3')
    } catch (error) {
      reattachError = String(error && (error as Error).message ? (error as Error).message : error)
    }
    await sleep(800)
    round5.afterReattachingWhileDevToolsOpen = {
      attached: dbg.isAttached(),
      reattachError,
      devToolsStillOpen: wc.isDevToolsOpened(),
      detachEvents,
    }
    try {
      wc.closeDevTools()
    } catch { /* the window may already be gone */ }
  } catch (error) {
    round5.error = String(error && (error as Error).stack ? (error as Error).stack : error)
  }
  report.round5 = round5

  report.headers = seenHeaders
  report.electron = { electron: process.versions.electron, chrome: process.versions.chrome, appName: app.getName() }
  report.defaultUserAgent = app.userAgentFallback
  writeReport({ phase: 'done', ...report })

  console.log('SPIKE_JSON ' + JSON.stringify(report, null, 2))
  console.log('\n=== 关键读数 ===')
  const rows: Array<[string, Record<string, unknown> | undefined]> = [
    ['onscreen(default UA)', (report.onscreenDefaults as Record<string, unknown>)?.probe as Record<string, unknown>],
    ['onscreen(sanitized UA)', (report.onscreenSanitizedUa as Record<string, unknown>)?.probe as Record<string, unknown>],
    ['parked', (report.parked as Record<string, unknown>)?.probe as Record<string, unknown>],
    ['parked + wc.focus()', (report.parkedAfterWebContentsFocus as Record<string, unknown>)?.probe as Record<string, unknown>],
    ['parked + win.focus()', (report.parkedAfterWindowFocus as Record<string, unknown>)?.probe as Record<string, unknown>],
    ['onscreen again', (report.onscreenAgain as Record<string, unknown>)?.probe as Record<string, unknown>],
    ['parked + focusEmulation', ((report.round2 as Record<string, unknown>)?.focusEmulationOn as Record<string, unknown>)?.probe as Record<string, unknown>],
    ['parked + CDP UA override', ((report.round2 as Record<string, unknown>)?.uaOverride as Record<string, unknown>)?.probe as Record<string, unknown>],
    ['parked + after detach', ((report.round2 as Record<string, unknown>)?.afterDetach as Record<string, unknown>)?.probe as Record<string, unknown>],
  ]
  const keys = ['hasFocus', 'visibility', 'hidden', 'outerWidth', 'outerHeight', 'screenX', 'screenY', 'webdriver', 'chromeType', 'chromeRuntime', 'plugins', 'notificationPermission', 'permissionsState']
  for (const [label, data] of rows) {
    const picked: Record<string, unknown> = {}
    for (const key of keys) picked[key] = data ? data[key] : undefined
    console.log(label.padEnd(24) + ' ' + JSON.stringify(picked))
  }
  for (const [label, data] of rows) {
    console.log(label.padEnd(24) + '  ua=' + (data ? String(data.ua) : 'n/a'))
    console.log(''.padEnd(24) + '  brands=' + JSON.stringify(data?.brands) + ' full=' + JSON.stringify(data?.fullVersionList))
  }
  console.log('\n=== 请求头 ===')
  for (const header of seenHeaders) {
    console.log(JSON.stringify(header))
  }
  console.log('\n=== 焦点归属 ===')
  console.log('after wc.focus(): ' + JSON.stringify(report.parkedAfterWebContentsFocus))
  console.log('after win.focus(): ' + JSON.stringify(report.parkedAfterWindowFocus))

  server.close()
  for (const win of [onscreen, parking]) if (!win.isDestroyed()) win.destroy()
  app.quit()
}

app.whenReady().then(() => {
  main().catch((error) => {
    console.log('SPIKE_ERROR ' + (error && error.stack ? error.stack : String(error)))
    app.exit(1)
  })
})
