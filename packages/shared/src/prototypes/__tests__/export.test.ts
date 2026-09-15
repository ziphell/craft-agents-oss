import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { buildDevSpec, buildSelfContainedHtml, exportPrototype, resolvePrototypeEntry } from '../export'
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

  it('prefers the exported deliverable when it exists', () => {
    mkdirSync(getPrototypeDistPath(workspaceRoot, slug), { recursive: true })
    writeFileSync(join(getPrototypeDistPath(workspaceRoot, slug), 'prototype.html'), BASE, 'utf-8')
    writeFileSync(join(getPrototypeDirPath(workspaceRoot, slug), 'base.html'), BASE, 'utf-8')

    const entry = resolvePrototypeEntry(workspaceRoot, slug)

    // With no host server the fully-applied document exists only as that file.
    expect(entry.kind).toBe('export')
    expect(entry.path.endsWith(join('dist', 'prototype.html'))).toBe(true)
    expect(entry.url.startsWith('file://')).toBe(true)
  })

  it('falls back to base.html when nothing has been exported', () => {
    writeFileSync(join(getPrototypeDirPath(workspaceRoot, slug), 'base.html'), BASE, 'utf-8')

    const entry = resolvePrototypeEntry(workspaceRoot, slug)

    expect(entry.kind).toBe('page')
    expect(entry.path.endsWith('base.html')).toBe(true)
  })

  /**
   * With a host serving prototypes, the address is the origin — not whichever
   * file happens to exist. That page is `base.html` rendered with every patch, so
   * pointing at a file would either drop the patches (raw base) or freeze the
   * document at export time, and neither is the prototype.
   */
  it('points at the origin once a host serves prototypes, even when an export exists', () => {
    mkdirSync(getPrototypeDistPath(workspaceRoot, slug), { recursive: true })
    writeFileSync(join(getPrototypeDistPath(workspaceRoot, slug), 'prototype.html'), BASE, 'utf-8')
    writeFileSync(join(getPrototypeDirPath(workspaceRoot, slug), 'base.html'), BASE, 'utf-8')
    setPrototypeBaseUrlResolver(() => 'http://checkout-flow-abc123ab.localhost:41234')

    const entry = resolvePrototypeEntry(workspaceRoot, slug)

    expect(entry.url).toBe('http://checkout-flow-abc123ab.localhost:41234')
    expect(entry.kind).toBe('page')
    expect(entry.path.endsWith('base.html')).toBe(true)
  })

  // The one case where the address cannot render: the source was deleted after
  // exporting. Serving the frozen file beats a dead end.
  it('falls back to the export through the origin when base.html is gone', () => {
    mkdirSync(getPrototypeDistPath(workspaceRoot, slug), { recursive: true })
    writeFileSync(join(getPrototypeDistPath(workspaceRoot, slug), 'prototype.html'), BASE, 'utf-8')
    setPrototypeBaseUrlResolver(() => 'http://checkout-flow-abc123ab.localhost:41234')

    const entry = resolvePrototypeEntry(workspaceRoot, slug)

    expect(entry.kind).toBe('export')
    expect(entry.url).toBe('http://checkout-flow-abc123ab.localhost:41234/dist/prototype.html')
  })

  it('refuses to open a prototype with neither file, naming both options', () => {
    expect(() => resolvePrototypeEntry(workspaceRoot, slug)).toThrow(/prototype-export/)
    expect(() => resolvePrototypeEntry(workspaceRoot, slug)).toThrow(/base\.html/)
  })
})
