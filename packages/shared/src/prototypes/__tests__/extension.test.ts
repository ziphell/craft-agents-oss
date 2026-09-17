import { describe, expect, it } from 'bun:test'
import {
  buildExtensionPackage,
  buildMockScript,
  buildPagePatchBundle,
  buildPatchBundle,
  extractInlineHandlers,
  matchPatternForUrl,
} from '../extension'
import type { MockRoute } from '../contract'
import type { PrototypePatch } from '../types'

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
  file: 'B-002-badge.js',
  kind: 'js',
  writer: 'B',
  order: 2,
  source: "document.querySelector('.total')?.classList.add('is-big');",
  targets: [],
  page: null,
  key: 'k2',
}

const BUILT_AT = new Date('2026-03-05T10:30:00Z')

const mockRoute: MockRoute = {
  method: 'GET',
  path: '/api/orders',
  status: 200,
  body: { orders: [{ id: 'ord-1' }] },
}

/**
 * Run a bundle the way a page would, with just enough environment for it to
 * work: a head to append to, a history to hook, a window to hang the install on.
 */
function runBundle(bundle: string, options: { root?: boolean; installed?: boolean } = {}): {
  events: string[]
  styles: Array<{ id: string; textContent: string }>
  history: Record<string, (...args: unknown[]) => unknown>
} {
  const events: string[] = []
  const styles: Array<{ id: string; textContent: string }> = []
  const hasRoot = options.root !== false
  const head = hasRoot
    ? {
        appendChild: (node: { id: string; textContent: string }) => styles.push(node),
      }
    : null

  const document = {
    head,
    documentElement: hasRoot ? { appendChild: () => undefined } : null,
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '' }),
    addEventListener: (type: string) => events.push(type),
  }
  const history: Record<string, (...args: unknown[]) => unknown> = {
    pushState: () => undefined,
    replaceState: () => undefined,
  }
  const window: Record<string, unknown> = {
    addEventListener: (type: string) => events.push(`window:${type}`),
  }
  if (options.installed) window.__craft_prototype_checkout_flow__ = { apply: () => events.push('reused') }

  new Function('document', 'history', 'window', 'console', bundle)(
    document,
    history,
    window,
    { error: () => undefined },
  )

  return { events, styles, history }
}

describe('buildPatchBundle', () => {
  it('replays every patch in the order it was given', () => {
    const bundle = buildPatchBundle('checkout-flow', [cssPatch, jsPatch])

    expect(bundle.indexOf('.btn { color: red }')).toBeLessThan(bundle.indexOf('is-big'))
  })

  /**
   * The patches go through the same transform the live injector uses, so the
   * preview cannot behave differently from what the workbench shows. What this
   * asserts is that reuse, not the transform itself (patch-script.test.ts owns it).
   */
  it('reuses the live transform for both kinds', () => {
    const bundle = buildPatchBundle('checkout-flow', [cssPatch, jsPatch])

    // A css patch owns a `<style>` element keyed by its file name.
    expect(bundle).toContain('__craft_patch_A-001-btn_css')
    // A js patch is wrapped so one failure cannot abort the rest of the bundle.
    expect(bundle).toContain('} catch (err) {')
  })

  it('installs once, and re-runs the install on a second injection', () => {
    const bundle = buildPatchBundle('checkout-flow', [cssPatch])

    expect(bundle).toContain('__craft_prototype_checkout_flow__')
    expect(bundle).toContain('if (installed) { installed.apply(); return; }')
  })

  /**
   * A single-page app swaps views without a reload, and the view it lands on is a
   * page the patches have never seen. Without these hooks the preview would
   * silently stop at the first route change.
   */
  it('replays on view changes', () => {
    const bundle = buildPatchBundle('checkout-flow', [cssPatch])

    expect(bundle).toContain("['pushState', 'replaceState']")
    expect(bundle).toContain("window.addEventListener('popstate', apply)")
  })

  it('is executable JavaScript, and survives a patch ending in a line comment', () => {
    const bundle = buildPatchBundle('checkout-flow', [{ ...jsPatch, source: '// nothing to do' }])

    expect(() => new Function(bundle)).not.toThrow()
  })

  it('runs against a page-like environment without throwing', () => {
    const bundle = buildPatchBundle('checkout-flow', [cssPatch, jsPatch])
    expect(() => runBundle(bundle)).not.toThrow()
  })

  it('injects the css patch as a stylesheet on the page', () => {
    const { styles } = runBundle(buildPatchBundle('checkout-flow', [cssPatch]))

    expect(styles).toHaveLength(1)
    expect(styles[0]!.id).toBe('__craft_patch_A-001-btn_css')
    expect(styles[0]!.textContent).toBe('.btn { color: red }')
  })

  it('re-runs the existing install instead of adding a second one', () => {
    const { events, styles } = runBundle(buildPatchBundle('checkout-flow', [cssPatch]), { installed: true })

    expect(events).toContain('reused')
    // Nothing was injected twice: the page already had this prototype installed.
    expect(styles).toHaveLength(0)
  })

  it('is a no-op when the page arrives before its head exists', () => {
    const bundle = buildPatchBundle('checkout-flow', [cssPatch])

    expect(() => runBundle(bundle, { root: false })).not.toThrow()
  })
})

/**
 * The patch bundle is per page, not per package: a patch under `patches/<page>/`
 * belongs to that page, and handing it to every page is exactly the silent
 * over-application the directory rule exists to prevent (plan §19.4).
 */
describe('buildPagePatchBundle', () => {
  const shared = { ...jsPatch, file: 'A-001-shared.js', page: null }
  const carts = { ...jsPatch, file: 'cart/B-002-badge.js', page: 'cart' }

  it('gives a page the shared javascript plus its own, and nothing from another page', () => {
    const bundle = buildPagePatchBundle('checkout-flow', 'cart', [shared, carts])

    expect(bundle?.path).toBe('assets/cart/__prototype_patches.js')
    expect(bundle?.content).toContain('A-001-shared.js')
    expect(bundle?.content).toContain('cart/B-002-badge.js')

    const other = buildPagePatchBundle('checkout-flow', 'orders', [shared, carts])
    expect(other?.content).not.toContain('cart/B-002-badge.js')
  })

  it('returns nothing for a page with no javascript patches', () => {
    expect(buildPagePatchBundle('checkout-flow', 'cart', [cssPatch])).toBeNull()
  })
})

describe('matchPatternForUrl', () => {
  it('scopes a page to its scheme, host and path, and stays open after that', () => {
    expect(matchPatternForUrl('https://app.example.com/checkout')).toBe('https://app.example.com/checkout*')
  })

  /**
   * A real address carries a query string and a fragment, and a pattern that
   * misses them fails *silently*: the injection simply never happens. This is why
   * the tail stays open rather than naming the exact path.
   */
  it('keeps the query string and fragment of the page it was made from', () => {
    expect(matchPatternForUrl('https://app.example.com/checkout?step=2#pay')).toBe(
      'https://app.example.com/checkout*',
    )
    // A sub-route is written down as it is; the open tail still covers what comes
    // after it, so a step added later does not lose the injection.
    expect(matchPatternForUrl('https://app.example.com/checkout/confirm')).toBe(
      'https://app.example.com/checkout/confirm*',
    )
  })

  it('names the whole host when the address is the root', () => {
    expect(matchPatternForUrl('https://app.example.com')).toBe('https://app.example.com/*')
    expect(matchPatternForUrl('https://app.example.com/')).toBe('https://app.example.com/*')
  })

  it('keeps the port, since a dev server is not the production host', () => {
    expect(matchPatternForUrl('http://localhost:5173/app')).toBe('http://localhost:5173/app*')
  })

  // Null rather than a guess: the caller has to say it cannot scope this page
  // instead of producing a pattern that matches nothing.
  it('refuses anything a browser cannot match on', () => {
    expect(matchPatternForUrl('not an address')).toBeNull()
    expect(matchPatternForUrl('file:///tmp/cart.html')).toBeNull()
    expect(matchPatternForUrl('about:blank')).toBeNull()
  })
})

describe('extractInlineHandlers', () => {
  it('turns an inline handler into a marker plus a generated function', () => {
    const result = extractInlineHandlers('<button onclick="pay()">Pay</button>')

    expect(result.count).toBe(1)
    expect(result.html).toContain('data-craft-on-click="h1"')
    expect(result.html).not.toContain('onclick=')
    expect(result.script).toContain('"h1": function (event) { pay()')
  })

  it('binds handlers the page adds after load, not only the ones in the document', () => {
    const result = extractInlineHandlers('<button onclick="pay()">Pay</button>')

    expect(result.script).toContain('MutationObserver')
    expect(result.script).toContain('document.readyState === "loading"')
  })

  it('keeps each event type apart, so one element can carry two', () => {
    const result = extractInlineHandlers('<input onfocus="focus()" onblur="blur()">')

    expect(result.count).toBe(2)
    expect(result.html).toContain('data-craft-on-focus="h1"')
    expect(result.html).toContain('data-craft-on-blur="h2"')
    expect(result.script).toContain('data-craft-on-focus')
    expect(result.script).toContain('data-craft-on-blur')
  })

  it('leaves a document with no handlers alone, and generates nothing for it', () => {
    const html = '<button class="btn">Pay</button>'
    const result = extractInlineHandlers(html)

    expect(result.count).toBe(0)
    expect(result.html).toBe(html)
    expect(result.script).toBe('')
  })

  /**
   * An empty attribute does nothing on a page, so the marker that replaces it must
   * not survive either — otherwise the delivered page carries an attribute the
   * author never wrote.
   */
  it('drops an empty handler rather than leaving a marker behind', () => {
    const result = extractInlineHandlers('<button onclick="">Pay</button>')

    expect(result.count).toBe(0)
    expect(result.html).toBe('<button>Pay</button>')
  })
})

describe('buildMockScript', () => {
  /** Run the mock script with a stand-in for the page's own globals. */
  function runMocks(script: string): {
    fetch: (input: unknown, init?: { method?: string }) => Promise<{ body?: string; status?: number }>
    passedThrough: string[]
  } {
    const passedThrough: string[] = []
    const window: Record<string, unknown> = {
      fetch: (input: unknown) => {
        passedThrough.push(String(input))
        return Promise.resolve({ body: 'real backend', status: 200 })
      },
    }

    class ResponseStub {
      body: string | null
      status: number
      constructor(body: string | null, init: { status: number }) {
        this.body = body
        this.status = init.status
      }
    }
    class RequestStub {}

    new Function(
      'window',
      'location',
      'XMLHttpRequest',
      'Response',
      'Request',
      'Event',
      'setTimeout',
      'console',
      script,
    )(
      window,
      { href: 'https://app.example.com/checkout' },
      { prototype: { open: () => undefined, send: () => undefined } },
      ResponseStub,
      RequestStub,
      function EventStub() {},
      () => undefined,
      { error: () => undefined },
    )

    return {
      fetch: window.fetch as (input: unknown, init?: { method?: string }) => Promise<{ body?: string; status?: number }>,
      passedThrough,
    }
  }

  it('answers a declared route with its fixture and status', async () => {
    const { fetch, passedThrough } = runMocks(buildMockScript({ routes: [mockRoute], store: {} }))

    const response = await fetch('/api/orders')

    expect(response.status).toBe(200)
    expect(JSON.parse(response.body!)).toEqual({ orders: [{ id: 'ord-1' }] })
    expect(passedThrough).toHaveLength(0)
  })

  /**
   * Matching is by pathname, exactly like the workbench's own layer: one contract
   * serves a prototype in several environments only if the route is not pinned to
   * the host it was written against.
   */
  it('matches on the path, whatever host the page calls', async () => {
    const { fetch, passedThrough } = runMocks(buildMockScript({ routes: [mockRoute], store: {} }))

    const response = await fetch('https://api.internal.example.com/api/orders?page=2')

    expect(response.status).toBe(200)
    expect(passedThrough).toHaveLength(0)
  })

  it('leaves everything it was not asked to fake alone', async () => {
    const { fetch, passedThrough } = runMocks(buildMockScript({ routes: [mockRoute], store: {} }))

    const response = await fetch('/api/orders/ord-1/refund', { method: 'POST' })

    expect(response.body).toBe('real backend')
    expect(passedThrough).toEqual(['/api/orders/ord-1/refund'])
  })

  it('answers a bodiless response with an empty body', async () => {
    const { fetch } = runMocks(buildMockScript({ routes: [{ ...mockRoute, method: 'DELETE', status: 204, body: null }], store: {} }))

    const response = await fetch('/api/orders', { method: 'DELETE' })

    expect(response.status).toBe(204)
    expect(response.body).toBeNull()
  })

  it('is executable JavaScript in the page it is injected into', () => {
    expect(() => new Function(buildMockScript({ routes: [mockRoute], store: {} }))).not.toThrow()
  })
})

describe('buildExtensionPackage', () => {
  const scratchDocument = [
    '<!doctype html><html><head><meta charset="utf-8"></head>',
    '<body><button onclick="pay()">Pay</button>',
    '<script>window.ready = true;</script></body></html>',
  ].join('')

  const ordersDocument =
    '<!doctype html><html><head><meta charset="utf-8"></head><body><h1>Orders</h1></body></html>'

  /** What the host serves at `/_index` and the package ships as its options page. */
  const INDEX_DOCUMENT = '<!doctype html><html><body><ul><li><a href="cart.html">cart</a></li></ul></body></html>'

  function scratchPackage(document = scratchDocument) {
    return buildExtensionPackage({
      slug: 'checkout-flow',
      documents: [{ path: 'cart.html', page: 'cart', html: document }],
      entryPage: 'cart',
      indexDocument: INDEX_DOCUMENT,
      patches: [cssPatch, jsPatch],
      builtAt: BUILT_AT,
    })
  }

  function file(pkg: { files: Array<{ path: string; content: string | Uint8Array }> }, path: string): string {
    const content = pkg.files.find((entry) => entry.path === path)?.content ?? ''
    // Every file this module generates is text; the union is only there for the
    // prototype's own assets, which `export.ts` copies as bytes.
    return typeof content === 'string' ? content : new TextDecoder().decode(content)
  }

  /**
   * The documents *are* the extension: the pages keep their own names, nothing is
   * copied or inlined, and there is nothing to inject into.
   */
  it('ships a page of ours as the extension’s own page', () => {
    const pkg = scratchPackage()
    const manifest = JSON.parse(file(pkg, 'manifest.json'))

    expect(manifest.manifest_version).toBe(3)
    // Options is always the generated page index, whatever the flow is made of:
    // it is the one place that lists every page (plan §19.5).
    expect(manifest.options_ui).toEqual({ page: 'index.html', open_in_tab: true })
    expect(file(pkg, 'index.html')).toBe(INDEX_DOCUMENT)
    expect(manifest.background).toEqual({ service_worker: 'background.js' })
    // Nothing to inject into: the pages are ours.
    expect(manifest.content_scripts).toBeUndefined()
    expect(file(pkg, 'README.md')).toContain('**Options**')
    // The toolbar icon opens the entry page, so the entry has to be named there too.
    expect(file(pkg, 'background.js')).toContain("getURL('cart.html')")
  })

  /**
   * MV3 allows an extension page no inline script, and `eval` is out. So the
   * author's inline `<script>` becomes a file, and their `onclick` becomes a
   * generated function a marker points at.
   */
  it('hoists inline script and inline handlers out of the document', () => {
    const pkg = scratchPackage()
    const html = file(pkg, 'cart.html')

    expect(html).toContain('<script src="assets/cart/inline-1.js">')
    expect(file(pkg, 'assets/cart/inline-1.js')).toContain('window.ready = true;')
    expect(html).toContain('data-craft-on-click="h1"')
    expect(html).not.toContain('onclick=')
    expect(file(pkg, 'assets/cart/handlers.js')).toContain('"h1": function (event) { pay()')

    // Nothing is changed silently: the author is told what moved, and that the
    // behaviour is the same.
    expect(pkg.warnings.join('\n')).toContain('inline <script> block(s) were moved')
    expect(pkg.warnings.join('\n')).toContain('inline event handler(s) were lifted')
  })

  it('references the patches as files rather than inlining them', () => {
    const pkg = scratchPackage()
    const html = file(pkg, 'cart.html')

    expect(html).toContain('<link rel="stylesheet" href="patches/A-001-btn.css">')
    expect(html).toContain('<script defer src="assets/cart/__prototype_patches.js">')
    expect(file(pkg, 'patches/A-001-btn.css')).toContain('.btn { color: red }')
    expect(file(pkg, 'assets/cart/__prototype_patches.js')).toContain('is-big')
  })

  /**
   * A flow is several documents, and a package that shipped only the entry would
   * turn every link to a later page into a 404 — the one failure a reviewer would
   * read as "the export is broken". Each page keeps its own name (so the links
   * keep working) and its own assets (so two pages cannot overwrite each other).
   */
  it('ships every page of a flow, with its own assets', () => {
    const pkg = buildExtensionPackage({
      slug: 'checkout-flow',
      documents: [
        {
          path: 'cart.html',
          page: 'cart',
          html: '<!doctype html><html><head></head><body><a href="orders.html">Orders</a><script>window.entry = 1;</script></body></html>',
        },
        { path: 'orders.html', page: 'orders', html: ordersDocument },
      ],
      entryPage: 'cart',
      indexDocument: INDEX_DOCUMENT,
      patches: [cssPatch],
      builtAt: BUILT_AT,
    })

    // Both pages are in the package, under the names the author linked between.
    expect(file(pkg, 'cart.html')).toContain('<a href="orders.html">Orders</a>')
    expect(file(pkg, 'orders.html')).toContain('<h1>Orders</h1>')

    // Assets are per page: `inline-1.js` in two documents would be one file.
    expect(file(pkg, 'assets/cart/inline-1.js')).toContain('window.entry = 1;')
    expect(pkg.files.filter((entry) => entry.path === 'assets/orders/inline-1.js')).toHaveLength(0)

    // Every page carries the flow's shared patches, exactly as the host serves them.
    expect(file(pkg, 'orders.html')).toContain('href="patches/A-001-btn.css"')
    // …and the artifacts they name are shipped once, at the root, not per page.
    expect(pkg.files.filter((entry) => entry.path === 'patches/A-001-btn.css')).toHaveLength(1)

    const readme = file(pkg, 'README.md')
    expect(readme).toContain('## Pages')
    expect(readme).toContain('- `cart` (scratch) — `cart.html` — the entry page')
    expect(readme).toContain('- `orders` (scratch) — `orders.html`')
  })

  // A page carries the shared patches plus its own, and never another page's: that
  // is the directory rule, and the bundle is where it becomes visible.
  it('gives each page only the javascript patches that apply to it', () => {
    const cartOnly: PrototypePatch = { ...jsPatch, file: 'cart/B-002-badge.js', page: 'cart' }

    const pkg = buildExtensionPackage({
      slug: 'checkout-flow',
      documents: [
        { path: 'cart.html', page: 'cart', html: '<!doctype html><html><head></head><body>cart</body></html>' },
        { path: 'orders.html', page: 'orders', html: ordersDocument },
      ],
      entryPage: 'cart',
      indexDocument: INDEX_DOCUMENT,
      patches: [cssPatch, cartOnly],
      builtAt: BUILT_AT,
    })

    expect(file(pkg, 'cart.html')).toContain('src="assets/cart/__prototype_patches.js"')
    expect(file(pkg, 'assets/cart/__prototype_patches.js')).toContain('is-big')
    expect(file(pkg, 'orders.html')).not.toContain('assets/cart/')
    expect(pkg.files.some((entry) => entry.path === 'assets/orders/__prototype_patches.js')).toBe(false)
  })

  it('says nothing when it had nothing to adapt', () => {
    const pkg = scratchPackage('<!doctype html><html><body><p>Plain</p></body></html>')

    expect(pkg.warnings).toEqual([])
  })

  it('names the page that had to be adapted, not just the count', () => {
    const pkg = buildExtensionPackage({
      slug: 'checkout-flow',
      documents: [
        { path: 'cart.html', page: 'cart', html: '<!doctype html><body><script>a = 1;</script></body>' },
        { path: 'orders.html', page: 'orders', html: '<!doctype html><body><script>b = 2;</script></body>' },
      ],
      entryPage: 'cart',
      indexDocument: INDEX_DOCUMENT,
      patches: [],
      builtAt: BUILT_AT,
    })

    expect(pkg.warnings).toContain('cart.html: 1 inline <script> block(s) were moved into files (inline script is not allowed in an extension page).')
    expect(pkg.warnings).toContain('orders.html: 1 inline <script> block(s) were moved into files (inline script is not allowed in an extension page).')
  })

  /**
   * A live page is a change to a page that already exists, so the extension
   * injects: Chrome scopes the content script to that page, and one page's patches
   * never reach another's.
   */
  it('builds one content script per live page, each carrying only its own files', () => {
    const cartJs: PrototypePatch = { ...jsPatch, file: 'cart/B-002-badge.js', page: 'cart' }
    const payCss: PrototypePatch = { ...cssPatch, file: 'B-001-pay.css', writer: 'B', page: 'pay' }

    const pkg = buildExtensionPackage({
      slug: 'checkout-flow',
      targets: [
        { page: 'cart', url: 'https://app.example.com/cart' },
        { page: 'pay', url: 'https://app.example.com/pay' },
      ],
      entryPage: 'cart',
      indexDocument: INDEX_DOCUMENT,
      patches: [cssPatch, cartJs, payCss],
      builtAt: BUILT_AT,
    })
    const manifest = JSON.parse(file(pkg, 'manifest.json'))

    expect(manifest.content_scripts).toHaveLength(2)
    expect(manifest.content_scripts[0]).toEqual({
      matches: ['https://app.example.com/cart*'],
      run_at: 'document_idle',
      css: ['patches/A-001-btn.css'],
      js: ['assets/cart/__prototype_patches.js'],
    })
    expect(manifest.content_scripts[1]).toEqual({
      matches: ['https://app.example.com/pay*'],
      run_at: 'document_idle',
      css: ['patches/A-001-btn.css', 'patches/B-001-pay.css'],
    })

    expect(file(pkg, 'assets/cart/__prototype_patches.js')).toContain('is-big')
    expect(pkg.files.some((entry) => entry.path === 'assets/pay/__prototype_patches.js')).toBe(false)

    // No document of ours, so nothing to open — but the index is still the options
    // page, because the flow is a list of addresses.
    expect(manifest.options_ui).toEqual({ page: 'index.html', open_in_tab: true })
    expect(pkg.files.some((entry) => entry.path.endsWith('cart.html'))).toBe(false)
  })

  /**
   * The mock layer replaces the page's own `fetch`, so it has to run in the page's
   * world and before the product's code captures a reference — its own content
   * script, not the same one the patches ride in.
   */
  it('carries the contract’s mocks in the page’s own world', () => {
    const pkg = buildExtensionPackage({
      slug: 'checkout-flow',
      targets: [{ page: 'cart', url: 'https://app.example.com/checkout' }],
      entryPage: 'cart',
      indexDocument: INDEX_DOCUMENT,
      patches: [cssPatch],
      mocks: { routes: [mockRoute], store: {} },
      builtAt: BUILT_AT,
    })
    const manifest = JSON.parse(file(pkg, 'manifest.json'))

    expect(manifest.content_scripts[0]).toEqual({
      matches: ['https://app.example.com/checkout*'],
      run_at: 'document_start',
      world: 'MAIN',
      js: ['mocks.js'],
    })
    expect(manifest.content_scripts[1].matches).toEqual(['https://app.example.com/checkout*'])
    expect(file(pkg, 'mocks.js')).toContain('/api/orders')

    // Faked data is the one thing a reader can be misled by without being told.
    const readme = file(pkg, 'README.md')
    expect(readme).toContain('## Faked responses')
    expect(readme).toContain('`GET /api/orders`')
    expect(readme).toContain('service worker')
  })

  it('leaves the mock layer out when the contract declares none', () => {
    const pkg = buildExtensionPackage({
      slug: 'checkout-flow',
      targets: [{ page: 'cart', url: 'https://app.example.com/checkout' }],
      entryPage: 'cart',
      indexDocument: INDEX_DOCUMENT,
      patches: [cssPatch],
      builtAt: BUILT_AT,
    })

    expect(pkg.files.some((entry) => entry.path === 'mocks.js')).toBe(false)
    expect(file(pkg, 'README.md')).not.toContain('## Faked responses')
  })

  it('names the pages it applies to, and what to do after a re-export', () => {
    const pkg = buildExtensionPackage({
      slug: 'checkout-flow',
      targets: [{ page: 'pay', url: 'https://app.example.com/checkout' }],
      entryPage: 'pay',
      indexDocument: INDEX_DOCUMENT,
      patches: [cssPatch, jsPatch],
      builtAt: BUILT_AT,
    })
    const readme = file(pkg, 'README.md')

    expect(readme).toContain('# Prototype — checkout-flow')
    expect(readme).toContain('`https://app.example.com/checkout*`')
    // The flow's order, with the kind on each line: it decides what "open it" means.
    expect(readme).toContain('- `pay` (overlay) — <https://app.example.com/checkout>')
    // Which page each patch changes, or that it changes every page.
    expect(readme).toContain('`A-001-btn.css` — css, writer A, every page')
    expect(readme).toContain('Load unpacked')
    expect(readme).toContain('Reload')
  })

  /**
   * A reviewer who reloads the extension after every change has to be able to
   * tell which build they are looking at, so the version moves with the export.
   */
  it('gives every build its own version', () => {
    const first = scratchPackage()
    const later = buildExtensionPackage({
      slug: 'checkout-flow',
      documents: [{ path: 'cart.html', page: 'cart', html: scratchDocument }],
      entryPage: 'cart',
      indexDocument: INDEX_DOCUMENT,
      patches: [cssPatch],
      builtAt: new Date(BUILT_AT.getTime() + 60_000),
    })

    expect(first.version).toMatch(/^1\.\d+\.\d+$/)
    expect(later.version).not.toBe(first.version)
    expect(JSON.parse(file(first, 'manifest.json')).version).toBe(first.version)
  })
})
