/**
 * The sampler's step — i.e. what a read actually looks at.
 *
 * The script itself cannot be run here: it is a page, and it needs a `<video>`. What is pinned is
 * the arithmetic that decides the coverage. A timeline divides the span by the ceiling, so its
 * frames **reach the end** of the range, wider apart than the interval asked for when the ceiling
 * cannot hold it at that detail. Stopping at the ceiling instead — fine at the start, nothing after
 * — is what this used to do.
 *
 * Both hosts run this one script: the desktop in a hidden window, a hub in its render host.
 */

import { describe, expect, it } from 'bun:test'
import { buildSamplerScript, frameFileName, type VideoSampleOptions } from '../sampler-script.ts'

function options(mode: 'timeline' | 'changes', maxFrames: number): VideoSampleOptions {
  return { mode, everyMs: 1_000, maxFrames, changeThreshold: 0.01, fromMs: 0 }
}

describe('the sampler script', () => {
  it('divides the span by the ceiling for a timeline, so the frames reach the end', () => {
    const script = buildSamplerScript('blob:x', options('timeline', 40))

    expect(script).toContain('const ceiling = 40')
    // The whole span over the ceiling — not four times it, which would stop at a quarter of the way.
    expect(script).toContain('const budget = 40')
  })

  it('walks four times finer than it keeps for --changes', () => {
    const script = buildSamplerScript('blob:x', options('changes', 40))

    expect(script).toContain('const budget = 160')
  })

  it('counts the ceiling as reached only when there was range left over', () => {
    const script = buildSamplerScript('blob:x', options('timeline', 40))

    expect(script).toContain('if (frames.length >= ceiling) { truncated = t + stride <= rangeEnd; break }')
  })

  it('returns the header alone for a probe, before any seek', () => {
    const probe = buildSamplerScript('blob:x', { ...options('timeline', 1), probeOnly: true })
    const read = buildSamplerScript('blob:x', options('timeline', 1))

    // One script stops at the metadata; the other keeps walking the range.
    expect(probe).toContain('if (true) return { durationMs, width, height, truncated: false, frames: [] }')
    expect(read).toContain('if (false) return')
  })

  it('names frames so a plain ls is already in order', () => {
    expect(frameFileName(1)).toBe('frame-0001.jpg')
    expect(frameFileName(12)).toBe('frame-0012.jpg')
  })
})
