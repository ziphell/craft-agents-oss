/**
 * Prototype documents, answered by Electron itself.
 *
 * ## Why a real origin at all
 *
 * A prototype page needs one: `file://` is opaque, which costs the cookie jar,
 * relative `fetch`/XHR (so the CDP mock layer never sees a request) and ES
 * modules. See `packages/shared/src/prototypes/url.ts` for the full list.
 *
 * A loopback listener was the first answer and it worked, but its port was
 * ephemeral — so the origin changed on every start, and cookies / `localStorage`
 * did not survive a restart. This module registers an `http` handler on the
 * browser session instead: our own hosts are answered from disk, everything else
 * is handed straight back to Chromium's network stack.
 *
 *   http://<slug>-<hash>.localhost/            ← the entry page, or the page index
 *   http://<slug>-<hash>.localhost/cart.html   ← one of our pages, rendered
 *   http://<slug>-<hash>.localhost/<file path> ← any file in the prototype
 *
 * No port, so the origin is stable across restarts.
 *
 * ## What the interception costs, stated plainly
 *
 * A protocol handler is registered per **scheme** on a **session**, so the host
 * check below decides *who answers*, not *who is involved*: every `http` request
 * in the browser session — including the product page being patched and any real
 * site browsed in it — passes through {@link handlePrototypeRequest} first. That
 * is why:
 *
 * - only `http` is handled. Prototype hosts are `http://…localhost`, so all
 *   `https` traffic of real sites keeps its original path untouched;
 * - anything that is not one of *our* registered labels goes to the pass-through
 *   (`net.fetch(request, { bypassCustomProtocolHandlers: true })` — the same
 *   request Chromium would have made). Real dev servers on `*.localhost` and on
 *   any other host therefore keep working;
 * - the handler never throws: a failure of ours answers 500, rather than turning
 *   into a mystery network error on someone else's page.
 *
 * ## Addressing
 *
 * One host per prototype, and the prototype's directory **is** that host's root.
 * Serving under a path prefix (`/prototypes/<slug>/…`) would break every page that
 * assumes it owns its origin — `src="/assets/app.css"` and `fetch('/api/orders')`
 * resolve to the origin root, and a real page does not know or care that it is
 * being served from a subdirectory.
 *
 * A prototype is a **table of pages** (plan §19), and the address follows it:
 *
 * - `/` is the **entry page**: a live page → 302 to its own address; a page of
 *   ours → that document with the patches it carries (plus the shared layout).
 *   When no row carries the entry flag, `/` is the generated **page index** —
 *   which is the default, because no page of a flow is naturally the first one.
 * - `/_index` is that same index, always: configuring an entry changes what `/`
 *   opens, never takes the list away.
 * - `/<name>.html` is one of our pages, rendered with **exactly the patches it
 *   carries** — the shared `patches/*` plus its own `patches/<name>/*` (§19.4).
 *   `base` is nothing special in this model: `base.html` is a page named `base`.
 * - `/<name>` is a **live** page's name → 302 to its address. An overlay page
 *   keeps its own origin on purpose (its cookies, its session and its JavaScript
 *   are the point), so the host *points* at it instead of serving it.
 * - every other file stays reachable by name (`/assets/…`), and **a file always
 *   wins** over the names above.
 *
 * A page is rendered rather than served as it sits on disk so the address always
 * carries today's patches: neither the raw document (no patches) nor a previously
 * exported file (frozen at export time) is ever mistaken for it. The package's
 * page is the same document *plus* the transformations an extension page requires
 * (inline script hoisted into files, patches referenced as files rather than
 * inlined — see `prototypes/extension.ts`): same patches, same order, same
 * behaviour, not the same bytes.
 *
 * A configured entry page whose document is gone answers an error naming the page
 * and the missing file, rather than falling back to the index: the fallback would
 * turn "your entry page is missing" into "your entry setting did nothing" (§19.3).
 *
 * The label carries both halves because each answers a different question: the
 * hash of the prototype's directory makes it **unique** (two workspaces can both
 * own a `checkout-flow`, and serving one the other's files would be a silent
 * substitution), the slug makes it **readable** in logs and chat.
 *
 * ## SPA support
 *
 * A history-API route (`/orders`) is a real request on reload, and no such file
 * exists. A request that accepts HTML and names no file extension therefore falls
 * back to the **entry page's document** — the one page whose routes those paths
 * are. With no such entry (no entry row, or an entry that is a live page), the
 * path is not something this prototype describes, so it is a 404 that names what
 * does exist. Requests that do name a file (`.js`, `.css`, …) never fall back:
 * answering a missing script with an HTML page turns a clear 404 into a
 * confusing parse error.
 *
 * ## Known limits (deliberate)
 *
 * - A prototype becomes reachable only once the workbench has handed out an
 *   address for it in this run (that is the registration step, and it is also the
 *   security boundary). The address is stable across runs, but the registration
 *   is not: a URL from a previous session answers 404 until its prototype is
 *   opened again.
 * - Because the page arrives with its patches already inlined, there is nothing
 *   for `prototype_tool apply` to do on it — and running the JS patches again would
 *   apply their effects twice. The injector therefore reads the list of what is
 *   already inlined off the document and skips exactly those; patches written
 *   since the render still land on it.
 */

import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { readFile, stat } from 'fs/promises'
import { extname, resolve, sep } from 'path'
import {
  applyPrototypeLayout,
  buildPrototypeIndexDocument,
  buildSelfContainedHtml,
  describePrototypePages,
  findEntryPage,
  getPrototypeDirPath,
  isPrototypePagePath,
  listPrototypePages,
  pageFileName,
  pageNameForFile,
  PROTOTYPE_INDEX_PATH,
  readPrototypeLayout,
  readPrototypePage,
  scanPrototypePatchesForPage,
  setPrototypeBaseUrlResolver,
  type PrototypePage,
} from '@craft-agent/shared/prototypes'
import { mainLog } from './logger'

/** Any `*.localhost` resolves to loopback in Chromium, so no DNS entry is needed. */
const HOST_SUFFIX = '.localhost'

/** A DNS label caps at 63 chars; the slug part is truncated to leave room for `-` + 8 hex. */
const MAX_LABEL_LENGTH = 63
const HASH_LENGTH = 8
const SLUG_BUDGET = MAX_LABEL_LENGTH - HASH_LENGTH - 1

/** `/_index` as a request arrives: the pathname with its leading slash stripped. */
const INDEX_REQUEST = PROTOTYPE_INDEX_PATH.replace(/^\//, '')

export interface ServedPrototype {
  workspaceRootPath: string
  slug: string
  /** Absolute prototype directory — this host's root. */
  dir: string
}

/** label → prototype. Populated only by the resolver below. */
const served = new Map<string, ServedPrototype>()

/** Set once the protocol handler is installed: without it, no address is handed out. */
let answering = false

/** Hand a request back to Chromium's own network stack. */
export type PassThrough = (request: Request) => Promise<Response>

/**
 * The piece of `Electron.Session` this module needs.
 *
 * Structural on purpose: the routing below is the interesting part and it has to
 * be testable without an Electron runtime (and without `electron` being imported
 * at all, which in a plain Node/Bun process is a path string rather than the API).
 */
export interface ProtocolHostSession {
  protocol: {
    handle(scheme: string, handler: (request: Request) => Promise<Response> | Response): void
  }
}

/**
 * Which prototype an address names, if any.
 *
 * The workbench's own addresses are readable rather than opaque — `<slug>-<hash>`
 * is the slug plus the directory hash — so one can be turned back into the
 * prototype it names. Used by a browser window's address bar: typing a
 * prototype's address means "show me that prototype", which is a different thing
 * from navigating a page (a live page has no document of ours at that address;
 * see `resolvePrototypeEntry`).
 *
 * Null for anything else — a foreign host cannot be dressed up as one of these,
 * since the label has to end in our own suffix. The *port* is deliberately not
 * part of the match: addresses were once port-scoped, and one that still names
 * the prototype should still work.
 */
export function resolveServedPrototype(url: string): ServedPrototype | null {
  let host: string
  try {
    host = new URL(url).host
  } catch {
    return null
  }
  const label = labelFromHost(host)
  return label ? served.get(label) ?? null : null
}

/**
 * The host label for a prototype: readable (slug) and unique (directory hash).
 *
 * Deriving uniqueness from the directory rather than trusting the slug is the
 * point — a slug is only unique within one workspace.
 */
export function prototypeLabel(slug: string, dir: string): string {
  const hash = createHash('sha256').update(resolve(dir)).digest('hex').slice(0, HASH_LENGTH)
  const readable = slug
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, SLUG_BUDGET)
    .replace(/-+$/, '')
  return readable ? `${readable}-${hash}` : hash
}

/** `slug-hash.localhost` (with or without a port) → `slug-hash`. Null for anything else. */
export function labelFromHost(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null
  const host = hostHeader.split(':')[0]!.trim().toLowerCase()
  if (!host.endsWith(HOST_SUFFIX)) return null

  const label = host.slice(0, -HOST_SUFFIX.length)
  // Exactly one label: `a.b.localhost` would otherwise reach for a prototype
  // through a name nobody handed out.
  return label && !label.includes('.') ? label : null
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
}

/**
 * Map a request path onto a file inside `dir`.
 *
 * Exported because it is the security boundary of this host and deserves its own
 * tests: everything outside `dir` must be unreachable, however the path is
 * spelled.
 */
export function resolveServedPath(dir: string, relativePath: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(relativePath)
  } catch {
    return null
  }

  // Reject NUL and backslashes outright: on Windows a backslash is a separator,
  // so letting one through would smuggle a parent segment past the check below.
  if (decoded.includes('\0') || decoded.includes('\\')) return null

  const root = resolve(dir)
  const target = resolve(root, decoded)
  // `resolve` collapses `..`, so the prefix test is sufficient — and it must be
  // `${root}${sep}` so that a sibling directory sharing the prefix cannot match.
  if (target !== root && !target.startsWith(root + sep)) return null

  return target
}

/** Is this a navigation, i.e. may an SPA route fall back to the entry document? */
function isDocumentRequest(pathname: string, accept: string | undefined): boolean {
  const extension = extname(pathname).toLowerCase()
  const namesAFile = extension !== '' && extension !== '.html'
  return !namesAFile && (accept ?? '').includes('text/html')
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

interface Payload {
  body: Buffer
  contentType: string
}

/** A plain-text response, for the refusals (which are looked at by a person or a log, not a page). */
function text(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers },
  })
}

/**
 * A redirect, for a live page.
 *
 * The prototype is addressable here; the page itself lives at its own address and
 * has to keep living there — its cookies, its session and its origin are the whole
 * point of an overlay. So the host *points* at it instead of serving it.
 *
 * 302, not 301: the mapping is edited (pages get renamed, the entry page moves),
 * and a permanently-cached redirect would outlive the change.
 */
function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store' } })
}

/**
 * The live address a bare page name points at, when that page is an **overlay**.
 *
 * One level deep, because that is how pages are named (`/pay`, not `/pay/42` — a
 * route deeper than that belongs to the app, on its own origin). Files win over
 * names: the caller asks this only when no file matched the path.
 *
 * Null for a page of ours: that page is addressed by its document
 * (`/cart.html`), which the renderer below answers — a name that is not a file
 * and not a live page is a route inside a document, not a page.
 */
function overlayPageUrl(prototype: ServedPrototype, requested: string): string | null {
  const page = listPrototypePages(prototype.workspaceRootPath, prototype.slug).find(
    (candidate) => candidate.name === requested,
  )
  return page?.kind === 'overlay' ? page.url : null
}

/**
 * A page of ours, rendered the way its address serves it: the document, the layout
 * it may share, and **exactly the patches it carries**.
 *
 * `scanPrototypePatchesForPage` is the one rule for "what this page carries" — the
 * shared `patches/*` plus its own `patches/<page>/*` (plan §19.4) — and it is also
 * what export packages with, so the page previewed here and the page delivered
 * cannot disagree. The prototype's whole patch set must never be inlined in its
 * place: a patch written for another screen would land on this one.
 *
 * The layout comes from `_layout.html` (optional) and is applied *before* the
 * patches, exactly as export writes it, so both see the same document (§19.2) —
 * unless the page's row says the layout does not wrap it (`"useLayout": false`),
 * which is how a page that is a design of its own is served as written.
 */
function buildPrototypePage(
  prototype: ServedPrototype,
  page: string,
  document: string,
  useLayout: boolean,
): Payload {
  const withLayout = applyPrototypeLayout(
    document,
    useLayout ? readPrototypeLayout(prototype.workspaceRootPath, prototype.slug) : null,
  )
  const rendered = buildSelfContainedHtml(
    withLayout,
    scanPrototypePatchesForPage(prototype.workspaceRootPath, prototype.slug, page),
  )
  return { body: Buffer.from(rendered, 'utf8'), contentType: 'text/html; charset=utf-8' }
}

/**
 * One of our pages, addressed by its row — the entry page, or the page a request
 * names. Null when its document is gone (`file: null` in the table, or a file
 * removed since the table was read).
 */
function pagePayload(prototype: ServedPrototype, page: PrototypePage): Payload | null {
  if (page.kind !== 'scratch' || !page.file) return null
  const document = readPrototypePage(prototype.workspaceRootPath, prototype.slug, page.file)
  return document === null
    ? null
    : buildPrototypePage(prototype, page.name, document, page.useLayout)
}

/**
 * The generated page index: every page, with a way into each (plan §19.3).
 *
 * Generated per request from the page table rather than stored, so it cannot
 * become a second answer to "what pages are there". It belongs to no page, so it
 * is neither wrapped in the layout nor patched.
 *
 * Every link is root-absolute and stays on this origin — a page of ours is its
 * document (`/cart.html`) and a live page is its name (`/pay`), which is what the
 * redirect above answers. Pointing a live page straight at its address would put
 * a third party's URL in the list, and it would go stale the moment the address
 * changed; this way the index always addresses the prototype's own tree. A page
 * with nothing to open (its document gone, or a row with no address) is left
 * unlinked by `buildPrototypeIndexDocument`.
 */
function indexPayload(prototype: ServedPrototype): Payload {
  const { pages } = describePrototypePages(prototype.workspaceRootPath, prototype.slug)
  const document = buildPrototypeIndexDocument({
    slug: prototype.slug,
    pages,
    href: (page) =>
      page.kind === 'overlay' ? (page.url ? `/${page.name}` : null) : page.file ? `/${page.file}` : null,
  })
  return { body: Buffer.from(document, 'utf8'), contentType: 'text/html; charset=utf-8' }
}

/**
 * A file inside the prototype, rendered when it is a page of it.
 *
 * Every top-level `*.html` in the directory is a page of the prototype (plan
 * §19), so each is served the way an addressed page is: the document with the
 * patches it carries, computed here rather than written. Two kinds of document
 * are deliberately *not* rendered, because they are not pages:
 *
 * - `_`-prefixed files — `_layout.html` is the layout, and the host's own reserved
 *   names live under the same rule (`isPrototypePagePath`), so a layout stays
 *   readable exactly as an author wrote it;
 * - anything under a subdirectory (`/flows/step1.html`) — pages live at the root
 *   of the prototype, and a document in a subdirectory is an asset.
 *
 * `dist/` needs no special case for the same reason: it is a subdirectory.
 */
async function filePayload(path: string, prototype: ServedPrototype, requested: string): Promise<Payload> {
  if (isPrototypePagePath(requested)) {
    const name = pageNameForFile(requested)
    // Addressed by its document name or by its page name, a page is served the same
    // way, so its row decides about the layout here too. Every top-level document is
    // a page (`pages.ts`), declared or not, so the row is there; the default only
    // covers a document that appeared between the check above and this read.
    const page = listPrototypePages(prototype.workspaceRootPath, prototype.slug).find(
      (candidate) => candidate.name === name,
    )
    return buildPrototypePage(prototype, name, await readFile(path, 'utf-8'), page?.useLayout ?? true)
  }
  return {
    body: await readFile(path),
    contentType: CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
  }
}

/**
 * The answer for a path this prototype does not describe, naming what it does.
 *
 * "It does not exist" is not something a reader can act on; the pages it does
 * have, and `/_index`, are.
 */
function nothingToServe(prototype: ServedPrototype, requested: string): Response {
  const { pages } = describePrototypePages(prototype.workspaceRootPath, prototype.slug)
  const has =
    pages.length > 0
      ? `pages ${pages.map((page) => `"${page.name}"`).join(', ')}`
      : 'no pages yet (write a top-level <name>.html, or add a live page)'
  return text(
    404,
    `Nothing to serve at /${requested}. This prototype has ${has}; the page index is at ${PROTOTYPE_INDEX_PATH}.`,
  )
}

/** A rendered document, or a file, as the answer to `request`. */
function payloadResponse(request: Request, payload: Payload): Response {
  return new Response(request.method === 'HEAD' ? null : new Uint8Array(payload.body), {
    status: 200,
    headers: {
      'content-type': payload.contentType,
      // The document and its patches are edited constantly; a cached page would
      // show an earlier state with no hint that it is stale.
      'cache-control': 'no-store',
      // The document is ours, but it may embed third-party snapshots; keep it
      // from claiming the privileges of the app shell.
      'x-content-type-options': 'nosniff',
    },
  })
}

/**
 * Route one `http` request: ours from disk, everyone else's back to Chromium.
 *
 * The two branches are deliberately in this order, and the first one is the only
 * one that can make a claim about a page: a host we did not hand out an address
 * for is never ours to answer, however much it looks like one of ours
 * (`*.localhost` is full of real dev servers).
 */
export async function handlePrototypeRequest(request: Request, passThrough: PassThrough): Promise<Response> {
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return passThrough(request)
  }

  const label = labelFromHost(url.host)
  const prototype = label ? served.get(label) : undefined
  if (!prototype) return passThrough(request)

  try {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return text(405, '', { allow: 'GET, HEAD' })
    }

    const requested = url.pathname.replace(/^\/+/, '')

    // A file always wins, over every name below: the prototype is an ordinary
    // directory served at its root, and a page name (`/_index`, `/pay`) is the
    // only thing this host interprets instead of looking up.
    if (requested) {
      const candidate = resolveServedPath(prototype.dir, requested)
      if (!candidate) return text(404, 'Path escapes the prototype directory.')
      if (await isFile(candidate)) {
        return payloadResponse(request, await filePayload(candidate, prototype, requested))
      }
    }

    let payload: Payload | null = null

    if (!requested) {
      // The origin root is the prototype's **entry page** (plan §19.3): the live
      // address of a page that is not ours, a page of ours rendered, or — when no
      // row carries the entry flag, which is the default — the page index.
      const entry = findEntryPage(listPrototypePages(prototype.workspaceRootPath, prototype.slug))

      if (!entry) {
        payload = indexPayload(prototype)
      } else if (entry.kind === 'overlay') {
        if (!entry.url) {
          return text(
            404,
            `Page "${entry.name}" is the entry page of "${prototype.slug}", but its row records no address, ` +
              `so there is no live page to open.`,
          )
        }
        return redirect(entry.url)
      } else {
        payload = pagePayload(prototype, entry)
        // A configured entry whose document is gone is an error, never the
        // index: falling back would turn "your entry page is missing" into "your
        // entry setting did nothing" (plan §19.3).
        if (!payload) {
          return text(
            404,
            `The entry page "${entry.name}" has no document: ${pageFileName(entry.name)} is not in ${prototype.dir}. ` +
              `Write it, point the entry at another page, or see ${PROTOTYPE_INDEX_PATH} for the pages that do exist.`,
          )
        }
      }
    } else if (requested === INDEX_REQUEST) {
      // Always reachable, whatever `/` opens: configuring an entry changes what
      // the root opens, never takes the list away (plan §19.3).
      payload = indexPayload(prototype)
    } else {
      // A bare page name is a live page (`/pay`): only that kind has an address
      // of its own to point at.
      const live = overlayPageUrl(prototype, requested)
      if (live) return redirect(live)

      if (isDocumentRequest(url.pathname, request.headers.get('accept') ?? undefined)) {
        // A history-API route: no such file, and no live page by that name — so
        // it is a path *inside* the entry document, which is the one page of ours
        // whose routes these are. Without such an entry, this prototype does not
        // describe the path at all.
        const entry = findEntryPage(listPrototypePages(prototype.workspaceRootPath, prototype.slug))
        payload = entry ? pagePayload(prototype, entry) : null
      }
    }

    if (!payload) return nothingToServe(prototype, requested)

    return payloadResponse(request, payload)
  } catch (error) {
    // Never hand someone else's page a network error because *we* failed: this
    // branch is only reachable for a host that is ours.
    mainLog.warn(`[prototype-host] failed to serve ${request.url}: ${String(error)}`)
    return text(500, 'The prototype could not be served. See the workbench logs.')
  }
}

/**
 * Answer prototype hosts on `http`, on the session the browser windows use.
 *
 * `passThrough` is supplied by the caller rather than imported here, so this
 * module stays free of an `electron` import (see {@link ProtocolHostSession}).
 */
export function registerPrototypeProtocolHandler(ses: ProtocolHostSession, passThrough: PassThrough): void {
  ses.protocol.handle('http', (request) => handlePrototypeRequest(request, passThrough))
  answering = true
  mainLog.info(`[prototype-host] answering prototypes at http://<slug>-<hash>${HOST_SUFFIX}/`)
}

/**
 * Install the resolver the shared layer calls when it builds a prototype URL.
 *
 * Registration happens here, on demand: **naming a prototype's address is what
 * makes it reachable**, and the addresses the workbench names are the ones it
 * shows — an opened or exported prototype, and (since pages are listed, §19) every
 * prototype whose pages the panel or a command enumerates. The host never walks
 * the filesystem looking for things to serve, and the label still has to be the
 * slug plus the directory's hash, so what this widens is only "the prototypes this
 * workspace already lists".
 *
 * Null until {@link registerPrototypeProtocolHandler} has run: handing out an
 * address nobody answers would be worse than saying the prototype has no page.
 */
export function installPrototypeBaseUrlResolver(): void {
  setPrototypeBaseUrlResolver((workspaceRootPath, slug) => {
    if (!answering) return null

    const dir = resolve(getPrototypeDirPath(workspaceRootPath, slug))
    if (!existsSync(dir)) return null

    const label = prototypeLabel(slug, dir)
    served.set(label, { workspaceRootPath, slug, dir })

    return `http://${label}${HOST_SUFFIX}`
  })
}
