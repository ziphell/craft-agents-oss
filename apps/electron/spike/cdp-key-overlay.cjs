/** Tab view + an overlay view on top that holds the focus — the app's "held tab" shape. */
const { app, BrowserWindow, WebContentsView } = require('electron')
const PAGE = 'data:text/html;charset=utf-8,' + encodeURIComponent(
  '<!doctype html><meta charset="utf-8"><title>tab</title><body><input id="f" autofocus><script>' +
  'window.__k=[];addEventListener("keydown",function(e){window.__k.push(e.key+":"+e.keyCode)},true);</script>')
const ARROW = { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 }

app.whenReady().then(async () => {
  const person = new BrowserWindow({ show: true, width: 600, height: 300 })
  await person.loadURL('data:text/html,<h1>person</h1>')

  const host = new BrowserWindow({ show: false, width: 900, height: 600 })
  const tab = new WebContentsView()
  host.contentView.addChildView(tab)
  tab.setBounds({ x: 0, y: 0, width: 900, height: 600 })
  await tab.webContents.loadURL(PAGE)

  // The window's overlay view, on top — exactly what covers a held tab.
  const overlay = new WebContentsView()
  host.contentView.addChildView(overlay)
  overlay.setBounds({ x: 0, y: 0, width: 900, height: 600 })
  await overlay.webContents.loadURL('data:text/html,<body tabindex="-1"><b>agent control overlay</b><script>document.body.focus()</script>')

  person.focus()
  await new Promise(r => setTimeout(r, 400))

  const dbg = tab.webContents.debugger
  dbg.attach('1.3')
  const send = (m, p) => dbg.sendCommand(m, p)
  const read = async e => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result.value

  async function tryPayload(label, down, up) {
    await send('Runtime.evaluate', { expression: 'window.__k=[]' })
    await send('Input.dispatchKeyEvent', down); await send('Input.dispatchKeyEvent', up)
    console.log(label, '->', await read('JSON.stringify(window.__k)'))
  }

  console.log('tab wc focused:', tab.webContents.isFocused(), '| overlay wc focused:', overlay.webContents.isFocused())
  console.log('hasFocus:', await read('document.hasFocus()'), 'visibility:', await read('document.visibilityState'))
  await tryPayload('rawKeyDown + key/code/vk', { type: 'rawKeyDown', ...ARROW }, { type: 'keyUp', ...ARROW })
  await tryPayload('keyDown    + key/code/vk', { type: 'keyDown', ...ARROW }, { type: 'keyUp', ...ARROW })
  await tryPayload('keyDown    + text "-"  ', { type: 'keyDown', text: '-' }, { type: 'keyUp', text: '-' })

  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  console.log('\nwith focus emulation → hasFocus:', await read('document.hasFocus()'))
  await tryPayload('rawKeyDown + key/code/vk', { type: 'rawKeyDown', ...ARROW }, { type: 'keyUp', ...ARROW })
  await tryPayload('keyDown    + text "-"  ', { type: 'keyDown', text: '-' }, { type: 'keyUp', text: '-' })

  console.log('\nfocused webContents:', require('electron').webContents.getFocusedWebContents() === tab.webContents ? 'the tab' : 'something else')
  app.quit()
})
