import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  frameFileName,
  getPrototypeFramesPath,
  writeFrameCapture,
  type PrototypeFrameCapture,
} from '..'

let workspaceRoot = ''

afterEach(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true })
  workspaceRoot = ''
})

const capture: PrototypeFrameCapture = {
  startedAt: '2026-09-15T10:30:12.000Z',
  endedAt: '2026-09-15T10:31:02.000Z',
  intervalMs: 400,
  threshold: 0.005,
  viewport: { width: 1280, height: 800 },
  truncated: false,
  frames: [
    { index: 1, at: '2026-09-15T10:30:12.000Z', url: 'http://x.localhost/cart', page: 'cart', reason: 'start' },
    {
      index: 2,
      at: '2026-09-15T10:30:14.000Z',
      url: 'http://x.localhost/cart',
      page: 'cart',
      reason: 'action',
      action: 'click left at 40,120',
    },
    {
      index: 3,
      at: '2026-09-15T10:30:16.000Z',
      url: 'http://x.localhost/cart',
      page: 'cart',
      reason: 'changed',
    },
  ],
}

describe('writeFrameCapture', () => {
  it('writes numbered images, the index, and the human-readable companion', () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-prototype-frames-'))

    const result = writeFrameCapture(workspaceRoot, 'checkout-flow', capture, [
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5, 6]),
      new Uint8Array([7, 8, 9]),
    ])

    // One directory per session, named from the start time so a listing is sorted.
    expect(result.dir).toBe(join(getPrototypeFramesPath(workspaceRoot, 'checkout-flow'), '20260915-103012'))
    expect(result.files).toEqual([
      'frame-0001.jpg',
      'frame-0002.jpg',
      'frame-0003.jpg',
      'frames.json',
      'index.md',
    ])

    const index = readFileSync(join(result.dir, 'index.md'), 'utf-8')
    // The human companion has to say *why* a frame is there: a change the screen
    // made on its own and a click look identical in a directory listing.
    expect(index).toContain('| 2 | `frame-0002.jpg` | 2026-09-15T10:30:14.000Z | action: click left at 40,120 | cart |')
    expect(index).toContain('| 3 | `frame-0003.jpg` | 2026-09-15T10:30:16.000Z | changed |')
    expect(index).toContain('1280×800 device pixels')
    expect(index).toContain('evidence: frames/20260915-103012/frame-0001.jpg')

    const json = JSON.parse(readFileSync(join(result.dir, 'frames.json'), 'utf-8')) as PrototypeFrameCapture
    expect(json.frames.map((frame) => frame.reason)).toEqual(['start', 'action', 'changed'])
    expect(json.frames[1]?.action).toBe('click left at 40,120')
  })

  it('says so when the capture was a sample', () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-prototype-frames-'))

    const result = writeFrameCapture(
      workspaceRoot,
      'checkout-flow',
      { ...capture, truncated: true },
      capture.frames.map(() => new Uint8Array([1])),
    )

    expect(readFileSync(join(result.dir, 'index.md'), 'utf-8')).toContain('hit its frame limit')
  })

  // A frames.json pointing at images that are not there would be worse than a
  // failed write: the index is what makes a frame citable.
  it('refuses a capture whose frame and image counts disagree', () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-prototype-frames-'))

    expect(() => writeFrameCapture(workspaceRoot, 'checkout-flow', capture, [new Uint8Array([1])])).toThrow(
      'Frame capture is inconsistent',
    )
    expect(existsSync(getPrototypeFramesPath(workspaceRoot, 'checkout-flow'))).toBe(false)
  })

  it('pads the file name so a listing is in capture order', () => {
    expect(frameFileName(1)).toBe('frame-0001.jpg')
    expect(frameFileName(12)).toBe('frame-0012.jpg')
  })
})
