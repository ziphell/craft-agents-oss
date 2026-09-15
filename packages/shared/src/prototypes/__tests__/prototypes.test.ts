import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { getPrototypePatchesPath, loadPrototypeArtifacts, scanPrototypePatches } from '../storage'
import { buildPatchInitScript, buildPatchStyleElementId } from '../patch-script'
import type { PrototypePatch } from '../types'

describe('prototype patch index', () => {
  const slug = 'checkout-flow'
  let workspaceRoot = ''
  let patchesDir = ''

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-prototypes-'))
    patchesDir = getPrototypePatchesPath(workspaceRoot, slug)
    mkdirSync(patchesDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('orders patches deterministically by lane, then declared order, then name', () => {
    writeFileSync(join(patchesDir, 'B-002-second.js'), 'window.b = 2')
    writeFileSync(join(patchesDir, 'A-002-again.css'), '.again{}')
    writeFileSync(join(patchesDir, 'A-001-first.css'), '.first{}')

    const patches = scanPrototypePatches(workspaceRoot, slug)

    expect(patches.map((patch) => patch.file)).toEqual([
      'A-001-first.css',
      'A-002-again.css',
      'B-002-second.js',
    ])
    expect(patches[0]?.kind).toBe('css')
    expect(patches[0]?.lane).toBe('A')
    expect(patches[0]?.order).toBe(1)
    expect(patches[2]?.kind).toBe('js')
    expect(patches[2]?.lane).toBe('B')
    expect(patches[0]?.key).toBe(`prototype:${slug}:A-001-first.css`)
    expect(patches[0]?.source).toBe('.first{}')
  })

  it('ignores files that do not follow the naming convention', () => {
    writeFileSync(join(patchesDir, 'A-001-ok.css'), '.ok{}')
    writeFileSync(join(patchesDir, 'README.md'), 'notes')
    writeFileSync(join(patchesDir, 'notes.css'), '.nope{}')
    writeFileSync(join(patchesDir, 'A-001-ok.ts'), 'no')
    writeFileSync(join(patchesDir, '.DS_Store'), '')

    expect(scanPrototypePatches(workspaceRoot, slug).map((patch) => patch.file)).toEqual(['A-001-ok.css'])
  })

  it('returns an empty index when the prototype has no patches directory', () => {
    expect(scanPrototypePatches(workspaceRoot, 'missing-prototype')).toEqual([])
  })

  it('exposes the derived index through loadPrototypeArtifacts', () => {
    writeFileSync(join(patchesDir, 'A-001-ok.css'), '.ok{}')

    const artifacts = loadPrototypeArtifacts(workspaceRoot, slug)

    expect(artifacts.slug).toBe(slug)
    expect(artifacts.dir.endsWith(slug)).toBe(true)
    expect(artifacts.patches).toHaveLength(1)
  })
})

describe('buildPatchInitScript', () => {
  const cssPatch: PrototypePatch = {
    file: 'A-001-btn.css',
    kind: 'css',
    lane: 'A',
    order: 1,
    source: '.btn { border-radius: 12px }',
    key: 'prototype:checkout-flow:A-001-btn.css',
  }

  it('produces a syntactically valid css init script carrying the raw css', () => {
    const script = buildPatchInitScript(cssPatch)

    expect(() => new Function(script)).not.toThrow()
    expect(script).toContain(JSON.stringify(cssPatch.source))
    expect(script).toContain('createElement')
  })

  it('derives a DOM-safe style element id from the file name', () => {
    expect(buildPatchStyleElementId(cssPatch)).toBe('__craft_patch_A-001-btn_css')
    expect(buildPatchStyleElementId({ ...cssPatch, file: 'A-001-a b/c.css' })).toBe('__craft_patch_A-001-a_b_c_css')
  })

  it('wraps js patches in an IIFE with a catch so one failure cannot abort the rest', () => {
    const script = buildPatchInitScript({
      ...cssPatch,
      file: 'A-002-guard.js',
      kind: 'js',
      source: 'window.guard = true;',
    })

    expect(() => new Function(script)).not.toThrow()
    expect(script).toContain('window.guard = true;')
    expect(script).toContain('catch')
    expect(script).toContain('A-002-guard.js')
  })

  it('keeps a js patch ending in a line comment compilable', () => {
    // The closing brace must not be swallowed by the trailing line comment.
    const script = buildPatchInitScript({
      ...cssPatch,
      file: 'A-003-comment.js',
      kind: 'js',
      source: '// just a comment',
    })

    expect(() => new Function(script)).not.toThrow()
  })

  it('keeps a css patch ending in a line comment from breaking the wrapper', () => {
    const script = buildPatchInitScript({ ...cssPatch, source: '.a{} /* trailing' })
    expect(() => new Function(script)).not.toThrow()
  })

  /**
   * These scripts get concatenated — into one `<script>` in the self-contained
   * page, into one bundle for the overlay preview. Two js patches in a row used
   * to parse as a call chain on the first patch's *result*, so the first ran and
   * everything after it silently did not.
   */
  it('terminates itself, so two scripts in a row both run', () => {
    const patch = (file: string) =>
      buildPatchInitScript({ ...cssPatch, file, kind: 'js', source: 'state.value += 1;' })

    const state = { value: 0 }
    new Function('state', `${patch('A-001-one.js')}\n${patch('A-002-two.js')}`)(state)

    expect(state.value).toBe(2)
  })
})
