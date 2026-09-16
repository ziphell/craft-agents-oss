import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  buildAnchorCandidateScript,
  buildAnchorProbeScript,
  createPrototype,
  dropPrototypeAnchors,
  getPrototypeAnchorsPath,
  readAllPrototypeAnchors,
  readPrototypeAnchors,
  recordPrototypeAnchors,
  resolveAnchorDrift,
  resolveAnchorOrphans,
  type PrototypeAnchorFingerprint,
  type PrototypePatch,
} from '..'

const SLUG = 'checkout-flow'

const fingerprint: PrototypeAnchorFingerprint = {
  tag: 'button',
  text: 'Pay now',
  path: 'form > button',
  attrs: ['#pay', '[data-role="pay"]'],
}

function patch(file: string, targets: string[], page: string | null = null): PrototypePatch {
  return {
    file,
    kind: 'css',
    lane: file.slice(0, 1),
    order: 1,
    source: '/* @target ' + (targets[0] ?? '.x') + ' */',
    targets,
    page,
    key: `prototype:${SLUG}:${file}`,
  }
}

describe('prototype anchors', () => {
  let workspaceRoot = ''

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-anchors-'))
    createPrototype(workspaceRoot, { name: SLUG })
  })

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('records what a target matched, and keeps the patches that declare it', () => {
    const file = recordPrototypeAnchors(workspaceRoot, SLUG, 'cart', {
      url: 'https://shop.example.com/cart',
      observed: [{ target: '.pay-btn', matched: 1, patches: ['cart/A-001-pay.css'], fingerprint }],
      now: new Date('2026-09-15T10:00:00Z'),
    })

    expect(file.page).toBe('cart')
    expect(file.url).toBe('https://shop.example.com/cart')
    expect(file.anchors).toEqual([
      {
        target: '.pay-btn',
        patches: ['cart/A-001-pay.css'],
        fingerprint,
        firstSeenAt: '2026-09-15T10:00:00.000Z',
        lastMatchedAt: '2026-09-15T10:00:00.000Z',
        matched: 1,
      },
    ])
    expect(readPrototypeAnchors(workspaceRoot, SLUG, 'cart')).toEqual(file)
  })

  it('writes the shared scope to its own file', () => {
    recordPrototypeAnchors(workspaceRoot, SLUG, null, {
      url: null,
      observed: [{ target: '.banner', matched: 2, patches: ['A-001-banner.css'], fingerprint }],
    })

    expect(readPrototypeAnchors(workspaceRoot, SLUG, null)?.anchors).toHaveLength(1)
    expect(readAllPrototypeAnchors(workspaceRoot, SLUG).map((file) => file.page)).toEqual([null])
  })

  /**
   * The point of a *record*: a target that stopped matching keeps what it looked
   * like when it did. Replacing the fingerprint would erase the only evidence
   * that the page moved, and drift would be indistinguishable from a selector
   * that never worked.
   */
  it('keeps the fingerprint when a target stops matching', () => {
    recordPrototypeAnchors(workspaceRoot, SLUG, 'cart', {
      url: null,
      observed: [{ target: '.pay-btn', matched: 1, patches: ['cart/A-001-pay.css'], fingerprint }],
      now: new Date('2026-09-15T10:00:00Z'),
    })
    const after = recordPrototypeAnchors(workspaceRoot, SLUG, 'cart', {
      url: null,
      observed: [{ target: '.pay-btn', matched: 0, patches: ['cart/A-001-pay.css'], fingerprint: null }],
      now: new Date('2026-09-20T10:00:00Z'),
    })

    expect(after.anchors[0]?.matched).toBe(0)
    expect(after.anchors[0]?.fingerprint).toEqual(fingerprint)
    expect(after.anchors[0]?.lastMatchedAt).toBe('2026-09-15T10:00:00.000Z')
    expect(after.anchors[0]?.firstSeenAt).toBe('2026-09-15T10:00:00.000Z')
  })

  it('adds a new target without dropping the ones it did not observe', () => {
    recordPrototypeAnchors(workspaceRoot, SLUG, 'cart', {
      url: null,
      observed: [{ target: '.a', matched: 1, patches: [], fingerprint }],
    })
    const after = recordPrototypeAnchors(workspaceRoot, SLUG, 'cart', {
      url: null,
      observed: [{ target: '.b', matched: 1, patches: [], fingerprint }],
    })

    expect(after.anchors.map((anchor) => anchor.target)).toEqual(['.a', '.b'])
  })

  it('reports drift only when a target that once matched does not match now', () => {
    recordPrototypeAnchors(workspaceRoot, SLUG, 'cart', {
      url: null,
      observed: [{ target: '.pay-btn', matched: 1, patches: [], fingerprint }],
      now: new Date('2026-09-15T10:00:00Z'),
    })
    const file = readPrototypeAnchors(workspaceRoot, SLUG, 'cart')

    expect(
      resolveAnchorDrift(file, [{ target: '.pay-btn', matched: 0, patches: [], fingerprint: null }]).map(
        (anchor) => anchor.target,
      ),
    ).toEqual(['.pay-btn'])
    expect(resolveAnchorDrift(file, [{ target: '.pay-btn', matched: 1, patches: [], fingerprint }])).toEqual([])
    // No record at all is a selector that never worked, not drift.
    expect(resolveAnchorDrift(null, [{ target: '.pay-btn', matched: 0, patches: [], fingerprint: null }])).toEqual([])
  })

  it('names an anchor no patch declares any more', () => {
    recordPrototypeAnchors(workspaceRoot, SLUG, 'cart', {
      url: null,
      observed: [{ target: '.pay-btn', matched: 1, patches: ['cart/A-001-pay.css'], fingerprint }],
    })
    const files = readAllPrototypeAnchors(workspaceRoot, SLUG)

    expect(resolveAnchorOrphans(files, [patch('cart/A-001-pay.css', ['.pay-btn'], 'cart')]).orphaned).toEqual([])
    expect(resolveAnchorOrphans(files, []).orphaned.map((anchor) => anchor.target)).toEqual(['.pay-btn'])
  })

  it('drops the anchors a fold made moot', () => {
    recordPrototypeAnchors(workspaceRoot, SLUG, 'cart', {
      url: null,
      observed: [
        { target: '.a', matched: 1, patches: [], fingerprint },
        { target: '.b', matched: 1, patches: [], fingerprint },
      ],
    })

    const kept = dropPrototypeAnchors(workspaceRoot, SLUG, 'cart', ['.a'])

    expect(kept?.anchors.map((anchor) => anchor.target)).toEqual(['.b'])
  })

  it('reads an unreadable record as no record rather than failing', () => {
    const dir = getPrototypeAnchorsPath(workspaceRoot, SLUG)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'cart.json'), '{ not json', 'utf-8')

    expect(readPrototypeAnchors(workspaceRoot, SLUG, 'cart')).toBeNull()
    expect(readAllPrototypeAnchors(workspaceRoot, SLUG)).toEqual([])
  })
})

/**
 * The scripts run in a page, so the only thing worth checking here is that they
 * are self-contained expressions — a syntax error in one would be discovered by
 * whoever was looking at the page, as "the check silently stopped working".
 */
describe('anchor scripts', () => {
  it('compiles the probe', () => {
    expect(() => new Function(`return ${buildAnchorProbeScript(['.a', '.b'])}`)).not.toThrow()
  })

  it('compiles the candidate finder', () => {
    const script = buildAnchorCandidateScript([{ target: '.a', fingerprint }])
    expect(() => new Function(`return ${script}`)).not.toThrow()
  })
})
