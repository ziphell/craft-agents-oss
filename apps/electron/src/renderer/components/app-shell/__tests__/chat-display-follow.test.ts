import { describe, expect, it } from 'bun:test'
import { chooseFollowBehavior } from '../ChatDisplay.follow'

const VIEWPORT = 800
const NOW = 1_000_000

function decide(distance: number, overrides: Partial<{ now: number; quietUntil: number; viewportHeight: number }> = {}) {
  return chooseFollowBehavior({
    distance,
    viewportHeight: VIEWPORT,
    now: NOW,
    quietUntil: 0,
    ...overrides,
  })
}

describe('chooseFollowBehavior', () => {
  it('animates a small addition the reader can follow', () => {
    expect(decide(120)).toBe('smooth')
  })

  it('jumps when the newest content is further away than the viewport', () => {
    // This is the case that used to look like the transcript scrolling itself
    // from its first message to its last when a long conversation opened.
    expect(decide(VIEWPORT + 1)).toBe('instant')
    expect(decide(12_000)).toBe('instant')
  })

  it('treats exactly one viewport as still followable', () => {
    expect(decide(VIEWPORT)).toBe('smooth')
  })

  it('never animates when there is nowhere to go', () => {
    expect(decide(0)).toBe('instant')
    expect(decide(-40)).toBe('instant')
  })

  it('jumps while the panel is still settling from its own open', () => {
    expect(decide(120, { quietUntil: NOW + 500 })).toBe('instant')
    expect(decide(120, { quietUntil: NOW })).toBe('smooth')
  })

  it('relocation wins over a quiet window that already expired', () => {
    expect(decide(4_000, { quietUntil: NOW - 1 })).toBe('instant')
  })

  it('a zero-height viewport (not laid out yet) never animates', () => {
    expect(
      chooseFollowBehavior({ distance: 40, viewportHeight: 0, now: NOW, quietUntil: 0 }),
    ).toBe('instant')
  })
})
