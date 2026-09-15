import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { buildDevSpec, buildInlinedPatchProbeScript, buildSelfContainedHtml, exportPrototype, INLINED_PATCHES_ELEMENT_ID, resolvePrototypeEntry } from '../export'
import { setPrototypeBaseUrlResolver } from '../url'
import { getPrototypeDistPath, getPrototypePatchesPath, getPrototypeDirPath } from '../storage'
import type { PrototypePatch } from '../types'

const cssPatch: PrototypePatch = {
  file: 'A-001-btn.css',
  kind: 'css',
  lane: 'A',
  order: 1,
  source: '.btn { color: red }',
  key: 'k1',
}

const jsPatch: PrototypePatch = {
  file: 'A-002-guard.js',
  kind: 'js',
  lane: 'A',
  order: 2,
  source: 'window.guard = true;',
  key: 'k2',
}

const BASE = '<!doctype html><html><head><meta charset="utf-8"></head><body><button>Pay</button></body></html>'

describe('buildSelfContainedHtml', () => {
  it('inlines css into head and js before the closing body tag', () => {
    const html = buildSelfContainedHtml(BASE, [cssPatch, jsPatch])

    expect(html).toContain('<style id="__craft_prototype_patches__">')
    expect(html).toContain('.btn { color: red }')
    expect(html).toContain('A-001-btn.css')
    expect(html).toContain('<script>')
    expect(html).toContain('window.guard = true;')

    // css must land before </head>, js before </body>
    expect(html.indexOf('<style')).toBeLessThan(html.indexOf('</head>'))
    expect(html.indexOf('<script>')).toBeLessThan(html.indexOf('</body>'))
  })

  it('preserves replay order inside a block', () => {
    const first = { ...cssPatch, file: 'A-001-first.css', source: '.first{}' }
    const second = { ...cssPatch, file: 'A-002-second.css', source: '.second{}' }

    const html = buildSelfContainedHtml(BASE, [first, second])

    expect(html.indexOf('.first{}')).toBeLessThan(html.indexOf('.second{}'))
  })

  it('returns the base untouched when there are no patches', () => {
    expect(buildSelfContainedHtml(BASE, [])).toBe(BASE)
  })

  it('falls back to appending when the base has no head or body tag', () => {
    const html = buildSelfContainedHtml('<div>fragment</div>', [cssPatch, jsPatch])

    expect(html).toContain('<div>fragment</div>')
    expect(html).toContain('.btn { color: red }')
    expect(html).toContain('window.guard = true;')
  })

  it('emits executable js for a patch ending in a line comment', () => {
    const html = buildSelfContainedHtml(BASE, [{ ...jsPatch, source: '// just a comment' }])
    const start = html.indexOf('<script>') + '<script>'.length
    const script = html.slice(start, html.indexOf('</script>'))

    expect(() => new Function(script)).not.toThrow()
  })

  /**
   * The marker is the whole basis for not applying patches twice to a page that
   * already has them, so it must be present exactly when patches were inlined.
   */
  it('records the patches it inlined, and stays out when it inlined none', () => {
    const html = buildSelfContainedHtml(BASE, [cssPatch, jsPatch])

    const start = html.indexOf(`id="${INLINED_PATCHES_ELEMENT_ID}"`)
    expect(start).toBeGreaterThan(-1)
    const payload = html.slice(html.indexOf('>', start) + 1, html.indexOf('</script>', start))
    expect(JSON.parse(payload)).toEqual(['A-001-btn.css', 'A-002-guard.js'])

    // No patches inlined means nothing to record — and a base page must not claim
    // otherwise, or the injector would skip patches the page never had.
    expect(buildSelfContainedHtml(BASE, [])).not.toContain(INLINED_PATCHES_ELEMENT_ID)
  })

  it('keeps the marker even when the base has no head or body tag', () => {
    expect(buildSelfContainedHtml('<div>fragment</div>', [cssPatch])).toContain(INLINED_PATCHES_ELEMENT_ID)
  })
})

describe('buildInlinedPatchProbeScript', () => {
  /** Run the probe against a stand-in for `document`. */
  function probeWith(payload: string | null): unknown {
    const element = payload === null ? null : { textContent: payload }
    return new Function('document', `return ${buildInlinedPatchProbeScript()}`)({
      getElementById: () => element,
    })
  }

  // Every unreadable shape has to mean "nothing known is applied": the other
  // answer would skip work on a page that never had it done.
  it('reads the list back, and treats every unreadable document as untouched', () => {
    expect(probeWith('["A-001-btn.css"]')).toEqual(['A-001-btn.css'])
    expect(probeWith(null)).toEqual([])
    expect(probeWith('not json')).toEqual([])
    expect(probeWith('{"a":1}')).toEqual([])
    expect(probeWith('["ok.css", 7, null]')).toEqual(['ok.css'])
  })
})

describe('buildDevSpec', () => {
  it('lists patches in order and includes their content', () => {
    const spec = buildDevSpec('checkout-flow', [cssPatch, jsPatch])

    expect(spec).toContain('# Prototype change spec — checkout-flow')
    expect(spec).toContain('| 1 | `A-001-btn.css` | A | css |')
    expect(spec).toContain('## 2. `A-002-guard.js`')
    expect(spec).toContain('window.guard = true;')
  })

  it('reports when there are no patches', () => {
    expect(buildDevSpec('empty', [])).toContain('_No patches._')
  })

  it('does not let backticks in a patch break the code fence', () => {
    const sourceWithBackticks = 'const t = `a`; const u = ```b```;'
    const spec = buildDevSpec('fences', [{ ...jsPatch, source: sourceWithBackticks }])

    // Longest run inside the source is 3, so the fence must be 4 backticks.
    expect(spec).toContain('````javascript')
    expect(spec).toContain(sourceWithBackticks)
  })
})

describe('exportPrototype', () => {
  const slug = 'checkout-flow'
  let workspaceRoot = ''
  let prototypeDir = ''
  let patchesDir = ''

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-prototype-export-'))
    prototypeDir = getPrototypeDirPath(workspaceRoot, slug)
    patchesDir = getPrototypePatchesPath(workspaceRoot, slug)
    mkdirSync(patchesDir, { recursive: true })
    writeFileSync(join(prototypeDir, 'base.html'), BASE)
    writeFileSync(join(patchesDir, 'A-001-btn.css'), '.btn{}')
  })

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('writes a self-contained HTML and a dev spec into dist/', () => {
    const result = exportPrototype(workspaceRoot, slug)

    expect(result.applied).toBe(1)
    expect(existsSync(result.htmlPath)).toBe(true)
    expect(existsSync(result.specPath)).toBe(true)
    expect(result.htmlPath.endsWith(join('dist', 'prototype.html'))).toBe(true)
    expect(result.specPath.endsWith(join('dist', 'dev-spec.md'))).toBe(true)
    expect(result.htmlUrl.startsWith('file://')).toBe(true)

    const html = readFileSync(result.htmlPath, 'utf-8')
    expect(html).toContain('.btn{}')
    expect(html).toContain('<button>Pay</button>')

    const spec = readFileSync(result.specPath, 'utf-8')
    expect(spec).toContain('A-001-btn.css')
  })

  it('refuses to export a prototype with no base.html', () => {
    rmSync(join(prototypeDir, 'base.html'))

    expect(() => exportPrototype(workspaceRoot, slug)).toThrow(/no base\.html/)
  })
})

describe('resolvePrototypeEntry', () => {
  const slug = 'checkout-flow'
  const ORIGIN = 'http://checkout-flow-abc123ab.localhost:41234'
  let workspaceRoot = ''

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-prototype-entry-'))
    mkdirSync(getPrototypeDirPath(workspaceRoot, slug), { recursive: true })
  })

  afterEach(() => {
    // The resolver is process-global; leaving one installed would leak into every
    // later test in this file.
    setPrototypeBaseUrlResolver(null)
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  function writeBase(): void {
    writeFileSync(join(getPrototypeDirPath(workspaceRoot, slug), 'base.html'), BASE, 'utf-8')
  }

  function writeExport(): void {
    const distDir = getPrototypeDistPath(workspaceRoot, slug)
    mkdirSync(distDir, { recursive: true })
    writeFileSync(join(distDir, 'prototype.html'), BASE, 'utf-8')
  }

  it('points at the origin, which is the page with every patch applied', () => {
    writeBase()
    setPrototypeBaseUrlResolver(() => ORIGIN)

    const entry = resolvePrototypeEntry(workspaceRoot, slug)

    expect(entry.url).toBe(ORIGIN)
    expect(entry.path.endsWith('base.html')).toBe(true)
  })

  /**
   * The deliverable is a snapshot of an earlier state, and opening it hands back
   * a document you cannot go on editing. It stays reachable by name; it is never
   * the entry.
   */
  it('ignores an exported deliverable even when one exists', () => {
    writeBase()
    writeExport()
    setPrototypeBaseUrlResolver(() => ORIGIN)

    const entry = resolvePrototypeEntry(workspaceRoot, slug)

    expect(entry.url).toBe(ORIGIN)
    expect(entry.path.endsWith('base.html')).toBe(true)
  })

  it('refuses an export-only prototype: a deliverable is not a page', () => {
    writeExport()
    setPrototypeBaseUrlResolver(() => ORIGIN)

    expect(() => resolvePrototypeEntry(workspaceRoot, slug)).toThrow(/nothing to render/)
  })

  it('refuses to open a prototype with no base page, naming every way to get one', () => {
    setPrototypeBaseUrlResolver(() => ORIGIN)

    expect(() => resolvePrototypeEntry(workspaceRoot, slug)).toThrow(/base\.html/)
    expect(() => resolvePrototypeEntry(workspaceRoot, slug)).toThrow(/capture a real page/)
    expect(() => resolvePrototypeEntry(workspaceRoot, slug)).toThrow(/import another prototype/)
  })

  // No rendering host means no address shows the patches at all: a `file://` page
  // would be the raw base, which is exactly the thing this refuses to hand out.
  it('refuses rather than falling back to file:// when nothing serves prototypes', () => {
    writeBase()

    expect(() => resolvePrototypeEntry(workspaceRoot, slug)).toThrow(/No host is serving prototypes/)
  })
})
