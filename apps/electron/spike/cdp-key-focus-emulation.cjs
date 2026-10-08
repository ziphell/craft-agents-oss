/** Does focus emulation change which key payload arrives? */
const { app, BrowserWindow } = require('electron')
const PAGE = 'data:text/html;charset=utf-8,' + encodeURIComponent(
  '<!doctype html><meta charset="utf-8"><title>k</title><body><input id="f" autofocus><script>' +
  'window.__k=[];addEventListener("keydown",function(e){window.__k.push(e.key+":"+e.keyCode)},true);</script>')
const ARROW = { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 }

app.whenReady().then(async () => {
  const person = new BrowserWindow({ show: true, width: 600, height: 300 })
  await person.loadURL('data:text/html,<h1>person</h1>')
  const hidden = new BrowserWindow({ show: false, width: 900, height: 600 })
  await hidden.loadURL(PAGE)
  person.focus()
  await new Promise(r => setTimeout(r, 300))

  const dbg = hidden.webContents.debugger
  dbg.attach('1.3')
  const send = (m, p) => dbg.sendCommand(m, p)
  const read = async e => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result.value

  async function tryPayload(label, down, up) {
    await send('Runtime.evaluate', { expression: 'window.__k=[]' })
    try { await send('Input.dispatchKeyEvent', down); await send('Input.dispatchKeyEvent', up) }
    catch (e) { console.log(label, 'threw:', e.message); return }
    console.log(label, '->', await read('JSON.stringify(window.__k)'), '| hasFocus:', await read('document.hasFocus()'))
  }

  for (const emulated of [false, true]) {
    await send('Emulation.setFocusEmulationEnabled', { enabled: emulated })
    await new Promise(r => setTimeout(r, 150))
    console.log('\n=== focus emulation', emulated, '===')
    await tryPayload('rawKeyDown + key/code/vk ', { type: 'rawKeyDown', ...ARROW }, { type: 'keyUp', ...ARROW })
    await tryPayload('keyDown    + key/code/vk ', { type: 'keyDown', ...ARROW }, { type: 'keyUp', ...ARROW })
    await tryPayload('keyDown    + text "-"   ', { type: 'keyDown', text: '-' }, { type: 'keyUp', text: '-' })
    await tryPayload('rawKeyDown + key only   ', { type: 'rawKeyDown', key: 'ArrowRight' }, { type: 'keyUp', key: 'ArrowRight' })
  }
  app.quit()
})
