import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  getPrototypeDirPath,
  getPrototypePatchesPath,
  getPrototypePagePatchesPath,
  listPrototypeFiles,
  listPrototypePatchPages,
  loadPrototypeArtifacts,
  scanPrototypePatches,
  scanPrototypePatchesForPage,
} from '../storage'
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

  it('orders patches deterministically by declared order, then name', () => {
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
    expect(patches[0]?.writer).toBe('A')
    expect(patches[0]?.order).toBe(1)
    expect(patches[2]?.kind).toBe('js')
    expect(patches[2]?.writer).toBe('B')
    expect(patches[0]?.key).toBe(`prototype:${slug}:A-001-first.css`)
    expect(patches[0]?.source).toBe('.first{}')
    // A patch at the root of `patches/` belongs to every page (plan §19.4).
    expect(patches[0]?.page).toBeNull()
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

  /**
   * The directory is the ownership rule (plan §19.4): `patches/*` is shared by
   * every page, `patches/<page>/*` belongs to that page alone. Both are the same
   * mechanism, so the root's meaning is unchanged from before pages had names.
   */
  describe('scoping a patch to a page', () => {
    beforeEach(() => {
      writeFileSync(join(patchesDir, 'A-001-shared.css'), '.shared{}')
      mkdirSync(join(patchesDir, 'cart'), { recursive: true })
      writeFileSync(join(patchesDir, 'cart', 'A-001-total.css'), '.total{}')
    })

    it('reports the page a patch belongs to, and null for a shared one', () => {
      const patches = scanPrototypePatches(workspaceRoot, slug)

      expect(patches.map((patch) => `${patch.file}:${patch.page}`)).toEqual([
        'A-001-shared.css:null',
        'cart/A-001-total.css:cart',
      ])
      // The reported path is relative to `patches/`, so two pages can each have an
      // `A-001-*.css` without their registrations colliding.
      expect(patches[1]?.key).toBe(`prototype:${slug}:cart/A-001-total.css`)
    })

    it('hands one page the shared patches plus its own, and nothing else', () => {
      expect(scanPrototypePatchesForPage(workspaceRoot, slug, 'cart').map((patch) => patch.file))
        .toEqual(['A-001-shared.css', 'cart/A-001-total.css'])
      expect(scanPrototypePatchesForPage(workspaceRoot, slug, 'orders').map((patch) => patch.file))
        .toEqual(['A-001-shared.css'])
      // A page nobody has patches for still carries the shared ones.
      expect(scanPrototypePatchesForPage(workspaceRoot, slug, 'nope').map((patch) => patch.file))
        .toEqual(['A-001-shared.css'])
    })

    // The listing is names only: a directory is a scope, and whether it names a
    // real page is the status report's question (`pageIssues`).
    it('lists the patch directories, valid page names or not', () => {
      expect(listPrototypePatchPages(workspaceRoot, slug)).toEqual(['cart'])

      mkdirSync(getPrototypePagePatchesPath(workspaceRoot, slug, 'nope'), { recursive: true })
      expect(listPrototypePatchPages(workspaceRoot, slug)).toEqual(['cart', 'nope'])
    })
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
    writer: 'A',
    order: 1,
    source: '.btn { border-radius: 12px }',
    targets: [],
    page: null,
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
   * page, into one bundle for a live page. Two js patches in a row used to parse
   * as a call chain on the first patch's *result*, so the first ran and
   * everything after it silently did not.
   */
  it('terminates itself, so two scripts in a row both run', () => {
    const patch = (file: string) =>
      buildPatchInitScript({ ...cssPatch, file, kind: 'js', source: 'state.value += 1;' })

    const state = { value: 0 }
    // `window` is where a patch records what it observed about itself (§21.1), so
    // the sandbox has to provide one — the same object the page would have.
    new Function('state', 'window', `${patch('A-001-one.js')}\n${patch('A-002-two.js')}`)(state, {})

    expect(state.value).toBe(2)
  })
})

/**
 * The prototype's own directory is a folder of the author's files, and the workbench lists it
 * as one: no extension rule, no ownership rule, and nothing above the directory's own level.
 */
describe('listPrototypeFiles', () => {
  const slug = 'checkout-flow'
  let workspaceRoot = ''
  let dir = ''

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-prototype-files-'))
    dir = getPrototypeDirPath(workspaceRoot, slug)
    mkdirSync(dir, { recursive: true })
  })

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('lists every file in any format, and picks the brief out of them', () => {
    writeFileSync(join(dir, 'PRD.md'), '## R-001 A cart holds its line\n', 'utf-8')
    writeFileSync(join(dir, 'personas.md'), '# who this is for\n', 'utf-8')
    // Not prose: a format the workbench never reads is still a file of this prototype.
    writeFileSync(join(dir, 'mock.png'), 'not really a png')
    writeFileSync(join(dir, 'flows.xlsx'), 'not really a workbook')

    const listed = listPrototypeFiles(workspaceRoot, slug, 'PRD.md')

    expect(listed.entry).toEqual({ name: 'PRD.md', path: join(dir, 'PRD.md') })
    expect(listed.files.map((file) => file.name)).toEqual(['flows.xlsx', 'mock.png', 'personas.md'])
    expect(listed.files[0]?.path).toBe(join(dir, 'flows.xlsx'))
  })

  it('skips hidden files, and lists files rather than directories', () => {
    writeFileSync(join(dir, 'PRD.md'), '## R-001 x\n', 'utf-8')
    writeFileSync(join(dir, '.DS_Store'), '')
    writeFileSync(join(dir, 'notes.txt'), 'scratch')
    mkdirSync(join(dir, 'assets'), { recursive: true })
    writeFileSync(join(dir, 'assets', 'app.css'), '.a{}')

    const listed = listPrototypeFiles(workspaceRoot, slug, 'PRD.md')

    expect(listed.files.map((file) => file.name)).toEqual(['notes.txt'])
  })

  it('has no entry, and still lists what is there, before the brief is written', () => {
    writeFileSync(join(dir, 'sketches.pdf'), 'not really a pdf')

    expect(listPrototypeFiles(workspaceRoot, slug, 'PRD.md')).toEqual({
      entry: null,
      files: [{ name: 'sketches.pdf', path: join(dir, 'sketches.pdf') }],
    })
  })

  it('answers an empty directory rather than failing when it is gone', () => {
    expect(listPrototypeFiles(join(tmpdir(), 'craft-does-not-exist'), 'gone', 'PRD.md')).toEqual({
      entry: null,
      files: [],
    })
  })
})
