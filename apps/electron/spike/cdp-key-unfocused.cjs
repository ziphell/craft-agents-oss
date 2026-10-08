/**
 * Keys into a window nobody is looking at — the state the workspace browser
 * window is in while a conversation works (the app's own window has the focus).
 *
 * Run: node_modules/electron/dist/electron.exe apps/electron/spike/cdp-key-unfocused.cjs
 *
 * Two windows: a "person" one that is shown and focused, and a hidden one that
 * holds the probe page. Every variant is dispatched to the hidden one, so the
 * only way a key arrives is by not depending on the window being focused.
 */
const { app, BrowserWindow } = require('electron')

const PAGE =
  'data:text/html;charset=utf-8,' +
  encodeURIComponent(`<!doctype html><meta charset="utf-8"><title>k</title>
<body>
  <input id="f" autofocus>
  <script>
    window.__k = [];
    addEventListener('keydown', function (e) { window.__k.push(e.key + ':' + e.keyCode + (e.isTrusted ? ':trusted' : ':synthetic')); }, true);
  </script>
</body>`)

const ARROW = { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 }

function variants() {
  return {
    'A rawKeyDown + key/code/vk': [{ type: 'rawKeyDown', ...ARROW }],
    'B keyDown + key/code/vk': [{ type: 'keyDown', ...ARROW }],
    'C rawKeyDown + text ""': [{ type: 'rawKeyDown', ...ARROW, text: '' }],
    'D keyDown + text ""': [{ type: 'keyDown', ...ARROW, text: '' }],
    'E type-like keyDown + text "-" (a printable)': [{ type: 'keyDown', text: '-' }],
    'F rawKeyDown + key only': [{ type: 'rawKeyDown', key: 'ArrowRight' }],
    'G keyDown + key only': [{ type: 'keyDown', key: 'ArrowRight' }],
  }
}

app.whenReady().then(async () => {
  const person = new BrowserWindow({ show: true, width: 700, height: 400, title: 'person' })
  await person.loadURL('data:text/html,<h1>the person is typing here</h1>')

  const hidden = new BrowserWindow({ show: false, width: 900, height: 600 })
  await hidden.loadURL(PAGE)

  person.focus()
  await new Promise((r) => setTimeout(r, 400))

  const dbg = hidden.webContents.debugger
  dbg.attach('1.3')
  const send = (method, params) => dbg.sendCommand(method, params)
  const read = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result.value

  console.log('person window focused:', person.isFocused(), '| hidden window focused:', hidden.isFocused())
  console.log('page hasFocus (before):', await read('document.hasFocus()'))

  for (const [name, steps] of Object.entries(variants())) {
    await send('Runtime.evaluate', { expression: 'window.__k = []' })
    try {
      for (const step of steps) await send('Input.dispatchKeyEvent', step)
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...ARROW })
      const keys = await read('JSON.stringify(window.__k)')
      console.log(`${keys === '[]' ? '✗ nothing ' : '✓ delivered'}  ${name}\n    ${keys}`)
    } catch (error) {
      console.log(`! threw     ${name}\n    ${error.message}`)
    }
  }

  // Does focusing the hidden view itself (never the window) change anything?
  console.log('\n--- after hidden.webContents.focus() ---')
  hidden.webContents.focus()
  await new Promise((r) => setTimeout(r, 200))
  console.log('page hasFocus (after):', await read('document.hasFocus()'))
  await send('Runtime.evaluate', { expression: 'window.__k = []' })
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...ARROW })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...ARROW })
  console.log('A rawKeyDown + key/code/vk ->', await read('JSON.stringify(window.__k)'))

  app.quit()
})
