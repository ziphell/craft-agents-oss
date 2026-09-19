import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import {
  buildDevSpec,
  buildInlinedPatchProbeScript,
  buildSelfContainedHtml,
  buildStaticPage,
  exportPrototype,
  INLINED_PATCHES_ELEMENT_ID,
  resolvePrototypeEntry,
} from '../export'
import type { MockProgram } from '../mock-engine'
import { setPrototypeBaseUrlResolver } from '../url'
import {
  createPrototype,
  getPrototypeDirPath,
  getPrototypeDistPath,
  getPrototypePatchesPath,
  writePrototypeConfig,
  writePrototypePage,
  type PrototypePage,
  type PrototypePageEntry,
  type PrototypePatch,
} from '..'

const cssPatch: PrototypePatch = {
  file: 'A-001-btn.css',
  kind: 'css',
  writer: 'A',
  order: 1,
  source: '.btn { color: red }',
  targets: [],
  page: null,
  key: 'k1',
}

const jsPatch: PrototypePatch = {
  file: 'A-002-guard.js',
  kind: 'js',
  writer: 'A',
  order: 2,
  source: 'window.guard = true;',
  targets: [],
  page: null,
  key: 'k2',
}

const cartPage: PrototypePage = {
  name: 'cart',
  kind: 'scratch',
  file: 'cart.html',
  url: 'http://checkout-flow-abc123ab.localhost:41234/cart.html',
  entry: true,
  useLayout: true,
}

const payPage: PrototypePage = {
  name: 'pay',
  kind: 'overlay',
  file: null,
  url: 'https://app.example.com/pay',
  entry: false,
  useLayout: false,
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
    const script = html.slice(start, html.indexOf('</script>', start))

    expect(() => new Function(script)).not.toThrow()
  })

  /**
   * Every js patch lands in the same `<script>`. When the transform did not
   * terminate its statements, the second one was swallowed by a call chain on the
   * first one's result: the exported page ran the first patch and skipped the
   * rest, without an error anywhere.
   */
  it('runs every js patch in the page, not just the first', () => {
    const first = { ...jsPatch, file: 'A-001-one.js', source: 'state.value += 1;' }
    const second = { ...jsPatch, file: 'A-002-two.js', source: 'state.value += 10;' }
    const html = buildSelfContainedHtml(BASE, [first, second])
    // From the script's own end tag, not the first one in the document: the
    // inlined-patches marker is a `<script>` too.
    const start = html.indexOf('<script>') + '<script>'.length
    const script = html.slice(start, html.indexOf('</script>', start))

    const state = { value: 0 }
    new Function('state', 'window', script)(state, {})

    expect(state.value).toBe(11)
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

/**
 * The static deliverable (plan §17.8): one page of ours, as a file that carries
 * everything it needs. The transform is the preview's, so what it adds here is
 * only what a preview gets from the host — the mock layer, and a directory to
 * resolve a reference against.
 */
describe('buildStaticPage', () => {
  const mocks: MockProgram = { routes: [{ method: 'GET', path: '/orders', status: 200, body: [{ id: 1 }] }], store: {} }
  /** A page with no references of its own, so the tests are about what is added. */
  const resolveNothing: () => { kind: 'sibling' } = () => ({ kind: 'sibling' })

  it('carries this page’s patches, and never another page’s', () => {
    const { html } = buildStaticPage({
      page: 'cart',
      document: BASE,
      patches: [cssPatch, jsPatch, { ...jsPatch, file: 'other-page.js', page: 'pay' }],
      resolveAsset: resolveNothing,
    })

    expect(html).toContain('<style id="__craft_prototype_patches__">')
    expect(html).toContain('window.guard = true;')
    // A patch under `patches/pay/` belongs to that page (plan §19.4).
    expect(html).not.toContain('other-page.js')
  })

  it('installs the mock layer before the page’s own code runs', () => {
    const { html } = buildStaticPage({
      page: 'cart',
      document: BASE,
      patches: [jsPatch],
      mocks,
      resolveAsset: resolveNothing,
    })

    // The order is the point: a page whose code captured `fetch` before the mock
    // layer installed would keep talking to the network.
    expect(html).toContain('window.fetch = async')
    expect(html.indexOf('window.fetch = async')).toBeLessThan(html.indexOf('window.guard = true;'))
  })

  it('leaves the document alone when there is nothing to add', () => {
    const { html, warnings } = buildStaticPage({
      page: 'cart',
      document: BASE,
      patches: [],
      resolveAsset: resolveNothing,
    })

    expect(html).toBe(BASE)
    expect(warnings).toEqual([])
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

/**
 * The change list a developer reads (plan §19.8): grouped by page, because that
 * is the question they arrive with — "what does this flow change, screen by
 * screen" — and because the patch directories are exactly that grouping (§19.4).
 */
describe('buildDevSpec', () => {
  const shared = { ...cssPatch, file: 'A-001-shared.css', page: null }
  const carts = { ...jsPatch, file: 'B-002-total.js', page: 'cart' }

  it('lists the flow, then the patches grouped by the page they belong to', () => {
    const spec = buildDevSpec('checkout-flow', { pages: [cartPage, payPage], patches: [shared, carts] })

    expect(spec).toContain('# Prototype change spec — checkout-flow')
    expect(spec).toContain('| 1 | `cart` | scratch | http://checkout-flow-abc123ab.localhost:41234/cart.html | yes |')
    expect(spec).toContain('| 2 | `pay` | overlay | https://app.example.com/pay | — |')
    expect(spec).toContain('The address root opens `cart`.')
    expect(spec).toContain('`patches/*` repeats on every page; `patches/<page>/*` belongs to that page only.')

    expect(spec).toContain('### Shared (every page)')
    expect(spec).toContain('#### 1. `A-001-shared.css`')
    expect(spec).toContain('CSS patch, writer A, order 1, every page.')

    // One section per page, and a page only lists what it carries.
    expect(spec).toContain(`### \`cart\` — scratch (${cartPage.url})`)
    expect(spec).toContain('#### 1. `B-002-total.js`')
    expect(spec).toContain('JavaScript patch, writer A, order 2, page `cart`.')
    expect(spec).toContain('window.guard = true;')
    expect(spec).toContain('### `pay` — overlay (https://app.example.com/pay)')
    expect(spec).toContain('_None of its own._')
    // A change that declares nothing says so: nothing checked what it matched.
    expect(spec).toContain('Declares no `@target`, so nothing checked what it matched.')
  })

  /**
   * What each `@target` matched is knowable only from an apply — and it is the first thing
   * the reader has to know, because a selector that stopped matching describes a page that is
   * no longer there (plan §21.2). The three states are different problems, so they read
   * differently.
   */
  it('reports each declared @target against the anchor record, including where it moved to', () => {
    const anchors = [
      {
        page: null,
        url: 'https://app.example.com/pay',
        updatedAt: '2026-09-15T10:00:00.000Z',
        anchors: [
          {
            target: '[data-pay]',
            patches: ['patches/A-004-pay.css'],
            fingerprint: { tag: 'button', text: 'Pay now', path: 'body > form > button', attrs: ['.pay-btn'] },
            firstSeenAt: '2026-09-10T10:00:00.000Z',
            lastMatchedAt: '2026-09-15T09:00:00.000Z',
            matched: 2,
          },
        ],
      },
      {
        page: 'cart',
        url: null,
        updatedAt: '2026-09-15T10:00:00.000Z',
        anchors: [
          {
            target: '[data-total]',
            patches: ['patches/cart/A-005-total.css'],
            fingerprint: {
              tag: 'span',
              text: '¥128.00',
              path: 'body > main > span',
              attrs: ['#cart-total', '[data-role="total"]'],
            },
            firstSeenAt: '2026-09-10T10:00:00.000Z',
            lastMatchedAt: '2026-09-12T09:00:00.000Z',
            matched: 0,
          },
        ],
      },
    ]

    const spec = buildDevSpec('checkout-flow', {
      pages: [cartPage],
      patches: [
        { ...cssPatch, file: 'A-004-pay.css', source: '/* @target [data-pay] */\n.pay { color: red }' },
        {
          ...cssPatch,
          file: 'A-005-total.css',
          page: 'cart',
          source: '/* @target [data-total] */\n.total { font-weight: 700 }',
        },
        // Declared, applied, and never matched: no record at all — which is not the same
        // thing as a selector that used to work.
        { ...cssPatch, file: 'A-006-idle.css', source: '/* @target .idle */\n.idle { opacity: 0 }' },
      ],
      anchors,
    })

    expect(spec).toContain('Aimed at `[data-pay]` — matched 2 element(s), last seen 2026-09-15.')
    expect(spec).toContain(
      'Aimed at `[data-total]` — recorded 2026-09-12 as span “¥128.00”, and matching nothing since: the page moved.',
    )
    // The fingerprint is what makes drift recoverable rather than only reportable.
    expect(spec).toContain('It is now reachable as `#cart-total`, `[data-role="total"]`.')
    expect(spec).toContain('Aimed at `.idle` — nothing has recorded it matching.')
  })

  it('says the index is the default when no page is marked as the entry', () => {
    const spec = buildDevSpec('checkout-flow', { pages: [{ ...cartPage, entry: false }], patches: [] })

    expect(spec).toContain('The address root shows the generated page index')
  })

  it('reports when there are no patches at all', () => {
    expect(buildDevSpec('empty', { pages: [cartPage], patches: [] })).toContain('_No patches at all._')
  })

  it('does not let backticks in a patch break the code fence', () => {
    const sourceWithBackticks = 'const t = `a`; const u = ```b```;'
    const spec = buildDevSpec('fences', {
      pages: [cartPage],
      patches: [{ ...jsPatch, source: sourceWithBackticks }],
    })

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
    workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-export-'))
    createPrototype(workspaceRoot, { name: slug })
    prototypeDir = getPrototypeDirPath(workspaceRoot, slug)
    patchesDir = getPrototypePatchesPath(workspaceRoot, slug)
  })

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  /** A page document of ours, under the name the table uses. */
  function writePage(page: string, html = BASE): void {
    writePrototypePage(workspaceRoot, slug, page, html)
  }

  /** A patch file, at the root of `patches/` (shared) or under `patches/<page>/`. */
  function writePatch(file: string, body = '/* x */'): void {
    const at = join(patchesDir, file)
    mkdirSync(dirname(at), { recursive: true })
    writeFileSync(at, body, 'utf-8')
  }

  interface ExportedManifest {
    options_ui?: { page: string; open_in_tab: boolean }
    content_scripts?: Array<{ matches: string[]; css?: string[]; js?: string[] }>
  }

  function manifestOf(extensionDir: string): ExportedManifest {
    return JSON.parse(readFileSync(join(extensionDir, 'manifest.json'), 'utf-8'))
  }

  /** The content scripts of a package, in the order the manifest declares them. */
  function contentScripts(manifest: ExportedManifest): Array<{ matches: string[]; css?: string[]; js?: string[] }> {
    return manifest.content_scripts ?? []
  }

  /**
   * Pages reference their own static files with root-absolute paths, and inside an
   * extension page such a path resolves to the *package* root — so unless the files
   * are in the package under their own names, a delivered page silently loses its
   * styles the moment it is handed over.
   *
   * Everything under `assets/` travels, and as bytes: which of those files a page
   * addresses is not answerable from the markup (a script builds the URL), and a
   * utf-8 round trip is what would corrupt an image.
   */
  it('ships the prototype’s own static files, under the paths the pages use', () => {
    writePrototypeConfig(workspaceRoot, slug, { pages: [{ name: 'cart', kind: 'scratch', entry: true }] })
    writePage(
      'cart',
      '<!doctype html><html><head><link rel="stylesheet" href="/assets/app.css"></head>' +
        '<body><img src="/assets/logo.png">cart</body></html>',
    )

    const assetsDir = join(getPrototypeDirPath(workspaceRoot, slug), 'assets')
    mkdirSync(join(assetsDir, 'lib'), { recursive: true })
    writeFileSync(join(assetsDir, 'app.css'), '.app{}', 'utf-8')
    writeFileSync(join(assetsDir, 'lib', 'format.js'), 'export const x = 1', 'utf-8')
    // Bytes a utf-8 round trip would destroy: 0xff 0xfe is not valid utf-8.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe])
    writeFileSync(join(assetsDir, 'logo.png'), png)

    const result = exportPrototype(workspaceRoot, slug)

    expect(readFileSync(join(result.extensionDir, 'assets', 'app.css'), 'utf-8')).toBe('.app{}')
    expect(readFileSync(join(result.extensionDir, 'assets', 'lib', 'format.js'), 'utf-8')).toBe('export const x = 1')
    expect(readFileSync(join(result.extensionDir, 'assets', 'logo.png'))).toEqual(png)

    // …and the reference in the page resolves inside the package, which is what the
    // existing "every reference exists" check below asserts for the rest.
    expect(readFileSync(result.pagePath!, 'utf-8')).toContain('href="/assets/app.css"')
  })

  /**
   * A page whose row says the shared layout does not wrap it travels as written: the
   * delivered document is the one the host serves, which is the whole point of the
   * answer — a page that is a design of its own keeps its own head (plan §19.2).
   */
  it('delivers a page as written when its row says the layout does not wrap it', () => {
    writeFileSync(
      join(prototypeDir, '_layout.html'),
      '<!doctype html><html><body><nav id="layout">layout</nav><slot name="page"></slot></body></html>',
      'utf-8',
    )
    writePrototypeConfig(workspaceRoot, slug, {
      pages: [
        { name: 'cart', kind: 'scratch' },
        { name: 'landing', kind: 'scratch', useLayout: false },
      ],
    })
    writePage('cart')
    writePage(
      'landing',
      '<!doctype html><html><head><style>body { color: red }</style></head><body>landing</body></html>',
    )

    const result = exportPrototype(workspaceRoot, slug)

    // The page that said nothing still gets the shared markup…
    expect(readFileSync(join(result.extensionDir, 'cart.html'), 'utf-8')).toContain('id="layout"')
    // …and the one that said so is the document it was written as.
    const delivered = readFileSync(join(result.extensionDir, 'landing.html'), 'utf-8')
    expect(delivered).not.toContain('id="layout"')
    expect(delivered).toContain('<style>body { color: red }</style>')
  })

  it('writes a loadable extension and a dev spec into dist/', () => {
    writePrototypeConfig(workspaceRoot, slug, { pages: [{ name: 'cart', kind: 'scratch', entry: true }] })
    writePage('cart')
    writePatch('A-001-btn.css', '.btn{}')

    const result = exportPrototype(workspaceRoot, slug)

    expect(result.applied).toBe(1)
    expect(result.pageCount).toBe(1)
    expect(result.extensionDir.endsWith(join('dist', 'extension'))).toBe(true)
    expect(result.specPath.endsWith(join('dist', 'dev-spec.md'))).toBe(true)

    // The page inside the package is the one a recipient opens, so that is the
    // page the result names — and it keeps the name it has in the prototype, so
    // the author's links between pages keep working.
    expect(result.pagePath?.endsWith(join('dist', 'extension', 'cart.html'))).toBe(true)
    expect(result.pageUrl?.endsWith('/dist/extension/cart.html')).toBe(true)

    // The generated page index is the options page, whatever the flow is made of:
    // a package can mix our documents with someone else's addresses, and one page
    // cannot represent that (plan §19.5).
    expect(manifestOf(result.extensionDir).options_ui).toEqual({ page: 'index.html', open_in_tab: true })

    const html = readFileSync(result.pagePath!, 'utf-8')
    expect(html).toContain('<button>Pay</button>')
    // Patches are files the page references, not text inlined into it — the whole
    // point of a package rather than a frozen page. Exporting does not fold them: the
    // package carries the change layer as the author left it.
    expect(html).toContain('href="patches/A-001-btn.css"')
    expect(readFileSync(join(result.extensionDir, 'patches', 'A-001-btn.css'), 'utf-8')).toBe('.btn{}\n')

    // Everything the page names has to be *in* the package: a reference to a file
    // that is not there is the one failure a reviewer would read as "the export is
    // broken", and it is invisible until the extension is loaded.
    for (const [, reference] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      expect(existsSync(join(result.extensionDir, reference!))).toBe(true)
    }

    expect(readFileSync(result.specPath, 'utf-8')).toContain('A-001-btn.css')
  })

  /**
   * The index a recipient opens first: which artifact is for whom. It is built from the `dist/`
   * listing as it exists at write time, so it can only ever name what the run left behind — a
   * handover that points at a file which is not in the box would send someone looking for it.
   */
  it('writes a handoff index of what the run produced, and of what is not settled', () => {
    writePrototypeConfig(workspaceRoot, slug, { pages: [{ name: 'cart', kind: 'scratch', entry: true }] })
    writePage('cart')
    writePatch('A-001-btn.css', '.btn{}')
    // A requirement nothing implements is a blocker, so the package has to say so.
    writeFileSync(join(prototypeDir, 'PRD.md'), '## R-001 A cart holds its line\n', 'utf-8')

    const result = exportPrototype(workspaceRoot, slug)

    expect(result.handoffPath.endsWith(join('dist', 'handoff.md'))).toBe(true)
    const handoff = readFileSync(result.handoffPath, 'utf-8')

    expect(handoff).toContain('# Handover — checkout-flow')
    expect(handoff).toContain('The flow starts at `cart`.')
    // What the run produced, and only that: this flow is a single page of ours with no
    // contract, so there is no bookmarklet, no backend document and no acceptance report.
    expect(handoff).toContain('| `dev-spec.md` |')
    expect(handoff).toContain('| `extension/` |')
    expect(handoff).toContain('| `static/` |')
    expect(handoff).not.toContain('bookmarklet.html')
    expect(handoff).not.toContain('contract.md')
    expect(handoff).not.toContain('acceptance.md')

    // The gate, on the package's own first page rather than only in the conversation.
    expect(handoff).toContain('## What this delivery does not settle')
    expect(handoff).toContain('R-001 is in PRD.md but no page or patch refers to it')
  })

  /**
   * A page that belongs to a running product is not copied: the package is the
   * injection that puts the patches onto the real page. There is no document of
   * ours to open, and the change spec is what names the address the changes
   * belong to.
   */
  it('packs a live page as an injection, with no document of ours to open', () => {
    writePrototypeConfig(workspaceRoot, slug, {
      pages: [{ name: 'entry', kind: 'overlay', url: 'https://app.example.com/checkout', entry: true }],
    })
    writePatch('A-001-btn.css', '.btn{}')

    const result = exportPrototype(workspaceRoot, slug)

    expect(result.pagePath).toBeNull()
    expect(result.pageUrl).toBeNull()

    const manifest = manifestOf(result.extensionDir)
    expect(contentScripts(manifest)).toHaveLength(1)
    expect(contentScripts(manifest)[0]?.matches).toEqual(['https://app.example.com/checkout*'])
    expect(manifest.options_ui).toEqual({ page: 'index.html', open_in_tab: true })
    // Chrome loads a content script by path; a path that is not in the package
    // makes the whole extension fail to load, with the reason in chrome://extensions.
    for (const reference of [
      ...(contentScripts(manifest)[0]?.css ?? []),
      ...(contentScripts(manifest)[0]?.js ?? []),
    ]) {
      expect(existsSync(join(result.extensionDir, reference))).toBe(true)
    }

    expect(readFileSync(join(result.extensionDir, 'README.md'), 'utf-8')).toContain(
      '`https://app.example.com/checkout*`',
    )
    expect(readFileSync(result.specPath, 'utf-8')).toContain('https://app.example.com/checkout')
  })

  /**
   * Old data is promoted at read time (plan §19.7), and the promotion has to
   * survive all the way into the deliverable: a legacy overlay's targetUrl is the
   * entry row, and its declared pages follow it in order.
   */
  it('exports a page table promoted from an old config, page for page', () => {
    writeFileSync(
      join(prototypeDir, 'config.json'),
      JSON.stringify({
        kind: 'overlay',
        targetUrl: 'https://app.example.com/cart',
        pages: [{ name: 'payment', url: 'https://app.example.com/checkout/payment' }],
      }),
      'utf-8',
    )

    const result = exportPrototype(workspaceRoot, slug)
    const manifest = manifestOf(result.extensionDir)

    expect(result.pageCount).toBe(2)
    expect(contentScripts(manifest).map((script) => script.matches)).toEqual([
      ['https://app.example.com/cart*'],
      ['https://app.example.com/checkout/payment*'],
    ])
    expect(readFileSync(result.specPath, 'utf-8')).toContain('The address root opens `entry`.')
  })

  // A row that could not be read is not a page, so a prototype whose only row was
  // refused has nothing to deliver rather than an empty package.
  it('refuses to export a prototype whose only row could not be read', () => {
    writeFileSync(
      join(prototypeDir, 'config.json'),
      JSON.stringify({ pages: [{ name: 'pay', kind: 'overlay' }] }),
      'utf-8',
    )

    expect(() => exportPrototype(workspaceRoot, slug)).toThrow(/has no pages/)
  })

  /**
   * A flow on a real site is several addresses, and the package has to cover all
   * of them: one page left out is one screen where the prototype simply is not
   * there, which looks exactly like a patch that did nothing.
   */
  it('gives every live page its own content script, not just the entry', () => {
    writePrototypeConfig(workspaceRoot, slug, {
      pages: [
        { name: 'cart', kind: 'overlay', url: 'https://app.example.com/cart', entry: true },
        { name: 'address', kind: 'overlay', url: 'https://app.example.com/checkout/address' },
        { name: 'payment', kind: 'overlay', url: 'https://staging.example.com/pay' },
      ],
    })

    const manifest = manifestOf(exportPrototype(workspaceRoot, slug).extensionDir)

    expect(contentScripts(manifest).map((script) => script.matches)).toEqual([
      ['https://app.example.com/cart*'],
      ['https://app.example.com/checkout/address*'],
      ['https://staging.example.com/pay*'],
    ])
  })

  // A page whose address cannot become a pattern would otherwise be covered by
  // nothing, with the export reporting success.
  it('refuses to export when a page’s address cannot be matched on, naming the page', () => {
    writePrototypeConfig(workspaceRoot, slug, {
      pages: [
        { name: 'cart', kind: 'overlay', url: 'https://app.example.com/cart', entry: true },
        { name: 'payment', kind: 'overlay', url: 'ftp://app.example.com/pay' },
      ],
    })

    expect(() => exportPrototype(workspaceRoot, slug)).toThrow(/page "payment"/)
  })

  /**
   * A flow of ours is several documents, and the package ships all of them under
   * the names they have on disk: a link to a page that is not in the package is a
   * 404, and a renamed page is a link that silently stops working.
   */
  it('ships every page of a flow of ours, under the names they have on disk', () => {
    writePrototypeConfig(workspaceRoot, slug, { pages: [{ name: 'cart', kind: 'scratch', entry: true }] })
    writePage('cart', '<!doctype html><html><head></head><body><a href="orders.html">Orders</a></body></html>')
    writePage('orders', '<!doctype html><html><body><h1>Orders</h1></body></html>')

    const result = exportPrototype(workspaceRoot, slug)

    expect(readFileSync(join(result.extensionDir, 'orders.html'), 'utf-8')).toContain('<h1>Orders</h1>')
    expect(readFileSync(result.pagePath!, 'utf-8')).toContain('<a href="orders.html">Orders</a>')
    expect(readFileSync(join(result.extensionDir, 'README.md'), 'utf-8')).toContain('`orders.html`')
  })

  /**
   * One package covers the whole flow, whatever it is made of (plan §19.5): our
   * documents ship as files, each live page gets a content script carrying only
   * the patches that apply to it, and the index is the options page either way.
   */
  it('covers a mixed flow with both kinds at once', () => {
    writePrototypeConfig(workspaceRoot, slug, {
      pages: [
        { name: 'cart', kind: 'scratch', entry: true },
        { name: 'orders', kind: 'scratch' },
        { name: 'pay', kind: 'overlay', url: 'https://app.example.com/pay' },
      ],
    })
    writePage('cart')
    writePage('orders')
    writePatch('A-001-shared.css', '.shared{}')
    writePatch('cart/B-001-total.js', 'window.total = 1;')
    writePatch('pay/C-001-pay.css', '.pay{}')
    writePatch('pay/C-002-pay.js', 'window.pay = true;')

    const result = exportPrototype(workspaceRoot, slug)

    expect(result.pageCount).toBe(3)
    expect(result.pagePath?.endsWith(join('dist', 'extension', 'cart.html'))).toBe(true)

    // Every document of ours is in the package, under its own name.
    expect(existsSync(join(result.extensionDir, 'cart.html'))).toBe(true)
    expect(existsSync(join(result.extensionDir, 'orders.html'))).toBe(true)

    const manifest = manifestOf(result.extensionDir)
    expect(manifest.options_ui).toEqual({ page: 'index.html', open_in_tab: true })

    // One content script for the one live page, carrying the shared patches and
    // its own — never another page's.
    expect(contentScripts(manifest)).toHaveLength(1)
    expect(contentScripts(manifest)[0]?.matches).toEqual(['https://app.example.com/pay*'])
    expect(contentScripts(manifest)[0]?.css).toEqual([
      'patches/A-001-shared.css',
      'patches/pay/C-001-pay.css',
    ])
    expect(contentScripts(manifest)[0]?.js).toEqual(['assets/pay/__prototype_patches.js'])

    const cartHtml = readFileSync(join(result.extensionDir, 'cart.html'), 'utf-8')
    const ordersHtml = readFileSync(join(result.extensionDir, 'orders.html'), 'utf-8')
    expect(cartHtml).toContain('href="patches/A-001-shared.css"')
    expect(cartHtml).toContain('src="assets/cart/__prototype_patches.js"')
    expect(cartHtml).not.toContain('C-001-pay.css')
    expect(ordersHtml).toContain('href="patches/A-001-shared.css"')
    expect(ordersHtml).not.toContain('B-001-total.js')

    // The spec has a section per page — the question a developer arrives with.
    const spec = readFileSync(result.specPath, 'utf-8')
    expect(spec).toContain('### Shared (every page)')
    expect(spec).toContain('### `cart` — scratch (cart.html)')
    expect(spec).toContain('### `orders` — scratch (orders.html)')
    expect(spec).toContain('### `pay` — overlay (https://app.example.com/pay)')
  })

  it('still refuses to export when a page in the table has no document', () => {
    writePrototypeConfig(workspaceRoot, slug, { pages: [{ name: 'base', kind: 'scratch', entry: true }] })

    expect(() => exportPrototype(workspaceRoot, slug)).toThrow(/documents are not in/)
  })

  /**
   * The third carrier (plan §17.9): the live pages' changes as bookmarks, for the
   * machine where an unpacked extension cannot be loaded. It carries the **same**
   * bundle the extension ships, so the two cannot behave differently — only what
   * gets the code into the page differs.
   */
  it('writes the live pages’ changes as bookmarklets', () => {
    writePrototypeConfig(workspaceRoot, slug, {
      pages: [
        { name: 'cart', kind: 'overlay', url: 'https://app.example.com/cart', entry: true },
        { name: 'pay', kind: 'overlay', url: 'https://app.example.com/pay' },
      ],
    })
    writePatch('A-001-shared.css', '.shared{}')
    writePatch('cart/B-001-total.js', 'window.total = 1;')
    writePatch('pay/C-001-pay.js', 'window.pay = true;')

    const result = exportPrototype(workspaceRoot, slug)
    const html = readFileSync(result.bookmarkletPath!, 'utf-8')

    expect(result.bookmarkletPath?.endsWith(join('dist', 'bookmarklet.html'))).toBe(true)

    // One link per live page: a bookmark is not scoped to an address the way a
    // content script is, so the link the reader picks is the screen they get.
    const hrefs = [...html.matchAll(/href="(javascript:[^"]+)"/g)].map((match) => match[1]!)
    expect(hrefs).toHaveLength(2)
    const codes = hrefs.map((href) => decodeURIComponent(href.slice('javascript:'.length)))

    // Each carries its own page's patches and the shared ones — never another
    // page's (plan §19.4).
    expect(codes[0]).toContain('.shared{}')
    expect(codes[0]).toContain('window.total = 1;')
    expect(codes[0]).not.toContain('window.pay = true;')
    expect(codes[1]).toContain('.shared{}')
    expect(codes[1]).toContain('window.pay = true;')
    expect(codes[1]).not.toContain('window.total = 1;')

    // Each is a program: a bookmark that does not parse is found here rather than
    // when someone clicks it in front of the customer.
    for (const code of codes) expect(() => new Function(code)).not.toThrow()

    // The address each is for is printed beside it, since the file cannot enforce it.
    expect(html).toContain('https://app.example.com/pay')
  })

  // A bookmark that does nothing is worse than no bookmark: it looks like it
  // worked. A flow of ours has no live page to inject into, and one left over from
  // an earlier export is removed rather than kept.
  it('has no bookmarklet for a flow of ours, and removes one left over', () => {
    writePrototypeConfig(workspaceRoot, slug, { pages: [{ name: 'cart', kind: 'scratch', entry: true }] })
    writePage('cart')
    const leftover = join(getPrototypeDistPath(workspaceRoot, slug), 'bookmarklet.html')
    mkdirSync(dirname(leftover), { recursive: true })
    writeFileSync(leftover, 'stale', 'utf-8')

    const result = exportPrototype(workspaceRoot, slug)

    expect(result.bookmarkletPath).toBeNull()
    expect(existsSync(leftover)).toBe(false)
  })

  /**
   * The static deliverable (plan §17.8): the pages of ours as files that need
   * nothing to be looked at — no host, no extension, nothing to load. What the
   * extension gets from Chrome (a package root to resolve a path against), and what
   * the preview gets from the host, has to be in the file itself.
   */
  it('writes every page of ours as one self-contained file', () => {
    writePrototypeConfig(workspaceRoot, slug, { pages: [{ name: 'cart', kind: 'scratch', entry: true }] })
    writePage(
      'cart',
      '<!doctype html><html><head><link rel="stylesheet" href="/assets/app.css"></head>' +
        '<body><img src="assets/logo.png"><a href="orders.html">Orders</a>' +
        '<a href="/orders.html#top">Orders (absolute)</a></body></html>',
    )
    writePage('orders', '<!doctype html><html><body><h1>Orders</h1></body></html>')
    writePatch('A-001-btn.css', '.btn{}')
    writePatch('B-002-total.js', 'window.total = 1;')

    const assetsDir = join(prototypeDir, 'assets')
    mkdirSync(assetsDir, { recursive: true })
    writeFileSync(join(assetsDir, 'app.css'), '.app{}', 'utf-8')
    writeFileSync(join(assetsDir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    const result = exportPrototype(workspaceRoot, slug)
    const html = readFileSync(result.staticPath!, 'utf-8')

    expect(result.staticDir?.endsWith(join('dist', 'static'))).toBe(true)
    expect(result.staticPath?.endsWith(join('dist', 'static', 'cart.html'))).toBe(true)
    expect(existsSync(join(result.staticDir!, 'orders.html'))).toBe(true)

    // The patches are text in the page rather than files beside it…
    expect(html).toContain('<style id="__craft_prototype_patches__">')
    expect(html).toContain('window.total = 1;')
    expect(html).not.toContain('patches/A-001-btn.css')

    // …and so is everything the page references, except a page of ours, which
    // travels beside it: a relative link is left exactly as the author wrote it, and
    // a root-absolute one (which would resolve to the filesystem root here) is made
    // relative, fragment and all.
    expect(html).toContain('href="data:text/css;base64,')
    expect(html).toContain('src="data:image/png;base64,')
    expect(html).toContain('<a href="orders.html">Orders</a>')
    expect(html).toContain('<a href="orders.html#top">Orders (absolute)</a>')
    expect(html).not.toContain('/assets/app.css')
    expect(html).not.toContain('/orders.html')
  })

  /**
   * A live page cannot be frozen: it runs its own code and carries its own session,
   * so a copy of it would only look like the page being worked on. A prototype made
   * only of them has no static half — and a folder left over from an earlier export
   * is removed rather than kept as a page of a state this prototype is no longer in.
   */
  it('has no static half for a flow of live pages, and removes one left over', () => {
    writePrototypeConfig(workspaceRoot, slug, {
      pages: [{ name: 'pay', kind: 'overlay', url: 'https://app.example.com/pay', entry: true }],
    })
    const staticDir = join(getPrototypeDistPath(workspaceRoot, slug), 'static')
    mkdirSync(staticDir, { recursive: true })
    writeFileSync(join(staticDir, 'cart.html'), 'stale', 'utf-8')

    const result = exportPrototype(workspaceRoot, slug)

    expect(result.staticDir).toBeNull()
    expect(result.staticPath).toBeNull()
    expect(existsSync(staticDir)).toBe(false)
  })

  /**
   * A reference that names no file of this prototype is the one thing a single file
   * cannot fix, and it would be a link that breaks the moment the page is opened on
   * its own — reported, and left as written, because rewriting it to nothing would
   * hide which reference is broken.
   */
  it('reports a reference the static page cannot carry', () => {
    writePrototypeConfig(workspaceRoot, slug, { pages: [{ name: 'cart', kind: 'scratch', entry: true }] })
    writePage(
      'cart',
      '<!doctype html><html><head><link rel="stylesheet" href="/missing/app.css"></head><body>cart</body></html>',
    )

    const result = exportPrototype(workspaceRoot, slug)

    expect(result.staticWarnings.join('\n')).toContain('/missing/app.css')
    // Not mixed into the extension's warnings: the two deliverables are adapted for
    // different reasons, and one header cannot be true of both.
    expect(result.warnings.join('\n')).not.toContain('/missing/app.css')
    expect(readFileSync(result.staticPath!, 'utf-8')).toContain('href="/missing/app.css"')
  })
})

describe('resolvePrototypeEntry', () => {
  const slug = 'checkout-flow'
  const ORIGIN = 'http://checkout-flow-abc123ab.localhost:41234'
  let workspaceRoot = ''

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-entry-'))
    createPrototype(workspaceRoot, { name: slug })
  })

  afterEach(() => {
    // The resolver is process-global; leaving one installed would leak into every
    // later test in this file.
    setPrototypeBaseUrlResolver(null)
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  function writePage(page: string, html = BASE): void {
    writePrototypePage(workspaceRoot, slug, page, html)
  }

  function onlyPage(row: PrototypePageEntry): void {
    writePrototypeConfig(workspaceRoot, slug, { pages: [row] })
  }

  /**
   * The whole point of a page's kind, in one assertion: an overlay page is the
   * *live address* it records — with its own JavaScript, its own session and its
   * own data — and the prototype is that page with the patches replayed into it. A
   * captured copy would run none of that; it would only look like the page.
   */
  it('sends a live entry page to its address, patches still to be injected', () => {
    onlyPage({ name: 'pay', kind: 'overlay', url: 'https://app.example.com/checkout', entry: true })
    setPrototypeBaseUrlResolver(() => ORIGIN)

    const entry = resolvePrototypeEntry(workspaceRoot, slug)

    expect(entry.page).toBe('pay')
    expect(entry.url).toBe('https://app.example.com/checkout')
    expect(entry.injectPatches).toBe(true)
    // No document of its own — a live page is an address, not a file.
    expect(entry.path).toBeNull()
    // …but its *identity* is still the prototype's own address, and that is what
    // the window's bar reads. Two different things on purpose: the page is
    // somebody else's, the prototype is ours.
    expect(entry.origin).toBe(ORIGIN)
  })

  // A live address does not need a host to be openable — it is live either way —
  // so the identity is what gives way, not the page.
  it('opens a live page with no identity when nothing answers prototypes', () => {
    onlyPage({ name: 'pay', kind: 'overlay', url: 'https://app.example.com/checkout', entry: true })

    const entry = resolvePrototypeEntry(workspaceRoot, slug)

    expect(entry.url).toBe('https://app.example.com/checkout')
    expect(entry.origin).toBeNull()
  })

  it('ignores a document lying beside a live entry page — the address is the page', () => {
    onlyPage({ name: 'pay', kind: 'overlay', url: 'https://app.example.com/checkout', entry: true })
    writePage('cart')

    const entry = resolvePrototypeEntry(workspaceRoot, slug)

    expect(entry.page).toBe('pay')
    expect(entry.path).toBeNull()
  })

  it('refuses a prototype whose rows could not be read, naming what to write', () => {
    onlyPage({ name: 'pay', kind: 'overlay' })

    expect(() => resolvePrototypeEntry(workspaceRoot, slug)).toThrow(/has no pages yet/)
  })

  /**
   * A page of ours has no address to point at, so it is whatever the host renders
   * from its own document — and that arrives with the patches already applied,
   * which is why nothing has to be injected.
   */
  it('sends a page of ours to the prototype’s own address, nothing to inject', () => {
    onlyPage({ name: 'cart', kind: 'scratch', entry: true })
    writePage('cart')
    setPrototypeBaseUrlResolver(() => ORIGIN)

    const entry = resolvePrototypeEntry(workspaceRoot, slug)

    expect(entry.page).toBe('cart')
    expect(entry.url).toBe(ORIGIN)
    expect(entry.injectPatches).toBe(false)
    expect(entry.path?.endsWith('cart.html')).toBe(true)
    // For a page of ours the page and the identity coincide.
    expect(entry.origin).toBe(ORIGIN)
  })

  it('refuses a page of ours with no document, naming the file', () => {
    onlyPage({ name: 'cart', kind: 'scratch', entry: true })
    setPrototypeBaseUrlResolver(() => ORIGIN)

    expect(() => resolvePrototypeEntry(workspaceRoot, slug)).toThrow(/cart\.html is not in/)
  })

  // No page is naturally the first one, so the root shows the generated index
  // until someone marks an entry (plan §19.3).
  it('opens the prototype itself, with no page, when no row is the entry', () => {
    onlyPage({ name: 'cart', kind: 'scratch' })
    writePage('cart')
    setPrototypeBaseUrlResolver(() => ORIGIN)

    expect(resolvePrototypeEntry(workspaceRoot, slug)).toEqual({
      page: null,
      path: null,
      url: ORIGIN,
      origin: ORIGIN,
      injectPatches: false,
    })
  })

  // No host means no address shows a page of ours with its patches at all: a
  // `file://` page would be the raw document, which is exactly the thing this
  // refuses to hand out.
  it('refuses rather than falling back to file:// when nothing serves prototypes', () => {
    onlyPage({ name: 'cart', kind: 'scratch', entry: true })
    writePage('cart')

    expect(() => resolvePrototypeEntry(workspaceRoot, slug)).toThrow(/No host is serving prototypes/)
  })
})
