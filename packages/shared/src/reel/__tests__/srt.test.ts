import { describe, expect, test } from 'bun:test'
import {
  cuesFromOverlays,
  formatSrt,
  normalizeCues,
  overlaysFromCues,
  parseSrt,
  stampOf,
} from '../srt.ts'
import type { EditOverlay } from '../overlay.ts'

describe('SRT, the shape speech recognition hands back', () => {
  test('reads numbered cues, multi-line text included', () => {
    const cues = parseSrt(
      [
        '1',
        '00:00:01,000 --> 00:00:03,500',
        '你好，',
        '这是第二行',
        '',
        '2',
        '00:00:04,000 --> 00:00:06,000',
        '再见',
        '',
      ].join('\n'),
    )

    expect(cues).toEqual([
      { start: 1, end: 3.5, text: '你好，\n这是第二行' },
      { start: 4, end: 6, text: '再见' },
    ])
  })

  test('takes what the wild writes: BOM, CRLF, dots, no index, no blank line', () => {
    const cues = parseSrt(
      '\uFEFF00:00:01.500 --> 00:00:02.750\r\n第一句\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\n第二句\r\n',
    )

    expect(cues).toEqual([
      { start: 1.5, end: 2.75, text: '第一句' },
      { start: 3, end: 4, text: '第二句' },
    ])
  })

  test('a block with no words, or no time after its start, is skipped — not fatal', () => {
    const cues = parseSrt(
      [
        '1',
        '00:00:01,000 --> 00:00:02,000',
        '',
        '2',
        '00:00:05,000 --> 00:00:05,000',
        '零时长',
        '',
        '3',
        '00:00:07,000 --> 00:00:08,000',
        '留下',
      ].join('\n'),
    )

    expect(cues).toEqual([{ start: 7, end: 8, text: '留下' }])
  })

  test('writes a file that reads back the same', () => {
    const cues = [
      { start: 0, end: 1.5, text: '第一句' },
      { start: 61.25, end: 62, text: '第二句\n换行' },
    ]
    const text = formatSrt(cues)

    expect(text).toContain('1\n00:00:00,000 --> 00:00:01,500\n第一句')
    expect(text).toContain('2\n00:01:01,250 --> 00:01:02,000\n第二句\n换行')
    expect(parseSrt(text)).toEqual(cues)
  })

  test('timestamps stay inside their hours and minutes', () => {
    expect(stampOf(3661.001)).toBe('01:01:01,001')
  })

  test('a JSON result is cues too, with end or duration', () => {
    expect(
      normalizeCues([
        { start: 0, end: 2, text: ' a ' },
        { start: 3, duration: 1.5, text: 'b' },
        { start: 3, end: 3, text: 'empty window' },
        { start: 4, end: 5, text: '   ' },
        'nonsense',
      ]),
    ).toEqual([
      { start: 0, end: 2, text: 'a' },
      { start: 3, end: 4.5, text: 'b' },
    ])
  })

  test('cues become subtitle overlays, the shape the panel already paints', () => {
    const overlays = overlaysFromCues([{ start: 1, end: 2.5, text: '你好' }], { z: 10 })

    expect(overlays).toEqual([
      { kind: 'text', text: '你好', start: 1, duration: 1.5, preset: 'subtitle', z: 10 },
    ])
  })

  test('exporting takes subtitles only, in time order — a title is not dialogue', () => {
    const overlays: EditOverlay[] = [
      { id: 'a', kind: 'text', text: '第二句', start: 4, duration: 2, preset: 'subtitle' },
      { id: 'b', kind: 'text', text: 'Episode 1', start: 0, duration: 2, preset: 'title' },
      { id: 'c', kind: 'text', text: '第一句', start: 1, duration: 2 },
      { id: 'd', kind: 'media', src: 'assets/face.mp4', start: 1, duration: 2 },
      { id: 'e', kind: 'text', text: '  ', start: 6, duration: 2, preset: 'subtitle' },
    ]

    expect(cuesFromOverlays(overlays)).toEqual([
      { start: 1, end: 3, text: '第一句' },
      { start: 4, end: 6, text: '第二句' },
    ])
  })
})
