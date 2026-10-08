/**
 * Key names → the key event a page actually receives, for `browser_tool key`.
 *
 * `key` used to be injected natively (`webContents.sendInputEvent`), and that
 * path is silently dead for keys: a key event goes to whatever widget the
 * **window** has focused, and a browser window the person is not typing in (or
 * a tab behind their own) has none — the command reported success and the page
 * saw nothing. A mouse event sent the same way lands fine, because it is
 * dispatched by coordinates rather than to a focused widget; measured side by
 * side: `click` on a background tab counted a click, `key` on the same tab
 * produced no `keydown` at all.
 *
 * CDP's `Input.dispatchKeyEvent` goes to the target itself, wherever it sits,
 * which is why everything else (`fill`, `type`) already used it. The one thing
 * CDP needs that Electron's `keyCode` did not is the mapping below: a DOM
 * `key`, a physical `code`, and a Windows virtual key code (the last is what
 * makes *default* behaviour happen — scrolling, moving focus, and shortcuts
 * like ctrl+a).
 */

export type BrowserKeyModifier = 'shift' | 'control' | 'alt' | 'meta'

/** CDP modifier bitmask (`Input.dispatchKeyEvent`). */
const MODIFIER_BITS: Record<BrowserKeyModifier, number> = {
  alt: 1,
  control: 2,
  meta: 4,
  shift: 8,
}

export interface KeyStroke {
  /** DOM `KeyboardEvent.key`. */
  key: string
  /** DOM `KeyboardEvent.code` — the physical key. */
  code: string
  /** Windows virtual key code (`0` when we have none — a plain character). */
  windowsVirtualKeyCode: number
  /** Text the key inserts, when it inserts any (never with ctrl/meta/alt held). */
  text?: string
}

/** Named keys, under every alias a command line may carry (Electron's names included). */
const NAMED_KEYS: Array<{ aliases: string[]; stroke: KeyStroke }> = [
  { aliases: ['enter', 'return'], stroke: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' } },
  { aliases: ['tab'], stroke: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, text: '\t' } },
  { aliases: ['escape', 'esc'], stroke: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 } },
  { aliases: ['backspace'], stroke: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 } },
  { aliases: ['delete', 'del'], stroke: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 } },
  { aliases: ['insert', 'ins'], stroke: { key: 'Insert', code: 'Insert', windowsVirtualKeyCode: 45 } },
  { aliases: ['arrowleft', 'left'], stroke: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 } },
  { aliases: ['arrowup', 'up'], stroke: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 } },
  { aliases: ['arrowright', 'right'], stroke: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 } },
  { aliases: ['arrowdown', 'down'], stroke: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 } },
  { aliases: ['home'], stroke: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 } },
  { aliases: ['end'], stroke: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 } },
  { aliases: ['pageup', 'pgup'], stroke: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 } },
  { aliases: ['pagedown', 'pgdn'], stroke: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 } },
  { aliases: ['space', ' '], stroke: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' } },
]

/** F1…F12 are the keys a page ever cares about; the rest fall back below. */
function functionKey(n: number): KeyStroke {
  return { key: `F${n}`, code: `F${n}`, windowsVirtualKeyCode: 111 + n }
}

export function modifierMask(modifiers: readonly BrowserKeyModifier[] = []): number {
  return modifiers.reduce((mask, modifier) => mask | (MODIFIER_BITS[modifier] ?? 0), 0)
}

/**
 * One stroke's CDP parameters. `key` may be a name (`ArrowRight`, `Enter`,
 * `Esc`) or a single character (`a`, `7`); anything unrecognised keeps its own
 * name and carries no virtual key code rather than guessing one.
 */
export function keyStroke(key: string, modifiers: readonly BrowserKeyModifier[] = []): KeyStroke {
  const raw = key.trim()
  if (!raw) throw new Error('key requires a key name (e.g. key Enter, key a control)')

  const shift = modifiers.includes('shift')
  // Ctrl/Meta/Alt mean "a shortcut, not a character": no text is inserted.
  const shortcut = modifiers.some(m => m === 'control' || m === 'meta' || m === 'alt')

  const named = NAMED_KEYS.find(entry => entry.aliases.includes(raw.toLowerCase()))
  if (named) {
    return shortcut ? { ...named.stroke, text: undefined } : { ...named.stroke }
  }

  const fKey = /^f([1-9]|1[0-2])$/i.exec(raw)
  if (fKey) return functionKey(Number(fKey[1]))

  if (raw.length === 1) {
    const upper = raw.toUpperCase()
    if (upper >= 'A' && upper <= 'Z') {
      return {
        key: shift ? upper : raw.toLowerCase(),
        code: `Key${upper}`,
        windowsVirtualKeyCode: upper.charCodeAt(0),
        text: shortcut ? undefined : shift ? upper : raw.toLowerCase(),
      }
    }
    if (raw >= '0' && raw <= '9') {
      return { key: raw, code: `Digit${raw}`, windowsVirtualKeyCode: raw.charCodeAt(0), text: shortcut ? undefined : raw }
    }
    // Punctuation and anything else printable: the character itself is the key,
    // and its text is what inserts it. No virtual key code is invented.
    return { key: raw, code: raw, windowsVirtualKeyCode: 0, text: shortcut ? undefined : raw }
  }

  return { key: raw, code: raw, windowsVirtualKeyCode: 0 }
}
