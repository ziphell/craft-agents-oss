import { describe, expect, test } from 'bun:test'
import type { CanvasNode } from '../document.ts'
import { displayTitle, titleFromFile, titleFromText } from '../title.ts'

const node = (patch: Partial<CanvasNode> = {}): CanvasNode => ({
  id: 'n-mw8srn1w-thw',
  type: 'image',
  x: 0,
  y: 0,
  w: 100,
  h: 100,
  z: 0,
  ...patch,
})

describe('titleFromText', () => {
  test('takes the first line and drops the markdown that formats it', () => {
    expect(titleFromText('# 黄昏的街道\n\n更多说明')).toBe('黄昏的街道')
    expect(titleFromText('- 一只猫坐在窗台上')).toBe('一只猫坐在窗台上')
    expect(titleFromText('\n\n  \n 第二行才是第一句')).toBe('第二行才是第一句')
  })

  test('flattens whitespace and caps the length', () => {
    expect(titleFromText('a    b\t\tc')).toBe('a b c')
    expect(titleFromText('x'.repeat(200))!.length).toBe(80)
  })

  test('nothing to name is nothing', () => {
    expect(titleFromText(undefined)).toBeUndefined()
    expect(titleFromText('   \n\n  ')).toBeUndefined()
    expect(titleFromText('#')).toBeUndefined()
  })
})

describe('titleFromFile', () => {
  test('is the file name without its extension, path and all', () => {
    expect(titleFromFile('assets/黄昏.png')).toBe('黄昏')
    expect(titleFromFile('C:\\work\\a.b.mp4')).toBe('a.b')
    expect(titleFromFile('no-extension')).toBe('no-extension')
  })
})

describe('displayTitle', () => {
  test('a name somebody typed wins over everything', () => {
    expect(displayTitle(node({ title: '  主视觉  ', src: 'assets/x.png' }))).toBe('主视觉')
  })

  test('an unnamed card shows its file name, which beats showing nothing', () => {
    expect(displayTitle(node({ src: 'assets/黄昏.png' }))).toBe('黄昏')
  })

  test('a machine name is not a name — an id-shaped file shows nothing', () => {
    expect(displayTitle(node({ src: 'docs/nodes/n-mw8srn1w-thw.md' }))).toBeNull()
    expect(displayTitle(node())).toBeNull()
    expect(displayTitle(null)).toBeNull()
  })
})
