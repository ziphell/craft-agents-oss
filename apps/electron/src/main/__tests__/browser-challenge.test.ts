import { describe, it, expect } from 'bun:test'
import { readChallengeVerdict, type ChallengeEvidence } from '../browser-challenge'

/** A plain page with nothing to say for itself: the shape most pages have. */
function evidence(overrides: Partial<ChallengeEvidence> = {}): ChallengeEvidence {
  return {
    title: 'Example Domain',
    url: 'https://example.com/',
    domSignals: [],
    nodeCount: 1,
    actionableCount: 1,
    ...overrides,
  }
}

describe('the security-challenge verdict', () => {
  /**
   * The false positive this was written for. `ax:near-empty` alone used to be a detection, with
   * `provider: 'unknown'` — so example.com, a news article and a single-field search page all came
   * back as "Security verification detected", `snapshot` withheld the tree it was asked for, and
   * the tool told the agent to ask a person to solve a captcha that was not there. Sixteen
   * detections across this workspace's sessions were that, and none of them was a challenge.
   */
  it('does not call a thin page a challenge', () => {
    const verdict = readChallengeVerdict(evidence())
    expect(verdict.detected).toBe(false)
    expect(verdict.provider).toBe('none')
    expect(verdict.signals).toEqual([])
  })

  it('does not call a thin page a challenge however empty it is', () => {
    expect(readChallengeVerdict(evidence({ title: '', url: 'https://example.com/article', nodeCount: 22, actionableCount: 0 })).detected).toBe(false)
    expect(readChallengeVerdict(evidence({ nodeCount: 0, actionableCount: 0 })).detected).toBe(false)
  })

  it('reads a Cloudflare interstitial from its title', () => {
    const verdict = readChallengeVerdict(
      evidence({ title: 'Just a moment...', url: 'https://site.example/', nodeCount: 3, actionableCount: 1 }),
    )
    expect(verdict.detected).toBe(true)
    expect(verdict.provider).toBe('cloudflare')
    expect(verdict.signals).toContain('title:just-a-moment')
  })

  it('reads the challenge platform out of the address', () => {
    const verdict = readChallengeVerdict(
      evidence({ url: 'https://site.example/cdn-cgi/challenge-platform/h/b/orchestrate/jsch/v1', nodeCount: 40, actionableCount: 9 }),
    )
    expect(verdict.detected).toBe(true)
    expect(verdict.provider).toBe('cloudflare')
    expect(verdict.signals).toContain('url:cdn-cgi-challenge')
  })

  it('reads what the document says, whoever asked', () => {
    const verdict = readChallengeVerdict(
      evidence({ title: 'Access denied', url: 'https://shop.example/', domSignals: ['text:verify-human', 'dom:cf-turnstile'], nodeCount: 30, actionableCount: 6 }),
    )
    expect(verdict.detected).toBe(true)
    expect(verdict.provider).toBe('cloudflare')
    expect(verdict.signals).toContain('text:verify-human')
  })

  it('is a challenge without being Cloudflare when the document says so plainly', () => {
    const verdict = readChallengeVerdict(
      evidence({ title: 'security check', url: 'https://bank.example/login', domSignals: ['text:security-verification'] }),
    )
    expect(verdict.detected).toBe(true)
    expect(verdict.provider).toBe('unknown')
  })

  it('reports a thin tree next to a real signal, never instead of one', () => {
    const verdict = readChallengeVerdict(
      evidence({ title: 'Just a moment...', nodeCount: 2, actionableCount: 0 }),
    )
    expect(verdict.detected).toBe(true)
    expect(verdict.signals).toEqual(['title:just-a-moment', 'ax:near-empty(0/2)'])
  })

  it('does not repeat a signal the document and the address both gave', () => {
    const verdict = readChallengeVerdict(
      evidence({ domSignals: ['dom:cf-turnstile', 'dom:cf-turnstile'], nodeCount: 20, actionableCount: 5 }),
    )
    expect(verdict.signals).toEqual(['dom:cf-turnstile'])
  })

  it('keeps the shape out of a verdict it did not make', () => {
    // The tree is thin *and* the page is fine: the signal is not reported, because there is no
    // verdict for it to corroborate and a reader would take it for one.
    const verdict = readChallengeVerdict(evidence({ nodeCount: 1, actionableCount: 0 }))
    expect(verdict.signals).toEqual([])
  })
})
