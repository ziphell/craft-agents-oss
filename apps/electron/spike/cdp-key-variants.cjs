/**
 * Which `Input.dispatchKeyEvent` payload actually produces a DOM keydown?
 *
 * Run: node_modules/electron/dist/electron.exe apps/electron/spike/cdp-key-variants.cjs
 *
 * The app's `browser_tool key` sends a key through CDP now; the first attempt
 * (rawKeyDown + key/code/vk/nativeVk) delivered nothing to the page while
 * `type`'s {type:'keyDown', text} did. This runs both against one page so the
 * difference is measured rather than guessed, without rebuilding the app.
 */
const { app, BrowserWindow } = require('electron')

const PAGE =
  'data:text/html;charset=utf-8,' +
  encodeURIComponent(`<!doctype html><meta charset="utf-8"><title>k</title>
<body>
  <input id="f" autofocus>
  <script>
    window.__k = [];
    window.__input = [];
    addEventListener('keydown', function (e) {
      window.__k.push({ key: e.key, code: e.code, vk: e.keyCode, ctrl: e.ctrlKey, shift: e.shiftKey });
    }, true);
    document.addEventListener('input', function (e) { window.__input.push(e.target.value); });
  </script>
</body>`)

const ARROW = { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 }

/** name → the three dispatches that make one press. */
function variants() {
  return {
    'A rawKeyDown + key/code/vk/nativeVk (what shipped first)': [
      { type: 'rawKeyDown', ...ARROW, nativeVirtualKeyCode: 39, modifiers: 0 },
      null,
      { type: 'keyUp', ...ARROW, nativeVirtualKeyCode: 39, modifiers: 0 },
    ],
    'B rawKeyDown + key/code/vk (no nativeVk, like Playwright)': [
      { type: 'rawKeyDown', ...ARROW, modifiers: 0 },
      null,
      { type: 'keyUp', ...ARROW, modifiers: 0 },
    ],
    'C keyDown + key/code/vk': [
      { type: 'keyDown', ...ARROW, modifiers: 0 },
      null,
      { type: 'keyUp', ...ARROW, modifiers: 0 },
    ],
    'D rawKeyDown + vk only': [
      { type: 'rawKeyDown', windowsVirtualKeyCode: 39 },
      null,
      { type: 'keyUp', windowsVirtualKeyCode: 39 },
    ],
    'E type-like: keyDown + text only (the `type` command)': [
      { type: 'keyDown', text: 'arrowrighttext' },
      null,
      { type: 'keyUp', text: 'arrowrighttext' },
    ],
    'F rawKeyDown + key only': [
      { type: 'rawKeyDown', key: 'ArrowRight' },
      null,
      { type: 'keyUp', key: 'ArrowRight' },
    ],
    'G rawKeyDown + vk + location (Playwright shape)': [
      { type: 'rawKeyDown', ...ARROW, modifiers: 0, location: 0, isKeypad: false, autoRepeat: false },
      null,
      { type: 'keyUp', ...ARROW, modifiers: 0, location: 0, isKeypad: false, autoRepeat: false },
    ],
  }
}

const ENTER = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 600 })
  await win.loadURL(PAGE)
  win.webContents.focus()
  await new Promise((r) => setTimeout(r, 300))

  const dbg = win.webContents.debugger
  dbg.attach('1.3')
  const send = (method, params) => dbg.sendCommand(method, params)
  const read = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result.value

  for (const [name, steps] of Object.entries(variants())) {
    await send('Runtime.evaluate', { expression: 'window.__k = []' })
    try {
      for (const step of steps) {
        if (step) await send('Input.dispatchKeyEvent', step)
      }
      const keys = await read('JSON.stringify(window.__k)')
      console.log(`${keys === '[]' ? '✗ nothing ' : '✓ delivered'}  ${name}\n    ${keys}`)
    } catch (error) {
      console.log(`! threw     ${name}\n    ${error.message}`)
    }
  }

  // The winner, on Enter: a keydown whose text really reaches the field.
  console.log('\n--- Enter through B (rawKeyDown + char) ---')
  await send('Runtime.evaluate', { expression: 'window.__k = []; window.__input = []; document.getElementById("f").value = ""' })
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...ENTER, modifiers: 0 })
  await send('Input.dispatchKeyEvent', { type: 'char', ...ENTER, text: '\r', modifiers: 0 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...ENTER, modifiers: 0 })
  console.log('keydowns:', await read('JSON.stringify(window.__k)'))
  console.log('inputs:  ', await read('JSON.stringify(window.__input)'))

  app.quit()
})
