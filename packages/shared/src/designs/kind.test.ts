import { describe, it, expect } from 'bun:test'
import { migrateDesignKind, resolveDesignKindState } from './kind.ts'

const DECK = { aspect: '4:3' as const, theme: 'swiss' }
const MOTION = { fps: 24, durationMs: 3000, aspect: '9:16' as const }

describe('designs/kind > resolveDesignKindState', () => {
  it('settles the kind from the settings, so giving parameters is saying what it is', () => {
    expect(resolveDesignKindState({ deck: DECK })).toEqual({ kind: 'deck', deck: DECK, motion: undefined })
    expect(resolveDesignKindState({ motion: MOTION })).toEqual({ kind: 'motion', deck: undefined, motion: MOTION })
    expect(resolveDesignKindState({})).toEqual({ kind: 'prototype', deck: undefined, motion: undefined })
  })

  it('keeps the kind a patch says nothing about — and takes the defaults when settings are cleared', () => {
    const current = { kind: 'deck' as const, deck: DECK }
    expect(resolveDesignKindState({ current })).toEqual({ kind: 'deck', deck: DECK, motion: undefined })
    expect(resolveDesignKindState({ deck: null, current })).toEqual({ kind: 'deck', deck: undefined, motion: undefined })
  })

  it('refuses a request that contradicts itself, with the reason', () => {
    expect(() => resolveDesignKindState({ deck: DECK, motion: MOTION })).toThrow(/one kind/)
    expect(() => resolveDesignKindState({ kind: 'prototype', deck: DECK })).toThrow(/deck design/)
    expect(() => resolveDesignKindState({ kind: 'deck', motion: MOTION })).toThrow(/motion design/)
  })

  it('drops the settings of the kind a design no longer is', () => {
    const current = { kind: 'deck' as const, deck: DECK }
    expect(resolveDesignKindState({ kind: 'motion', current })).toEqual({
      kind: 'motion',
      deck: undefined,
      motion: undefined,
    })
    expect(resolveDesignKindState({ kind: 'prototype', current })).toEqual({
      kind: 'prototype',
      deck: undefined,
      motion: undefined,
    })
  })
})

describe('designs/kind > migrateDesignKind', () => {
  it('settles a kind that was never stored, from the settings the file carries', () => {
    expect(migrateDesignKind({ deck: DECK }).config.kind).toBe('deck')
    expect(migrateDesignKind({ motion: MOTION }).config.kind).toBe('motion')
    expect(migrateDesignKind({ name: 'x' }).config.kind).toBe('prototype')
  })

  it('replaces the retired runtime kinds, which said nothing about what a design is', () => {
    // A retired kind is weak evidence: the settings describe the shape and win.
    expect(migrateDesignKind({ kind: 'live', motion: MOTION }).config.kind).toBe('motion')
    expect(migrateDesignKind({ kind: 'interactive', deck: DECK }).config.kind).toBe('deck')
    // On its own, `live` was the page-fed scenario a dashboard is.
    expect(migrateDesignKind({ kind: 'live' }).config.kind).toBe('dashboard')
    expect(migrateDesignKind({ kind: 'static' }).config.kind).toBe('prototype')
    expect(migrateDesignKind({ kind: 'static' }).notes.join(' ')).toContain('retired kind')
  })

  it('settles a scheduled design as a dashboard — that is what a dashboard is', () => {
    const settled = migrateDesignKind({ refresh: { cron: '*/15 * * * *', script: 's.ts' } })
    expect(settled.config.kind).toBe('dashboard')
  })

  it('keeps a kind it recognises and drops settings that do not belong to it', () => {
    const settled = migrateDesignKind({ kind: 'deck', deck: DECK, motion: MOTION })
    expect(settled.config.kind).toBe('deck')
    expect(settled.config.deck).toEqual(DECK)
    expect('motion' in settled.config).toBe(false)
    expect(settled.notes.length).toBeGreaterThan(0)
  })

  it('is quiet when the file already says one coherent thing', () => {
    expect(migrateDesignKind({ kind: 'motion', motion: MOTION }).notes).toEqual([])
  })
})
