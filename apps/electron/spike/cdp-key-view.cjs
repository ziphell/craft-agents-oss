/** Keys into a WebContentsView (the shape the app's tabs use). */
const { app, BrowserWindow, WebContentsView } = require('electron')
const PAGE = 'data:text/html;charset=utf-8,' + encodeURIComponent(
  '<!doctype html><meta charset="utf-8"><title>k</title><body><input id="f" autofocus><script>' +
  'window.__k=[];addEventListener("keydown",function(e){window.__k.push(e.key+":"+e.keyCode)},true);</script>')
const ARROW = { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 }

app.whenReady().then(async () => {
  const person = new BrowserWindow({ show: true, width: 600, height: 300 })
  await person.loadURL('data:text/html,<h1>person</h1>')

  // A window whose page area is nothing but a view — like a tab pane.
  const host = new BrowserWindow({ show: false, width: 900, height: 600 })
  const view = new WebContentsView()
  host.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 0, width: 900, height: 600 })
  await view.webContents.loadURL(PAGE)
  person.focus()
  await new Promise(r => setTimeout(r, 400))

  const dbg = view.webContents.debugger
  dbg.attach('1.3')
  const send = (m, p) => dbg.sendCommand(m, p)
  const read = async e => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result.value

  async function tryPayload(label, down, up) {
    await send('Runtime.evaluate', { expression: 'window.__k=[]' })
    try { await send('Input.dispatchKeyEvent', down); await send('Input.dispatchKeyEvent', up) }
    catch (e) { console.log(label, 'threw:', e.message); return }
    console.log(label, '->', await read('JSON.stringify(window.__k)'))
  }

  console.log('view focused:', view.webContents.isFocused(), '| hasFocus:', await read('document.hasFocus()'))
  await tryPayload('rawKeyDown + key/code/vk', { type: 'rawKeyDown', ...ARROW }, { type: 'keyUp', ...ARROW })
  await tryPayload('keyDown    + key/code/vk', { type: 'keyDown', ...ARROW }, { type: 'keyUp', ...ARROW })
  await tryPayload('keyDown    + text "-"  ', { type: 'keyDown', text: '-' }, { type: 'keyUp', text: '-' })

  // Emulate the app's state: focus emulation on, page believes it is focused.
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  console.log('\nafter focus emulation → hasFocus:', await read('document.hasFocus()'))
  await tryPayload('rawKeyDown + key/code/vk', { type: 'rawKeyDown', ...ARROW }, { type: 'keyUp', ...ARROW })
  await tryPayload('keyDown    + key/code/vk', { type: 'keyDown', ...ARROW }, { type: 'keyUp', ...ARROW })

  // And with the view's own webContents focused (the other way the docs mention).
  view.webContents.focus()
  await new Promise(r => setTimeout(r, 200))
  console.log('\nafter webContents.focus() → isFocused:', view.webContents.isFocused())
  await tryPayload('rawKeyDown + key/code/vk', { type: 'rawKeyDown', ...ARROW }, { type: 'keyUp', ...ARROW })

  app.quit()
})
