import { describe, expect, it } from 'bun:test'
import { TWEAK_RUN_AT_DEFAULT, tweakRunAt } from '../run-at'

const sources = (css: string | null, js: string | null) => ({ css, js })

describe('tweakRunAt', () => {
  it('reads the moment the tweak declares, from either file', () => {
    expect(tweakRunAt(sources(null, '// @run-at document_start\nwindow.__x = 1'))).toBe('document_start')
    expect(tweakRunAt(sources('.a{}', '/* @run-at document_idle */'))).toBe('document_idle')
    // A tweak with no javascript has no moment to declare, but a declaration in the stylesheet
    // is still read rather than silently ignored.
    expect(tweakRunAt(sources('/* @run-at document_start */\n.a{}', null))).toBe('document_start')
  })

  it('lets tweak.js say it over tweak.css', () => {
    expect(tweakRunAt(sources('/* @run-at document_start */', '/* @run-at document_idle */'))).toBe('document_idle')
  })

  it('runs at document_end when the tweak declares nothing', () => {
    expect(TWEAK_RUN_AT_DEFAULT).toBe('document_end')
    expect(tweakRunAt(sources('.a{}', 'void 0'))).toBe('document_end')
    expect(tweakRunAt(sources(null, null))).toBe('document_end')
  })

  it('falls back to the default for a value that is not one of the three moments', () => {
    expect(tweakRunAt(sources(null, '/* @run-at dom-ready */'))).toBe('document_end')
  })

  it('does not read a marker that is part of a word', () => {
    expect(tweakRunAt(sources(null, '// see not-a-@run-at-marker'))).toBe('document_end')
  })
})
