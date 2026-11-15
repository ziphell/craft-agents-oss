import { describe, expect, it } from 'bun:test'
import { releaseWindowControlsHidden, requestWindowControlsHidden } from '../FullscreenOverlayBase'

// Both cases end back at zero requests, so they do not depend on running order.
describe('window control hide requests', () => {
  it('keeps them away while any overlay is still open', () => {
    // A second overlay opens on top of the first.
    expect(requestWindowControlsHidden()).toBe(true)
    expect(requestWindowControlsHidden()).toBe(false)

    // The first one closes: the second is still on screen, so nothing comes back.
    expect(releaseWindowControlsHidden()).toBe(false)
    expect(releaseWindowControlsHidden()).toBe(true)
  })

  it('reports both edges, so the platform is only told when the answer changes', () => {
    expect(requestWindowControlsHidden()).toBe(true)
    expect(releaseWindowControlsHidden()).toBe(true)
  })
})
