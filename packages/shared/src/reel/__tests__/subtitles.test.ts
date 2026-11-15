import { describe, expect, test } from 'bun:test'
import { addOverlay, emptyDocument } from '../document.ts'
import {
  clearSubtitles,
  dedupeSubtitles,
  replaceSubtitleText,
  shiftSubtitles,
  styleSubtitles,
} from '../subtitles.ts'

const cut = () => {
  let doc = emptyDocument('cut')
  doc = addOverlay(doc, { kind: 'text', text: '第一句', start: 0.5, duration: 1, preset: 'subtitle' })
  doc = addOverlay(doc, { kind: 'text', text: '第二句 AI', start: 2, duration: 1, preset: 'subtitle' })
  doc = addOverlay(doc, { kind: 'text', text: '标题', start: 0, duration: 2, preset: 'title' })
  return doc
}

const texts = (doc: ReturnType<typeof cut>) => doc.overlays.map((overlay) => overlay.text)

describe('subtitle batches — dialogue only', () => {
  test('shift moves every subtitle, clamps at zero, and leaves titles alone', () => {
    const doc = shiftSubtitles(cut(), 0.4)
    expect(doc.overlays[0]!.start).toBeCloseTo(0.9)
    expect(doc.overlays[1]!.start).toBeCloseTo(2.4)
    expect(doc.overlays[2]!.start).toBe(0)

    const back = shiftSubtitles(doc, -2)
    expect(back.overlays[0]!.start).toBe(0)
    expect(back.overlays[1]!.start).toBeCloseTo(0.4)
    // A title is a graphic, not dialogue.
    expect(back.overlays[2]!.start).toBe(0)
  })

  test('a range limits the shift by cue start', () => {
    const doc = shiftSubtitles(cut(), 1, { from: 1 })
    expect(doc.overlays[0]!.start).toBe(0.5)
    expect(doc.overlays[1]!.start).toBe(3)
  })

  test('replace is literal, case-insensitive by default, and whole-word optional', () => {
    const doc = replaceSubtitleText(cut(), 'ai', '人工智能')
    expect(texts(doc)).toEqual(['第一句', '第二句 人工智能', '标题'])

    let words = addOverlay(emptyDocument('cut'), {
      kind: 'text',
      text: 'AIM AI',
      start: 0,
      duration: 1,
      preset: 'subtitle',
    })
    words = replaceSubtitleText(words, 'AI', '人工智能', { wholeWords: true })
    expect(words.overlays[0]!.text).toBe('AIM 人工智能')

    const cased = replaceSubtitleText(cut(), 'AI', 'x', { matchCase: true })
    expect(texts(cased)[1]).toBe('第二句 x')
  })

  test('dedupe drops the shorter copy of the same words', () => {
    let doc = cut()
    doc = addOverlay(doc, { kind: 'text', text: '第一句', start: 0.5, duration: 0.4, preset: 'subtitle' })
    doc = addOverlay(doc, { kind: 'text', text: '第一句', start: 0.9, duration: 1, preset: 'subtitle' })
    const deduped = dedupeSubtitles(doc, 0.02)
    // The two cues at 0.5 collapse to the longer one; the one at 0.9 stays.
    expect(deduped.overlays.filter((overlay) => overlay.text === '第一句')).toHaveLength(2)
    expect(deduped.overlays[0]!.duration).toBe(1)
  })

  test('clear drops dialogue in range and keeps titles — the start of a re-transcription', () => {
    const all = clearSubtitles(cut())
    expect(texts(all)).toEqual(['标题'])

    const ranged = clearSubtitles(cut(), { from: 2 })
    expect(texts(ranged)).toEqual(['第一句', '标题'])

    // Nothing in range leaves the document untouched.
    expect(texts(clearSubtitles(cut(), { from: 10 }))).toEqual(['第一句', '第二句 AI', '标题'])
  })

  test('one style for every subtitle, and nothing else', () => {
    const doc = styleSubtitles(cut(), { fontSize: 62, color: '#ffe066' })
    expect(doc.overlays[0]!.style?.fontSize).toBe(62)
    expect(doc.overlays[1]!.style?.color).toBe('#ffe066')
    expect(doc.overlays[2]!.style?.fontSize).toBeUndefined()
  })
})
