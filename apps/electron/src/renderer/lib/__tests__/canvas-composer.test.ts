import { describe, expect, test } from 'bun:test'
import type { CanvasNode } from '@craft-agent/shared/canvas/document'
import { opensComposer } from '../canvas-composer'

const node = (patch: Partial<CanvasNode> = {}): CanvasNode => ({
  id: 'n',
  type: 'image',
  x: 0,
  y: 0,
  w: 100,
  h: 100,
  z: 0,
  ...patch,
})

describe('opensComposer', () => {
  test('a card the composer made opens its panel, because its parameters are the card', () => {
    expect(opensComposer(node({ src: 'generations/a.png', recipe: { op: 'image-gen', channelId: 'relay' } }))).toBe(true)
    expect(opensComposer(node({ type: 'video', src: 'generations/a.mp4', recipe: { op: 'video-gen' } }))).toBe(true)
    expect(opensComposer(node({ type: 'audio', src: 'generations/a.mp3', recipe: { op: 'audio-gen' } }))).toBe(true)
    expect(opensComposer(node({ type: 'text', src: 'docs/nodes/t.md', recipe: { op: 'image2txt' } }))).toBe(true)
    expect(opensComposer(node({ type: 'text', src: 'docs/nodes/t.md', recipe: { op: 'asr' } }))).toBe(true)
  })

  test('an uploaded file is not a run, so it has no parameters to show', () => {
    expect(opensComposer(node({ src: 'assets/photo.png' }))).toBe(false)
    expect(opensComposer(node({ type: 'video', src: 'assets/clip.mp4' }))).toBe(false)
    expect(opensComposer(node({ type: 'audio', src: 'assets/voice.mp3' }))).toBe(false)
  })

  test('an edit is arithmetic on a file that already existed, not a generation', () => {
    for (const op of ['crop', 'rotate', 'flip', 'resize', 'convert', 'restore']) {
      expect(opensComposer(node({ src: 'generations/a.png', recipe: { op, source: 'assets/a.png' } }))).toBe(false)
    }
  })

  test('an empty card is filled by its composer, so clicking it opens one', () => {
    expect(opensComposer(node())).toBe(true)
    expect(opensComposer(node({ type: 'video' }))).toBe(true)
    expect(opensComposer(node({ type: 'audio' }))).toBe(true)
  })

  test('a text card always opens its composer — the composer is where its words live', () => {
    expect(opensComposer(node({ type: 'text', src: 'docs/nodes/t.md' }))).toBe(true)
    expect(opensComposer(node({ type: 'text' }))).toBe(true)
  })

  test('an operation this build does not know does not open a generation form for it', () => {
    expect(opensComposer(node({ src: 'generations/a.png', recipe: { op: 'future-thing' } }))).toBe(false)
  })
})
