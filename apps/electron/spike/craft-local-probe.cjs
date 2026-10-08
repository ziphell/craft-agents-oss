/**
 * What does serving a design over `craft-local://` actually buy?
 *
 * Run: node_modules/electron/dist/electron.exe apps/electron/spike/craft-local-probe.cjs
 *
 * The scheme is registered with EXACTLY the privileges the app registers for it
 * (`apps/electron/src/main/thumbnail-protocol.ts`: standard, secure,
 * supportFetchAPI, corsEnabled, stream), and the folder is served the way the
 * app would serve a design folder. Then, for each shape a design is rendered in
 * (top level, opaque-origin iframe, same-origin iframe), it measures what the
 * design-doc plan says must be measured rather than assumed:
 *
 *   - do relative subresources resolve (css / module script / image)?
 *   - can it `fetch()` a sibling file?  a remote URL?
 *   - does `localStorage` work?
 *   - does an ANCHOR navigate (the thing a `srcDoc` document refuses)?
 *   - does the fragment survive a reload?
 *   - can the host still read the frame's DOM (it must not), and can CDP?
 */
const { app, protocol, BrowserWindow } = require('electron')
const { mkdtempSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')

const SCHEME = 'craft-local'
const LABEL = 'probe'

console.log("corsEnabled:", process.env.CRAFT_PROBE_CORS !== "0")
protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: process.env.CRAFT_PROBE_CORS !== "0", stream: true },
  },
])

// ---------------------------------------------------------------------------
// A design folder, served the way the app would serve one.
// ---------------------------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), 'craft-local-probe-'))
writeFileSync(join(dir, 'styles.css'), 'body { background: rgb(1, 2, 3) }\n')
writeFileSync(join(dir, 'app.js'), 'window.__moduleRan = true\n')
writeFileSync(join(dir, 'data.json'), JSON.stringify({ ok: true }))
writeFileSync(
  join(dir, 'pic.svg'),
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="16"><rect width="24" height="16" fill="#f00"/></svg>\n',
)

const PROBE = `
window.__probe = (async function () {
  var out = {}
  out.css = getComputedStyle(document.body).backgroundColor === 'rgb(1, 2, 3)'
  // A module script is deferred: it runs after parsing, so this has to wait for
  // it rather than read a flag that has not been set yet.
  await new Promise(function (r) { setTimeout(r, 120) })
  out.module = window.__moduleRan === true
  out.image = (document.getElementById('pic') || {}).naturalWidth > 0
  try { out.localStorage = (localStorage.setItem('k', '1'), localStorage.getItem('k') === '1' ? 'works' : 'odd') }
  catch (e) { out.localStorage = 'blocked: ' + String(e.message).slice(0, 60) }
  try { out.fetchSibling = (await fetch('data.json')).ok ? 'ok' : 'not-ok' }
  catch (e) { out.fetchSibling = 'blocked: ' + e.message }
  try { out.fetchRemote = (await fetch('https://example.com/')).ok ? 'ok' : 'not-ok' }
  catch (e) { out.fetchRemote = 'blocked: ' + e.message }
  return out
})()
window.__probe.then(function (out) { out.hash = location.hash; parent.postMessage({ probe: out }, '*') })
`

const INNER = `<!doctype html>
<html><head><meta charset="utf-8"><title>craft-local inner</title>
<link rel="stylesheet" href="styles.css">
</head><body>
<a id="go" href="#two">GO TWO</a>
<div id="two">two</div>
<img id="pic" src="pic.svg" alt="">
<script type="module" src="app.js"></script>
<script>${PROBE}</script>
</body></html>`

writeFileSync(join(dir, 'index.html'), INNER)

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
}

/** The fence the app uses: a relative path inside the folder, or nothing. */
function resolveInside(relativePath) {
  const clean = decodeURIComponent(relativePath).replace(/^\/+/, '')
  if (clean.includes('\0') || clean.includes('..')) return null
  return join(dir, clean)
}

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>craft-local host page</title></head>
<body style="margin:0">
<pre id="log" style="position:fixed;right:0;top:0;padding:8px;background:#fff;font:11px ui-monospace;z-index:9;max-width:520px;white-space:pre-wrap">(no messages)</pre>
<iframe id="opaque" sandbox="allow-scripts allow-forms" style="position:absolute;left:0;top:0;width:520px;height:420px;border:1px solid #999"></iframe>
<iframe id="same" sandbox="allow-scripts allow-forms allow-same-origin" style="position:absolute;left:530px;top:0;width:520px;height:420px;border:1px solid #999"></iframe>
<script>
  window.__probe = window.__probe || []
  addEventListener('message', function (e) {
    if (e.data && e.data.probe) { window.__probe.push(e.data.probe); document.getElementById('log').textContent = JSON.stringify(window.__probe, null, 1) }
  })
  document.getElementById('opaque').src = '__SCHEME__://__LABEL__/index.html'
  document.getElementById('same').src = '__SCHEME__://__LABEL__/index.html'
</script>
</body></html>`
writeFileSync(join(dir, 'host.html'), PAGE.replace(/__SCHEME__/g, SCHEME).replace(/__LABEL__/g, LABEL))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url)
    if (url.hostname !== LABEL) return new Response('not found', { status: 404 })
    const file = resolveInside(url.pathname)
    if (!file) return new Response('refused', { status: 403 })
    try {
      const { readFileSync } = require('node:fs')
      return new Response(readFileSync(file), {
        headers: { 'content-type': CONTENT_TYPES[require('node:path').extname(file).toLowerCase()] ?? 'application/octet-stream' },
      })
    } catch {
      return new Response('not found', { status: 404 })
    }
  })

  const win = new BrowserWindow({ show: false, width: 1100, height: 760 })
  const dbg = win.webContents.debugger
  dbg.attach('1.3')
  const send = (method, params, sessionId) => dbg.sendCommand(method, params, sessionId)

  // ---- 1. the design as a TOP-LEVEL page (a real address) -------------------
  await win.loadURL(`${SCHEME}://${LABEL}/index.html`)
  await sleep(800)
  const top = JSON.parse(await win.webContents.executeJavaScript('window.__probe.then(o => JSON.stringify(o))'))
  console.log('1) top-level page:', JSON.stringify(top))

  // an ANCHOR click, dispatched for real (CDP) — the thing a srcDoc document refuses
  const rect = JSON.parse(
    await win.webContents.executeJavaScript(
      "JSON.stringify((function(){var r=document.getElementById('go').getBoundingClientRect();return [Math.round(r.left+r.width/2), Math.round(r.top+r.height/2)]})())",
    ),
  )
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect[0], y: rect[1], button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect[0], y: rect[1], button: 'left', buttons: 0, clickCount: 1 })
  await sleep(200)
  console.log('2) anchor click on a craft-local page → location.hash =', JSON.stringify(await win.webContents.executeJavaScript('location.hash')))

  // ---- 2. the fragment across a reload -------------------------------------
  win.webContents.reload()
  await sleep(900)
  console.log('3) after reload → location.hash =', JSON.stringify(await win.webContents.executeJavaScript('location.hash')))

  // ---- 3. the design in frames (the two sandboxes the app uses) -------------
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE))
  await sleep(1200)
  const frames = JSON.parse(await win.webContents.executeJavaScript('JSON.stringify(window.__probe)'))
  frames.forEach((f, i) => console.log(`4.${i + 1}) iframe:`, JSON.stringify(f)))

  // ---- 4. can the host read the frame's DOM? (it must not) -----------------
  const readable = await win.webContents.executeJavaScript(
    "JSON.stringify(['opaque','same'].map(function(id){var d=document.getElementById(id).contentDocument;return d ? 'READABLE' : 'null'}))",
  )
  console.log('5) host reading the frames\' DOM:', readable)

  // ---- 5. can CDP read inside? (what an agent would use) ------------------
  const { targetInfos } = await send('Target.getTargets')
  const iframes = targetInfos.filter((t) => t.type === 'iframe')
  console.log('6) iframe targets:', iframes.map((t) => `${String(t.url).slice(0, 34)}`).join(' | ') || '(none: same-process frames have no target)')
  for (const t of iframes) {
    try {
      const { sessionId } = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true })
      const title = await send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, sessionId)
      console.log('   CDP inside', String(t.url).slice(0, 30), '→', JSON.stringify(title.result.value))
    } catch (e) {
      console.log('   CDP attach failed:', e.message)
    }
  }

  // ---- 6. the same frames, but hosted by a craft-local page (not a data: one)
  //         — this separates "the scheme blocks it" from "it is third-party".
  await win.loadURL(`${SCHEME}://${LABEL}/host.html`)
  await sleep(1200)
  const hosted = JSON.parse(await win.webContents.executeJavaScript('JSON.stringify(window.__probe)'))
  hosted.forEach((f, i) => console.log(`7.${i + 1}) craft-local parent, iframe:`, JSON.stringify(f)))

  // ---- 6. which parents may embed a craft-local frame at all? -------------
  //         (The app renders designs inside its own page, so this decides
  //         whether the preview surface can move to craft-local.)
  const FRAME_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>parent</title></head><body style="margin:0">
<iframe id="plain" style="position:absolute;left:0;top:0;width:300px;height:200px;border:0"></iframe>
<iframe id="noSame" sandbox="allow-scripts allow-forms" style="position:absolute;left:310px;top:0;width:300px;height:200px;border:0"></iframe>
<iframe id="withSame" sandbox="allow-scripts allow-forms allow-same-origin" style="position:absolute;left:0;top:210px;width:300px;height:200px;border:0"></iframe>
<script>
  window.__report = { parentOrigin: location.origin || location.protocol, loaded: {}, fetch: 'not tried' }
  addEventListener('message', function (e) {
    if (e.data && e.data.from) { window.__report.loaded[e.data.from] = true }
  })
  ;[['plain', null], ['noSame', 'allow-scripts allow-forms'], ['withSame', 'allow-scripts allow-forms allow-same-origin']].forEach(function (pair) {
    var el = document.getElementById(pair[0])
    el.src = 'craft-local://probe/hello.html?from=' + pair[0]
  })
  fetch('craft-local://probe/data.json').then(function (r) { window.__report.fetch = r.status }).catch(function (e) { window.__report.fetch = 'blocked: ' + String(e.message).slice(0, 40) })
</script>
</body></html>`
  writeFileSync(
    join(dir, 'hello.html'),
    `<!doctype html><meta charset="utf-8"><title>hello</title><body>hello
<script>parent.postMessage({ from: new URLSearchParams(location.search).get('from') || 'unknown' }, '*')</script>`,
  )
  writeFileSync(join(dir, 'frame-parent.html'), FRAME_PAGE)

  const http = require('node:http')
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(FRAME_PAGE)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port

  const parents = [
    ['data:', 'data:text/html;charset=utf-8,' + encodeURIComponent(FRAME_PAGE)],
    ['file:', 'file:///' + join(dir, 'frame-parent.html').replace(/\\/g, '/')],
    ['craft-local:', `${SCHEME}://${LABEL}/frame-parent.html`],
    ['http://127.0.0.1', `http://127.0.0.1:${port}/`],
  ]
  console.log('8) which parents may embed a craft-local frame, and in which sandbox?')
  console.log('   (plain = no sandbox attribute, noSame = opaque sandbox, withSame = + allow-same-origin)')
  for (const [name, url] of parents) {
    try {
      await win.loadURL(url)
      await sleep(1100)
      const report = JSON.parse(await win.webContents.executeJavaScript('JSON.stringify(window.__report)'))
      const readable = JSON.parse(
        await win.webContents.executeJavaScript(
          "JSON.stringify(['plain','noSame','withSame'].map(function(id){return document.getElementById(id).contentDocument ? 'READABLE' : 'null'}))",
        ),
      )
      const loaded = ['plain', 'noSame', 'withSame'].map((k) => (report.loaded[k] ? 'yes' : 'NO')).join('/')
      console.log(`   ${name.padEnd(15)} loaded(plain/noSame/withSame)=${loaded}  hostCanReadFrameDom=${readable.join(',')}  fetchFromParent=${report.fetch}`)
    } catch (error) {
      console.log(`   ${name.padEnd(15)} parent failed to load: ${error.message}`)
    }
  }
  server.close()

  // ---- 9. is a different SESSION (the browser pane's partition) shut out? --
  //         Protocol handlers are per-session, so this is the real gate on the
  //         readable face — not the scheme privileges.
  const other = new BrowserWindow({
    show: false,
    width: 900,
    height: 600,
    webPreferences: { partition: 'persist:craft-probe-other' },
  })
  await other.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(FRAME_PAGE))
  await sleep(1100)
  const otherReport = JSON.parse(await other.webContents.executeJavaScript('JSON.stringify(window.__report)'))
  const loadedInOther = ['plain', 'noSame', 'withSame'].map((k) => (otherReport.loaded[k] ? 'yes' : 'NO')).join('/')
  console.log('9) a different session partition:')
  console.log(`   loaded(plain/noSame/withSame)=${loadedInOther}  fetchFromParent=${otherReport.fetch}`)

  // ---- 4. an ANCHOR inside a sandboxed frame at a craft-local address ---------
  //         (the app's shape: the frame is sandboxed, the document has a real URL)
  const FRAMED = `<!doctype html>
<html><head><meta charset="utf-8"><title>anchor in frame</title>
<style>#two{display:none}#two:target{display:block}</style></head><body>
<a id="go" href="#two" style="display:inline-block;padding:10px 20px;border:1px solid">GO TWO</a>
<div id="two">two</div>
<script>
  var say = function (m) { parent.postMessage({ probe: m }, '*') }
  addEventListener('hashchange', function () { say({ event: 'hashchange', hash: location.hash, target: (document.querySelector(':target') || {}).id || null }) })
  window.addEventListener('load', function () { say({ event: 'loaded' }) })
</script></body></html>`
  writeFileSync(join(dir, 'anchor.html'), FRAMED)
  const anchorHost = `<!doctype html>
<html><head><meta charset="utf-8"><title>anchor host</title></head><body style="margin:0">
<iframe id="f" sandbox="allow-scripts allow-forms" style="width:600px;height:300px;border:0" src="${SCHEME}://${LABEL}/anchor.html"></iframe>
<script>
  window.__probe = []
  addEventListener('message', function (e) { if (e.data && e.data.probe) window.__probe.push(e.data.probe) })
</script></body></html>`
  writeFileSync(join(dir, 'anchor-host.html'), anchorHost)

  await win.loadURL(`${SCHEME}://${LABEL}/anchor-host.html`)
  await sleep(800)
  // A real click, through CDP, at the anchor (the page reports its own clicks).
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 60, y: 30, button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 60, y: 30, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(300)
  console.log('10) anchor in a SANDBOXED frame at a craft-local address:', JSON.stringify(await win.webContents.executeJavaScript('JSON.stringify(window.__probe)')))

  app.quit()
})
