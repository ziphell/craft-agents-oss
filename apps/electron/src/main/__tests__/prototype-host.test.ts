import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { tmpdir } from 'os'
import {
  getPrototypeDirPath,
  prototypeOriginUrl,
  setPrototypeBaseUrlResolver,
  writePrototypeConfig,
} from '@craft-agent/shared/prototypes'
import {
  installPrototypeBaseUrlResolver,
  registerPrototypeProtocolHandler,
  resolveServedPath,
  type ProtocolHostSession,
} from '../prototype-host'

const DIR = resolve('/tmp/workspace/prototypes/checkout-flow')

/**
 * Stand in for the browser session: it only has to remember the handler, so the
 * routing below is exercised with no Electron runtime and no socket.
 */
function fakeSession(): { session: ProtocolHostSession; handler: () => (request: Request) => Promise<Response> } {
  let registered: ((request: Request) => Promise<Response> | Response) | null = null

  return {
    session: {
      protocol: {
        handle: (_scheme, handler) => {
          registered = handler
        },
      },
    },
    handler: () => {
      if (!registered) throw new Error('no handler was registered')
      return async (request: Request) => registered!(request)
    },
  }
}

/** A whole page document, with a marker in it so a response can be recognised. */
function page(body: string): string {
  return `<!doctype html><html><body>${body}</body></html>`
}

interface Host {
  /** The fixture workspace, so a test can write outside the prototype too. */
  workspaceRoot: string
  /** Absolute prototype directory — the fixture writes its pages and patches here. */
  dir: string
  /** The prototype's own origin, e.g. `http://checkout-flow-1a2b3c4d.localhost`. */
  origin: string
  /** Requests handed back to Chromium, in order. */
  passedThrough: string[]
  /** Route one request the way the session would. */
  serve: (url: string, init?: RequestInit) => Promise<Response>
  /** The same, for a path on this prototype's own address. */
  servePath: (path: string, init?: RequestInit) => Promise<Response>
  close: () => void
}

/**
 * A prototype to serve: its own workspace, its own host, and the pass-through
 * recorded in order.
 *
 * Registering happens the way the app does it — through the resolver, when an
 * address is first named — so these tests exercise the wiring and not only the
 * routing. Files are written after the fixture exists: the host reads the disk on
 * every request, which is the property that lets a page be edited without a
 * restart.
 */
function hostFor(slug: string): Host {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-prototype-host-'))
  const dir = getPrototypeDirPath(workspaceRoot, slug)
  mkdirSync(dir, { recursive: true })

  const fake = fakeSession()
  const passedThrough: string[] = []
  registerPrototypeProtocolHandler(fake.session, async (request) => {
    passedThrough.push(request.url)
    return new Response('somebody else', { status: 200, headers: { 'x-passthrough': '1' } })
  })
  const handler = fake.handler()

  installPrototypeBaseUrlResolver()
  // Resolving an address is what registers the prototype — and it is what the app
  // does whenever a prototype is opened, listed or exported.
  const origin = prototypeOriginUrl(workspaceRoot, slug)
  if (!origin) throw new Error(`the fixture prototype ${slug} was not registered`)

  const serve = (url: string, init: RequestInit = {}): Promise<Response> => {
    passedThrough.length = 0
    return handler(new Request(url, init))
  }

  return {
    workspaceRoot,
    dir,
    origin,
    passedThrough,
    serve,
    servePath: (path, init = {}) => serve(new URL(path, origin).toString(), init),
    close: () => {
      setPrototypeBaseUrlResolver(null)
      rmSync(workspaceRoot, { recursive: true, force: true })
    },
  }
}

describe('resolveServedPath', () => {
  it('resolves a file inside the prototype', () => {
    expect(resolveServedPath(DIR, 'base.html')).toBe(resolve(DIR, 'base.html'))
    expect(resolveServedPath(DIR, 'dist/prototype.html')).toBe(resolve(DIR, 'dist/prototype.html'))
  })

  // This function is the only thing standing between a request and arbitrary
  // files on disk, so every spelling of "go up" has to be refused.
  it('refuses to climb out of the prototype', () => {
    expect(resolveServedPath(DIR, '../other-prototype/base.html')).toBeNull()
    expect(resolveServedPath(DIR, 'dist/../../other/base.html')).toBeNull()
    expect(resolveServedPath(DIR, '../../../../etc/passwd')).toBeNull()
  })

  it('refuses an encoded traversal, which decodeURIComponent would otherwise turn back into ../', () => {
    expect(resolveServedPath(DIR, '%2e%2e/other/base.html')).toBeNull()
    expect(resolveServedPath(DIR, '..%2f..%2fetc%2fpasswd')).toBeNull()
  })

  // On Windows a backslash is a separator, so one left in place would smuggle a
  // parent segment past the prefix check.
  it('refuses backslashes and NUL', () => {
    expect(resolveServedPath(DIR, '..\\other\\base.html')).toBeNull()
    expect(resolveServedPath(DIR, 'base.html\0.png')).toBeNull()
  })

  // A sibling whose name merely starts with the same characters is not inside.
  it('refuses a sibling directory sharing the name prefix', () => {
    expect(resolveServedPath(DIR, '../checkout-flow-secrets/base.html')).toBeNull()
  })

  it('refuses a path that is not decodable', () => {
    expect(resolveServedPath(DIR, '%zz')).toBeNull()
  })
})

describe('prototype host', () => {
  const SLUG = 'checkout-flow'
  let host: Host

  beforeAll(() => {
    host = hostFor(SLUG)

    mkdirSync(join(host.dir, 'assets'), { recursive: true })
    mkdirSync(join(host.dir, 'patches', 'cart'), { recursive: true })
    mkdirSync(join(host.dir, 'patches', 'orders'), { recursive: true })

    writeFileSync(join(host.dir, 'cart.html'), page('cart page'), 'utf-8')
    writeFileSync(join(host.dir, 'orders.html'), page('orders page'), 'utf-8')
    // Not declared in the table: a top-level document is a page either way, and
    // `base` is nothing but a name (plan §19.2).
    writeFileSync(join(host.dir, 'base.html'), page('base page'), 'utf-8')
    writeFileSync(join(host.dir, 'assets', 'app.css'), '.a{}', 'utf-8')
    // Outside the prototype, to prove it is not reachable.
    writeFileSync(join(host.workspaceRoot, 'secret.txt'), 'top secret', 'utf-8')

    // One patch every page carries, plus one that belongs to `cart` alone and one
    // that belongs to `orders` alone — the three cases the page rule turns on.
    writeFileSync(join(host.dir, 'patches', 'A-001-shared.css'), 'body { font-weight: 700 }', 'utf-8')
    writeFileSync(join(host.dir, 'patches', 'A-002-shared.js'), "document.body.dataset.marked = 'yes'", 'utf-8')
    writeFileSync(join(host.dir, 'patches', 'cart', 'B-001-cart.css'), 'h1 { color: blue }', 'utf-8')
    writeFileSync(join(host.dir, 'patches', 'orders', 'B-001-orders.css'), 'h2 { color: green }', 'utf-8')

    writePrototypeConfig(host.workspaceRoot, SLUG, {
      pages: [
        { name: 'cart', kind: 'scratch', entry: true },
        { name: 'orders', kind: 'scratch' },
      ],
    })
  })

  afterAll(() => {
    host.close()
  })

  it('hands out one stable host per prototype, with no port', () => {
    // Readable (slug) and unique (directory hash), so two workspaces can both
    // own a `checkout-flow` without being served each other's files.
    expect(new URL(host.origin).hostname).toMatch(/^checkout-flow-[0-9a-f]{8}\.localhost$/)
    // No port: the origin is therefore the same on every run, so cookies and
    // localStorage survive a restart.
    expect(new URL(host.origin).host).not.toContain(':')
    // The prototype's directory is the origin root, not a path under it.
    expect(new URL(host.origin).pathname).toBe('/')
  })

  it('serves a page with the right type and no-store', async () => {
    const response = await host.servePath('/cart.html')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    // A cached page would show a previous state with no hint of staleness.
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.text()).toContain('cart page')
  })

  // The reason the directory is the root: a page that assumes it owns its origin
  // writes `src="/assets/app.css"`, and that must land back on this prototype.
  it('serves root-absolute asset paths', async () => {
    const response = await host.servePath('/assets/app.css')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/css; charset=utf-8')
  })

  // The root follows the page table: it opens the **entry page**, and that page
  // arrives with the patches *it* carries — shared plus its own, never a patch
  // written for another screen (plan §19.3, §19.4).
  it('renders the entry page at the origin root, with the patches it carries', async () => {
    const response = await host.servePath('/')
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(body).toContain('cart page')
    expect(body).toContain('font-weight: 700')
    expect(body).toContain("dataset.marked = 'yes'")
    expect(body).toContain('color: blue')
    expect(body).not.toContain('color: green')
  })

  it('renders a page by its document name, carrying only the patches of that page', async () => {
    const cart = await (await host.servePath('/cart.html')).text()
    expect(cart).toContain('cart page')
    expect(cart).toContain('color: blue')
    expect(cart).not.toContain('color: green')

    const orders = await (await host.servePath('/orders.html')).text()
    expect(orders).toContain('orders page')
    expect(orders).toContain('color: green')
    expect(orders).not.toContain('color: blue')
  })

  // `base.html` is not the prototype's page any more: it is a page named `base`,
  // rendered like any other. There is no "raw draft" address left to look at
  // (plan §19.5, §19 未做).
  it('treats base.html as an ordinary page', async () => {
    const body = await (await host.servePath('/base.html')).text()

    expect(body).toContain('base page')
    expect(body).toContain('font-weight: 700')
  })

  it('applies the shared layout to a page, and uses a layout with no slot as it stands', async () => {
    writeFileSync(
      join(host.dir, '_layout.html'),
      '<!doctype html><html><body><nav id="layout">layout</nav><slot name="page"></slot></body></html>',
      'utf-8',
    )

    const framed = await (await host.servePath('/cart.html')).text()
    expect(framed).toContain('id="layout"')
    expect(framed).toContain('cart page')

    // The slot used to be spelled `<!-- @page -->`, and a layout written then still
    // renders its page: the alternative is that it reads as "a layout with no slot",
    // whose fallback would silently drop the page.
    writeFileSync(
      join(host.dir, '_layout.html'),
      '<!doctype html><html><body><nav id="layout">layout</nav><!-- @page --></body></html>',
      'utf-8',
    )
    expect(await (await host.servePath('/cart.html')).text()).toContain('cart page')

    // A layout with no slot is the whole document, which is a legitimate layout.
    writeFileSync(join(host.dir, '_layout.html'), page('layout alone'), 'utf-8')

    const unplaced = await (await host.servePath('/cart.html')).text()
    expect(unplaced).toContain('layout alone')
    expect(unplaced).not.toContain('cart page')

    // The layout is not a page: served by name, it is the file as written.
    expect(await (await host.servePath('/_layout.html')).text()).toBe(page('layout alone'))

    rmSync(join(host.dir, '_layout.html'), { force: true })
  })

  // A page whose row says the shared layout does not wrap it is served as written —
  // the same document on its own address and at the root — while a page that says
  // nothing keeps the layout. Standing outside the layout is not standing outside the
  // change layer: the patches it carries still land on it (plan §19.2, §19.4).
  it('serves a page as written when its row says the layout does not wrap it', async () => {
    writeFileSync(
      join(host.dir, '_layout.html'),
      '<!doctype html><html><body><nav id="layout">layout</nav><slot name="page"></slot></body></html>',
      'utf-8',
    )
    writeFileSync(join(host.dir, 'solo.html'), page('solo page'), 'utf-8')
    writePrototypeConfig(host.workspaceRoot, SLUG, {
      pages: [
        { name: 'cart', kind: 'scratch' },
        { name: 'solo', kind: 'scratch', useLayout: false },
      ],
    })

    const framed = await (await host.servePath('/cart.html')).text()
    expect(framed).toContain('id="layout"')

    const own = await (await host.servePath('/solo.html')).text()
    expect(own).toContain('solo page')
    expect(own).not.toContain('id="layout"')
    expect(own).toContain('font-weight: 700')

    rmSync(join(host.dir, '_layout.html'), { force: true })
    rmSync(join(host.dir, 'solo.html'), { force: true })
    writePrototypeConfig(host.workspaceRoot, SLUG, {
      pages: [
        { name: 'cart', kind: 'scratch', entry: true },
        { name: 'orders', kind: 'scratch' },
      ],
    })
  })

  // Configuring an entry changes what `/` opens; it never takes the list away.
  it('keeps the page index reachable at /_index', async () => {
    const response = await host.servePath('/_index')
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(body).toContain(SLUG)
    // Every page, in flow order, each with a way into it: a page of ours is its
    // document, and the entry is marked.
    expect(body).toContain('href="/cart.html"')
    expect(body).toContain('href="/orders.html"')
    expect(body).toContain('href="/base.html"')
    expect(body).toContain('class="badge entry"')
  })

  // A history-API route is a real request on reload; the entry document owns the
  // routes of its own origin, so that is what answers (plan §16.3.1).
  it('falls back to the entry document for a history-API route', async () => {
    const response = await host.servePath('/orders/42', { headers: { accept: 'text/html,application/xhtml+xml' } })

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('cart page')
  })

  // …but a missing script must stay a 404: answering it with HTML turns a clear
  // failure into a confusing parse error.
  it('does not fall back for a path that names a file', async () => {
    const response = await host.servePath('/missing.js', { headers: { accept: 'text/html' } })

    expect(response.status).toBe(404)
    expect(await response.text()).not.toContain('<!doctype')
  })

  it('picks up a patch written since the last request, with no export and no restart', async () => {
    expect(await (await host.servePath('/cart.html')).text()).not.toContain('color: red')

    writeFileSync(join(host.dir, 'patches', 'A-003-late.css'), 'body { color: red }', 'utf-8')

    expect(await (await host.servePath('/cart.html')).text()).toContain('color: red')
  })

  /**
   * The one branch that must never be forgotten: `*.localhost` is full of real
   * dev servers, and a host we never handed out an address for is not ours to
   * answer. It goes to the pass-through — the same request Chromium would have
   * made — rather than to a 404 of ours.
   */
  it('hands a host we never handed out back to Chromium', async () => {
    const response = await host.serve('http://not-a-prototype.localhost/base.html')

    expect(response.headers.get('x-passthrough')).toBe('1')
    expect(await response.text()).toBe('somebody else')
    expect(host.passedThrough).toEqual(['http://not-a-prototype.localhost/base.html'])
  })

  it('hands a name with extra labels back too', async () => {
    const response = await host.serve(`http://evil.${new URL(host.origin).hostname}/base.html`)

    expect(response.headers.get('x-passthrough')).toBe('1')
  })

  it('hands everything that is not our host back, whatever it looks like', async () => {
    for (const url of ['http://localhost:3000/checkout', 'http://127.0.0.1:5173/', 'https://example.com/']) {
      const response = await host.serve(url)
      expect(`${url}: ${response.headers.get('x-passthrough')}`).toBe(`${url}: 1`)
    }
    expect(host.passedThrough).toEqual(['https://example.com/'])
  })

  // Note what this does and does not prove: the URL parser normalizes `..` (and
  // its `%2e` spellings) away before the request is even built, so at this level
  // the traversal never reaches the handler. The refusal itself is covered by the
  // `resolveServedPath` tests above — this one only pins the observable outcome,
  // that no spelling reaches the file.
  it('never reaches a file outside the prototype', async () => {
    for (const spelling of ['../secret.txt', '%2e%2e/secret.txt', '..%2fsecret.txt']) {
      const response = await host.servePath(`/${spelling}`)
      expect(`${spelling}: ${response.status}`).toBe(`${spelling}: 404`)
      expect(await response.text()).not.toContain('top secret')
    }
  })

  it('405s anything but GET/HEAD', async () => {
    const posted = await host.servePath('/cart.html', { method: 'POST' })
    expect(posted.status).toBe(405)
    expect(posted.headers.get('allow')).toBe('GET, HEAD')
  })

  it('answers HEAD without a body', async () => {
    const response = await host.servePath('/cart.html', { method: 'HEAD' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(await response.text()).toBe('')
  })
})

/**
 * With no row carrying the entry flag, `/` is the **generated page index**
 * (plan §19.3). That is the default rather than a fallback, because no page of a
 * flow is naturally the first one.
 */
describe('a prototype with no entry page', () => {
  const SLUG = 'no-entry-flow'
  let host: Host

  beforeAll(() => {
    host = hostFor(SLUG)
    mkdirSync(join(host.dir, 'patches'), { recursive: true })
    writeFileSync(join(host.dir, 'cart.html'), page('cart page'), 'utf-8')
    writeFileSync(join(host.dir, 'orders.html'), page('orders page'), 'utf-8')
    writeFileSync(join(host.dir, 'patches', 'A-001-shared.css'), 'body { font-weight: 700 }', 'utf-8')

    writePrototypeConfig(host.workspaceRoot, SLUG, {
      // Declared in this order, so the index can be shown to follow the flow.
      pages: [
        { name: 'orders', kind: 'scratch' },
        { name: 'cart', kind: 'scratch' },
      ],
    })
  })

  afterAll(() => {
    host.close()
  })

  it('lists the pages at the origin root, in flow order', async () => {
    const response = await host.servePath('/')
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(body).toContain('href="/orders.html"')
    expect(body).toContain('href="/cart.html"')
    expect(body.indexOf('/orders.html')).toBeLessThan(body.indexOf('/cart.html'))
  })

  it('serves the same index at /_index', async () => {
    const index = await host.servePath('/_index')

    expect(index.status).toBe(200)
    expect(await index.text()).toBe(await (await host.servePath('/')).text())
  })

  it('renders a page of ours by its document, whether or not it is declared', async () => {
    const body = await (await host.servePath('/cart.html')).text()

    expect(body).toContain('cart page')
    expect(body).toContain('font-weight: 700')
  })

  // A history-API route belongs to the entry page, and here there is none: the
  // answer has to say what does exist instead of guessing (plan §19.3).
  it('404s a route with no entry page to own it, naming what exists', async () => {
    const response = await host.servePath('/orders/42', { headers: { accept: 'text/html' } })
    const body = await response.text()

    expect(response.status).toBe(404)
    expect(body).toContain('"orders"')
    expect(body).toContain('"cart"')
    expect(body).toContain('/_index')
    expect(body).not.toContain('<!doctype')
  })

  // A reserved name is a name, not an override of the filesystem: a real file
  // called `_index` is served as the file it is (plan §19.3).
  it('serves a real file named _index rather than the generated one', async () => {
    writeFileSync(join(host.dir, '_index'), 'a real file, not the index', 'utf-8')

    const response = await host.servePath('/_index')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/octet-stream')
    expect(await response.text()).toBe('a real file, not the index')

    rmSync(join(host.dir, '_index'), { force: true })
    expect(await (await host.servePath('/_index')).text()).toContain('cart')
  })
})

/**
 * One flow may mix both kinds of page (plan §19): the address answers each where
 * it actually lives — a live page at its own address, a page of ours rendered.
 */
describe('a flow that mixes a live page and pages of ours', () => {
  const SLUG = 'mixed-flow'
  let host: Host

  beforeAll(() => {
    host = hostFor(SLUG)
    mkdirSync(join(host.dir, 'patches', 'cart'), { recursive: true })
    mkdirSync(join(host.dir, 'patches', 'pay'), { recursive: true })
    writeFileSync(join(host.dir, 'cart.html'), page('cart page'), 'utf-8')
    writeFileSync(join(host.dir, 'patches', 'A-001-shared.css'), 'body { font-weight: 700 }', 'utf-8')
    writeFileSync(join(host.dir, 'patches', 'cart', 'B-001-cart.css'), 'h1 { color: blue }', 'utf-8')
    writeFileSync(join(host.dir, 'patches', 'pay', 'B-001-pay.css'), 'h2 { color: green }', 'utf-8')
    // A file that happens to share a page's name: files win, so this proves the
    // rule instead of merely exercising it.
    writeFileSync(join(host.dir, 'orders'), 'not a page, a file', 'utf-8')

    writePrototypeConfig(host.workspaceRoot, SLUG, {
      pages: [
        { name: 'pay', kind: 'overlay', url: 'https://app.example.com/pay', entry: true },
        { name: 'orders', kind: 'overlay', url: 'https://app.example.com/orders' },
        { name: 'cart', kind: 'scratch' },
      ],
    })
  })

  afterAll(() => {
    host.close()
  })

  it('points the origin root at the entry page, which is a live one', async () => {
    const response = await host.servePath('/')

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('https://app.example.com/pay')
    // A cached redirect would outlive a renamed page or a moved entry.
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('points a bare page name at that live page', async () => {
    const response = await host.servePath('/pay')

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('https://app.example.com/pay')
  })

  it('serves a file that shares a page name, rather than redirecting', async () => {
    const response = await host.servePath('/orders')

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('not a page, a file')
  })

  it('keeps the page index reachable although the root redirects', async () => {
    const response = await host.servePath('/_index')
    const body = await response.text()

    expect(response.status).toBe(200)
    // A page of ours is a link to its document; a live page is a link to its name
    // on this origin, which is what redirects to its real address — so the index
    // addresses this prototype's own tree, and a moved address cannot go stale.
    expect(body).toContain('href="/cart.html"')
    expect(body).toContain('href="/pay"')
    expect(body).not.toContain('href="https://app.example.com/pay"')
  })

  it('renders a page of ours with only the patches it carries', async () => {
    const body = await (await host.servePath('/cart.html')).text()

    expect(body).toContain('cart page')
    expect(body).toContain('font-weight: 700')
    expect(body).toContain('color: blue')
    // The live page's patch must not land on our document.
    expect(body).not.toContain('color: green')
  })

  // A document request falls back to the entry page's document, and here the
  // entry is somebody else's page: this origin owns no such route.
  it('has no document to fall back to when the entry page is a live one', async () => {
    const response = await host.servePath('/orders/42', { headers: { accept: 'text/html' } })

    expect(response.status).toBe(404)
    expect(await response.text()).not.toContain('<!doctype')
  })

  // A page of ours is addressed by its document (`/cart.html`): a bare name is
  // only a page when it is a live one (plan §19.3).
  it('does not treat a bare name as a page of ours', async () => {
    const response = await host.servePath('/cart', { headers: { accept: 'text/html' } })

    expect(response.status).toBe(404)
  })
})

/**
 * A configured entry page whose document is gone is an **error**, never the
 * index: falling back to the list would turn "your entry page is missing" into
 * "your entry setting did nothing" (plan §19.3).
 */
describe('an entry page whose document is gone', () => {
  const SLUG = 'gone-entry'
  let host: Host

  beforeAll(() => {
    host = hostFor(SLUG)
    writePrototypeConfig(host.workspaceRoot, SLUG, {
      pages: [
        { name: 'cart', kind: 'scratch', entry: true },
        { name: 'orders', kind: 'scratch' },
      ],
    })
    writeFileSync(join(host.dir, 'orders.html'), page('orders page'), 'utf-8')
    // A deliverable frozen at export time: reachable by name, and never what an
    // address means.
    mkdirSync(join(host.dir, 'dist', 'extension'), { recursive: true })
    writeFileSync(join(host.dir, 'dist', 'extension', 'base.html'), page('frozen'), 'utf-8')
  })

  afterAll(() => {
    host.close()
  })

  it('answers an error naming the page and the missing file, not the index', async () => {
    const response = await host.servePath('/')
    const body = await response.text()

    expect(response.status).toBe(404)
    expect(body).toContain('"cart"')
    expect(body).toContain('cart.html')
    // The one thing it must not do: quietly show the list of pages instead.
    expect(body).not.toContain('<!doctype')
  })

  it('still lists the pages at /_index, with the missing one unlinked', async () => {
    const response = await host.servePath('/_index')
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(body).toContain('href="/orders.html"')
    // A dead link would hide the missing screen; the status report says the same
    // thing (`pageIssues`).
    expect(body).not.toContain('href="/cart.html"')
  })

  it('still serves the exported deliverable when it is named', async () => {
    const response = await host.servePath('/dist/extension/base.html')
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(body).toContain('frozen')
    expect(body).not.toContain('cart page')
  })
})
