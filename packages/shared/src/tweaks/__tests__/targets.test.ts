import { describe, expect, it } from 'bun:test'
import { extractTweakTargets, parseTweakHits, recordTweakHits, tweakTargets } from '../targets'
import type { TweakHits, TweakTargetHit } from '../types'

describe('extractTweakTargets', () => {
  it('reads the marker out of a comment, one selector per line', () => {
    const css = [
      '/* @target .cart-total */',
      '.cart-total { font-variant-numeric: tabular-nums; }',
      '/* @target [data-testid="order id"] */',
      '[data-testid="order id"] { font-weight: 600; }',
    ].join('\n')

    expect(extractTweakTargets(css, 'tweak.css')).toEqual([
      { selector: '.cart-total', file: 'tweak.css' },
      { selector: '[data-testid="order id"]', file: 'tweak.css' },
    ])
  })

  it('reads the marker in a JS comment too, and keeps the file it came from', () => {
    const js = ['// @target .row', 'document.querySelectorAll(".row")'].join('\n')

    expect(extractTweakTargets(js, 'tweak.js')).toEqual([{ selector: '.row', file: 'tweak.js' }])
  })

  // Same tolerance as anywhere else markers are read: prose is not a declaration.
  it('ignores a marker that is part of a word, and a value that is a note to self', () => {
    const css = ['not-a-@target-marker', '/* @target */', '/* @target TBD */', '/* @target .real */'].join('\n')

    expect(extractTweakTargets(css, 'tweak.css')).toEqual([{ selector: '.real', file: 'tweak.css' }])
  })

  it('lists each selector once', () => {
    const css = ['/* @target .x */', '/* @target .x */'].join('\n')

    expect(extractTweakTargets(css, 'tweak.css')).toHaveLength(1)
  })
})

describe('tweakTargets', () => {
  it('is every target across the files the tweak actually has', () => {
    expect(tweakTargets({ css: '/* @target .a */', js: '/* @target .b */' })).toEqual([
      { selector: '.a', file: 'tweak.css' },
      { selector: '.b', file: 'tweak.js' },
    ])
    expect(tweakTargets({ css: null, js: null })).toEqual([])
  })
})

describe('recordTweakHits', () => {
  const now = 1_700_000_000_000
  const targets: TweakTargetHit[] = [
    { selector: '.matched', file: 'tweak.css' },
    { selector: '.never', file: 'tweak.css' },
  ]

  it('records a time and an address for what matched', () => {
    const hits = recordTweakHits(null, targets, new Set(['.matched']), 'https://app.example.com/admin', now)

    expect(hits.targets[0]).toEqual({
      selector: '.matched',
      file: 'tweak.css',
      lastMatchedAt: now,
      lastMatchedUrl: 'https://app.example.com/admin',
    })
  })

  // The distinction this record exists for: absent means "never matched", a time with no
  // new one means "it used to, and the page moved".
  it('keeps the last time a target matched, and gives a never-matched one none at all', () => {
    const first = recordTweakHits(null, targets, new Set(['.matched']), 'https://app.example.com/admin', now)
    const second = recordTweakHits(first, targets, new Set(), 'https://app.example.com/admin', now + 1000)

    expect(second.targets[0]?.lastMatchedAt).toBe(now)
    expect(second.targets[1]?.lastMatchedAt).toBeUndefined()
    expect(second.updatedAt).toBe(now + 1000)
  })

  it('follows a target that moved to the other file', () => {
    const before: TweakHits = {
      schemaVersion: 1,
      updatedAt: now,
      targets: [{ selector: '.moved', file: 'tweak.css', lastMatchedAt: now, lastMatchedUrl: 'https://x.test/' }],
    }
    const after = recordTweakHits(
      before,
      [{ selector: '.moved', file: 'tweak.js' }],
      new Set(),
      'https://x.test/',
      now + 1,
    )

    expect(after.targets[0]).toEqual({
      selector: '.moved',
      file: 'tweak.js',
      lastMatchedAt: now,
      lastMatchedUrl: 'https://x.test/',
    })
  })
})

describe('parseTweakHits', () => {
  it('reads a record, and treats a damaged one as no record', () => {
    expect(parseTweakHits('{"schemaVersion":1,"updatedAt":1,"targets":[]}')).toEqual({
      schemaVersion: 1,
      updatedAt: 1,
      targets: [],
    })
    // Evidence that cannot be read is silence, not a failure of whatever asked.
    expect(parseTweakHits('{ not json')).toBeNull()
    expect(parseTweakHits('{"nope":true}')).toBeNull()
  })
})
