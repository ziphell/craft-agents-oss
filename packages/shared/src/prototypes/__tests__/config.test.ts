import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  DEFAULT_PROTOTYPE_KIND,
  getPrototypeConfigPath,
  getPrototypeDirPath,
  readPrototypeConfig,
  writePrototypeConfig,
} from '..'

const SLUG = 'checkout-flow'

function makePrototype(): string {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-prototype-config-'))
  mkdirSync(getPrototypeDirPath(workspaceRoot, SLUG), { recursive: true })
  return workspaceRoot
}

describe('readPrototypeConfig', () => {
  let workspaceRoot = ''

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('falls back to overlay when the prototype has no config', () => {
    workspaceRoot = makePrototype()
    // Every prototype created before kinds existed was built around capturing a
    // real page, so overlay is the honest default rather than a guess.
    expect(readPrototypeConfig(workspaceRoot, SLUG)).toEqual({ kind: DEFAULT_PROTOTYPE_KIND })
  })

  it('reads a written config back', () => {
    workspaceRoot = makePrototype()
    writePrototypeConfig(workspaceRoot, SLUG, { kind: 'overlay', targetUrl: 'https://app.example.com/x' })
    expect(readPrototypeConfig(workspaceRoot, SLUG)).toEqual({
      kind: 'overlay',
      targetUrl: 'https://app.example.com/x',
    })
  })

  // This file can be edited by hand or by another process, so a broken one is
  // expected rather than exceptional — it must not make the prototype unusable.
  it('falls back to overlay on malformed JSON instead of throwing', () => {
    workspaceRoot = makePrototype()
    writeFileSync(getPrototypeConfigPath(workspaceRoot, SLUG), '{ not json', 'utf-8')
    expect(readPrototypeConfig(workspaceRoot, SLUG)).toEqual({ kind: DEFAULT_PROTOTYPE_KIND })
  })

  it('falls back to overlay on an unknown kind', () => {
    workspaceRoot = makePrototype()
    writeFileSync(getPrototypeConfigPath(workspaceRoot, SLUG), JSON.stringify({ kind: 'nonsense' }), 'utf-8')
    expect(readPrototypeConfig(workspaceRoot, SLUG)).toEqual({ kind: DEFAULT_PROTOTYPE_KIND })
  })

  it('ignores a non-string targetUrl', () => {
    workspaceRoot = makePrototype()
    writeFileSync(getPrototypeConfigPath(workspaceRoot, SLUG), JSON.stringify({ kind: 'overlay', targetUrl: 42 }), 'utf-8')
    expect(readPrototypeConfig(workspaceRoot, SLUG)).toEqual({ kind: 'overlay' })
  })

  it('reads references back', () => {
    workspaceRoot = makePrototype()
    writePrototypeConfig(workspaceRoot, SLUG, { kind: 'scratch', references: ['rival-checkout'] })
    expect(readPrototypeConfig(workspaceRoot, SLUG)).toEqual({
      kind: 'scratch',
      references: ['rival-checkout'],
    })
  })

  // A reference says "study something else", so pointing at yourself is
  // contradictory rather than merely useless.
  it('drops a self-reference', () => {
    workspaceRoot = makePrototype()
    writeFileSync(
      getPrototypeConfigPath(workspaceRoot, SLUG),
      JSON.stringify({ kind: 'scratch', references: [SLUG, 'rival-checkout'] }),
      'utf-8',
    )
    expect(readPrototypeConfig(workspaceRoot, SLUG).references).toEqual(['rival-checkout'])
  })

  it('ignores a references value that is not an array', () => {
    workspaceRoot = makePrototype()
    writeFileSync(
      getPrototypeConfigPath(workspaceRoot, SLUG),
      JSON.stringify({ kind: 'scratch', references: 'rival-checkout' }),
      'utf-8',
    )
    expect(readPrototypeConfig(workspaceRoot, SLUG)).toEqual({ kind: 'scratch' })
  })

  it('drops blank and non-string entries, and de-duplicates', () => {
    workspaceRoot = makePrototype()
    writeFileSync(
      getPrototypeConfigPath(workspaceRoot, SLUG),
      JSON.stringify({ kind: 'scratch', references: [' a ', 'a', '', 7, null, 'b'] }),
      'utf-8',
    )
    expect(readPrototypeConfig(workspaceRoot, SLUG).references).toEqual(['a', 'b'])
  })
})

describe('writePrototypeConfig', () => {
  let workspaceRoot = ''

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('drops targetUrl for a scratch prototype', () => {
    workspaceRoot = makePrototype()
    // A scratch prototype has no external page, so recording a URL would be a lie.
    writePrototypeConfig(workspaceRoot, SLUG, { kind: 'scratch', targetUrl: 'https://app.example.com/x' })
    expect(readPrototypeConfig(workspaceRoot, SLUG)).toEqual({ kind: 'scratch' })
  })

  it('omits a blank targetUrl rather than storing whitespace', () => {
    workspaceRoot = makePrototype()
    writePrototypeConfig(workspaceRoot, SLUG, { kind: 'overlay', targetUrl: '   ' })
    expect(readPrototypeConfig(workspaceRoot, SLUG)).toEqual({ kind: 'overlay' })
  })

  it('omits an empty references list rather than writing an empty array', () => {
    workspaceRoot = makePrototype()
    writePrototypeConfig(workspaceRoot, SLUG, { kind: 'scratch', references: [] })
    expect(readPrototypeConfig(workspaceRoot, SLUG)).toEqual({ kind: 'scratch' })
  })
})
