import { describe, it, expect } from 'bun:test'
import { keyStroke, modifierMask, typeSteps } from '../browser-key-map'

describe('browser key map', () => {
  it('maps the keys the browser tool documents, under their aliases too', () => {
    expect(keyStroke('ArrowRight')).toEqual({ key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 })
    expect(keyStroke('right')).toEqual(keyStroke('ArrowRight'))
    expect(keyStroke('Up')).toEqual(keyStroke('ArrowUp'))
    expect(keyStroke('Esc')).toEqual(keyStroke('Escape'))
    expect(keyStroke('PageDown')).toEqual(keyStroke('pgdn'))
  })

  it('gives the keys that insert something their text', () => {
    expect(keyStroke('Enter')).toEqual({ key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
    expect(keyStroke('Tab').text).toBe('\t')
    expect(keyStroke('Space')).toEqual({ key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' })
    expect(keyStroke('a')).toEqual({ key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, text: 'a' })
    expect(keyStroke('7')).toEqual({ key: '7', code: 'Digit7', windowsVirtualKeyCode: 55, text: '7' })
  })

  it('treats shift as a character and ctrl/meta/alt as a shortcut', () => {
    expect(keyStroke('a', ['shift'])).toEqual({ key: 'A', code: 'KeyA', windowsVirtualKeyCode: 65, text: 'A' })
    // A shortcut inserts nothing — that is what makes ctrl+a select instead of typing.
    expect(keyStroke('a', ['control']).text).toBeUndefined()
    expect(keyStroke('k', ['meta']).text).toBeUndefined()
    expect(keyStroke('Enter', ['meta']).text).toBeUndefined()
  })

  it('carries a virtual key code for function keys, and none for what it does not know', () => {
    expect(keyStroke('F5')).toEqual({ key: 'F5', code: 'F5', windowsVirtualKeyCode: 116 })
    expect(keyStroke('F12').windowsVirtualKeyCode).toBe(123)
    // Unknown names keep their own name rather than guessing a code.
    expect(keyStroke('MediaPlayPause')).toEqual({ key: 'MediaPlayPause', code: 'MediaPlayPause', windowsVirtualKeyCode: 0 })
    expect(keyStroke('?').windowsVirtualKeyCode).toBe(0)
    expect(keyStroke('?').text).toBe('?')
  })

  it('builds the CDP modifier bitmask', () => {
    expect(modifierMask()).toBe(0)
    expect(modifierMask(['alt'])).toBe(1)
    expect(modifierMask(['control'])).toBe(2)
    expect(modifierMask(['meta'])).toBe(4)
    expect(modifierMask(['shift'])).toBe(8)
    expect(modifierMask(['shift', 'control'])).toBe(10)
  })

  it('refuses an empty key rather than pressing nothing', () => {
    expect(() => keyStroke('  ')).toThrow('key requires a key name')
  })
  it('types only what a key can produce, and inserts the rest', () => {
    const LF = String.fromCharCode(10)
    const TAB = String.fromCharCode(9)

    // ASCII 逐字按键；换行/制表符各走它们自己的那个键
    expect(typeSteps(`ab${LF}c${TAB}d`)).toEqual([
      { kind: 'char', char: 'a' },
      { kind: 'char', char: 'b' },
      { kind: 'named', key: 'Enter' },
      { kind: 'char', char: 'c' },
      { kind: 'named', key: 'Tab' },
      { kind: 'char', char: 'd' },
    ])

    // 中文没有物理键：连续的一段合并成一次插入，中间的 ASCII 空格照常按键
    expect(typeSteps('前端 dev')).toEqual([
      { kind: 'insert', text: '前端' },
      { kind: 'char', char: ' ' },
      { kind: 'char', char: 'd' },
      { kind: 'char', char: 'e' },
      { kind: 'char', char: 'v' },
    ])

    // 表情、全角标点同理
    expect(typeSteps('😀')).toEqual([{ kind: 'insert', text: '😀' }])
    expect(typeSteps('，。')).toEqual([{ kind: 'insert', text: '，。' }])
    expect(typeSteps('')).toEqual([])
  })
})
