/**
 * How does a click reach a cross-origin iframe (OOPIF)?
 *
 * Run: node_modules/electron/dist/electron.exe apps/electron/spike/cdp-oopif-click.cjs
 *
 * Measured fact behind this: a click dispatched on the TOP target (or injected
 * with webContents.sendInputEvent) never arrives inside an opaque-origin frame,
 * while it does inside a same-origin one. This compares that baseline with the
 * candidate recipe: find the frame that owns the point, attach to its target,
 * and dispatch the click there in that frame's own coordinates.
 */
const { app, BrowserWindow } = require('electron')

const INNER = (which) => `<!doctype html>
<meta charset="utf-8"><title>inner ${which}</title>
<style>
  body { font: 14px system-ui; margin: 0; padding: 12px }
  a.link { display: inline-block; padding: 14px 26px; border: 1px solid #94a3b8; border-radius: 8px;
           font: 15px system-ui; text-decoration: none; color: #0f172a }
</style>
<a class="link" id="go" href="#two">GO ${which}</a>
<script>
  var say = function (m) { m.which = '${which}'; parent.postMessage({ probe: m }, '*') }
  document.addEventListener('click', function (e) {
    say({ event: 'click', isTrusted: e.isTrusted, tag: e.target.tagName, id: e.target.id || null, client: [e.clientX, e.clientY] })
  }, true)
  window.addEventListener('load', function () {
    var r = document.getElementById('go').getBoundingClientRect()
    say({ event: 'loaded', rect: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)] })
  })
</script>`

const TOP = `<!doctype html>
<meta charset="utf-8"><title>oopif click probe</title>
<body style="margin:0;background:#eef1f6">
<div id="log" style="position:fixed;right:0;top:0;padding:8px;background:#fff;font:12px ui-monospace;z-index:9">(none)</div>
<iframe id="same" sandbox="allow-scripts allow-forms allow-same-origin" style="position:absolute;left:0;top:0;width:600px;height:260px;border:0"></iframe>
<iframe id="opaque" sandbox="allow-scripts allow-forms" style="position:absolute;left:0;top:320px;width:600px;height:260px;border:0"></iframe>
<script>
  window.__hits = [];
  addEventListener('message', function (e) {
    if (e.data && e.data.probe) {
      window.__hits.push(e.data.probe);
      document.getElementById('log').textContent = JSON.stringify(window.__hits);
    }
  });
  document.getElementById('same').srcdoc = ${JSON.stringify(INNER('same')).replace(/<\//g, '<\\/')};
  document.getElementById('opaque').srcdoc = ${JSON.stringify(INNER('opaque')).replace(/<\//g, '<\\/')};
</script>`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 720 })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(TOP))
  await sleep(700)

  const dbg = win.webContents.debugger
  dbg.attach('1.3')
  const send = (method, params, sessionId) => dbg.sendCommand(method, params, sessionId)
  const hits = async () => JSON.parse(await win.webContents.executeJavaScript('JSON.stringify(window.__hits)'))
  const frameOffset = async (id) =>
    JSON.parse(await win.webContents.executeJavaScript(`JSON.stringify((function(){var r=document.getElementById('${id}').getBoundingClientRect();return [Math.round(r.left),Math.round(r.top)]})())`))

  console.log('1) load reports:', JSON.stringify(await hits()))

  // Where the two links are, in page coordinates (each frame's own offset + (71,81)).
  const offSame = await frameOffset('same')
  const offOpaque = await frameOffset('opaque')
  const pSame = { x: offSame[0] + 71, y: offSame[1] + 81 }
  const pOpaque = { x: offOpaque[0] + 71, y: offOpaque[1] + 81 }
  console.log('   page points:', JSON.stringify({ same: pSame, opaque: pOpaque }))

  // What does the TOP session think is at the opaque point?
  try {
    const loc = await send('DOM.getNodeForLocation', { x: pOpaque.x, y: pOpaque.y, includeUserAgentShadowDOM: false })
    console.log('2) DOM.getNodeForLocation over the opaque frame:', JSON.stringify({ frame: String(loc.frameId).slice(0, 8), node: loc.nodeName, backend: loc.backendNodeId }))
  } catch (e) {
    console.log('2) DOM.getNodeForLocation threw:', e.message)
  }

  // Attach to each frame's target (flattened) and learn which is which by title.
  const sessions = {}
  const { targetInfos } = await send('Target.getTargets')
  console.log('3) targets:', targetInfos.map((t) => `${t.type}:${String(t.url).slice(0, 24)}`).join(' | '))
  for (const t of targetInfos) {
    if (t.type !== 'iframe') continue
    try {
      const { sessionId } = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true })
      const title = await send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, sessionId)
      sessions[String(title.result.value)] = sessionId
      console.log('   attached', t.targetId.slice(0, 8), '→', title.result.value)
    } catch (e) {
      console.log('   attach failed:', e.message)
    }
  }

  const clickAt = async (label, sessionId, x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 }, sessionId)
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 1, clickCount: 1 }, sessionId)
    await sleep(120)
    const seen = (await hits()).filter((h) => h.event === 'click' && h.which === label)
    console.log(`   ${label} @(${x},${y}) → clicks seen: ${seen.length}`, seen.length ? JSON.stringify(seen[seen.length - 1]) : '')
  }

  console.log('\n4) BASELINE — dispatch on the TOP session, at page coordinates:')
  await clickAt('same', undefined, pSame.x, pSame.y)
  await clickAt('opaque', undefined, pOpaque.x, pOpaque.y)

  console.log("4b) NATIVE webContents.sendInputEvent - what the app click uses today:")
  const nativeClick = async (label, x, y) => {
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
    await sleep(150)
    const seen = (await hits()).filter((h) => h.event === 'click' && h.which === label)
    console.log(`   ${label} @(${x},${y}) → clicks seen: ${seen.length}`, seen.length ? `isTrusted=${seen[seen.length - 1].isTrusted}` : '')
  }
  await nativeClick('same', pSame.x, pSame.y)
  await nativeClick('opaque', pOpaque.x, pOpaque.y)

  console.log('\n5) CANDIDATE — dispatch on each frame\'s own session, at frame-local coordinates:')
  await clickAt('same', sessions['inner same'], 71, 81)
  await clickAt('opaque', sessions['inner opaque'], 71, 81)

  app.quit()
})
