/**
 * Loopback HTTP server for prototype documents.
 *
 * ## Why this exists
 *
 * Prototype pages used to be opened as `file://`, which has an opaque origin.
 * That costs a cookie jar, relative `fetch`/XHR (so the CDP mock layer never saw
 * a request) and ES modules — all three of which this workbench needs. See
 * `packages/shared/src/prototypes/url.ts` for the full reasoning.
 *
 * Rather than intercepting `http` in the browser session — which would route
 * *every real page load* (including the product page we are patching) through
 * this file, because all browser instances share one session partition — the
 * prototype gets its own origin on a server we run. Nothing about real browsing
 * changes; there is no pass-through code to get wrong.
 *
 * ## Addressing
 *
 *   http://<slug>-<hash>.localhost:<port>/            ← the prototype's page
 *   http://<slug>-<hash>.localhost:<port>/<file path> ← any file in the prototype
 *
 * The root is the prototype **rendered**: `base.html` with every patch applied,
 * computed per request. It is byte-identical to what `prototype-export` would
 * write right now, so "what I'm looking at" and "what I would ship" are the same
 * document, and neither the raw base page (no patches) nor a previously exported
 * file (frozen at export time) is ever mistaken for it. Individual files stay
 * reachable by name — `/base.html` is the raw page, `/dist/prototype.html` the
 * frozen deliverable.
 *
 * One host per prototype, and the prototype's directory **is** that host's root.
 * Serving under a path prefix (`/prototypes/<slug>/…`) would break every page
 * that assumes it owns its origin — `src="/assets/app.css"` and
 * `fetch('/api/orders')` resolve to the origin root, and a real page does not
 * know or care that it is being served from a subdirectory.
 *
 * The label carries both halves because each answers a different question:
 * the hash of the prototype's directory makes it **unique** (two workspaces can
 * both own a `checkout-flow`, and serving one the other's files would be a
 * silent substitution), the slug makes it **readable** in logs and chat.
 *
 * ## SPA support
 *
 * A history-API route (`/orders`) is a real request on reload, and no such file
 * exists. A request that accepts HTML and has no file extension therefore falls
 * back to the prototype's page. Requests that do name a file (`.js`, `.css`, …)
 * never fall back: answering a missing script with an HTML page turns a clear
 * 404 into a confusing parse error.
 *
 * ## Known limits (deliberate)
 *
 * - The port is ephemeral, so the origin changes between app runs. Cookies and
 *   `localStorage` therefore do not survive a restart. Nothing in the prototype
 *   flow depends on that; a stable port could be added if it ever does.
 * - A prototype becomes reachable only once the workbench has handed out an
 *   address for it in this run (that is the registration step, and it is also the
 *   security boundary). Pasting a URL from a previous session into a fresh one
 *   therefore 404s — as it must, since the port changed too.
 * - Because the page arrives with its patches already inlined, `prototype-apply`
 *   is not needed for it — that command is for a *foreign* document (the real
 *   product page an overlay targets, or a raw file). Applying to a page that is
 *   already baked runs the JS patches a second time.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { readFile, stat } from 'fs/promises'
import { extname, resolve, sep } from 'path'
import {
  buildSelfContainedHtml,
  getPrototypeDirPath,
  readPrototypeBase,
  resolvePrototypeEntry,
  scanPrototypePatches,
  setPrototypeBaseUrlResolver,
} from '@craft-agent/shared/prototypes'
import { mainLog } from './logger'

/** Any `*.localhost` resolves to loopback in Chromium, so no DNS entry is needed. */
const HOST_SUFFIX = '.localhost'

/** A DNS label caps at 63 chars; the slug part is truncated to leave room for `-` + 8 hex. */
const MAX_LABEL_LENGTH = 63
const HASH_LENGTH = 8
const SLUG_BUDGET = MAX_LABEL_LENGTH - HASH_LENGTH - 1

interface ServedPrototype {
  /** Needed to ask `resolvePrototypeEntry` for the page — it takes (root, slug). */
  workspaceRootPath: string
  slug: string
  /** Absolute prototype directory — this host's root. */
  dir: string
}

/**
 * The prototype's page: `base.html` with every patch applied.
 *
 * This is the exporter's transform, computed instead of written — so the address
 * always shows the current state, and the page a reviewer opens is byte-identical
 * to what `prototype-export` would produce right now. Serving the raw base page
 * would show a document with none of the changes, and serving a previously
 * exported file would show one frozen at export time; neither is the prototype.
 *
 * Returns null when there is no base page to build from (see {@link entryDocument}
 * for what the address falls back to).
 */
function renderPage(prototype: ServedPrototype): string | null {
  const base = readPrototypeBase(prototype.workspaceRootPath, prototype.slug)
  if (base === null) return null
  return buildSelfContainedHtml(base, scanPrototypePatches(prototype.workspaceRootPath, prototype.slug))
}

/**
 * The file the page falls back to when there is nothing to render — the frozen
 * deliverable, for a prototype whose base page was deleted after exporting.
 *
 * Asks `resolvePrototypeEntry` rather than deciding again, so the address the
 * workbench hands out and what this server serves cannot drift apart.
 */
function entryDocument(prototype: ServedPrototype): string | null {
  try {
    return resolvePrototypeEntry(prototype.workspaceRootPath, prototype.slug).path
  } catch {
    // Nothing to serve at all — not an error state, just an empty prototype.
    return null
  }
}

/** label → prototype. Populated only by the resolver below. */
const served = new Map<string, ServedPrototype>()

let server: Server | null = null
let port = 0

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

/** `slug-hash.localhost:1234` → `slug-hash`. Null for anything else. */
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
 * Exported because it is the security boundary of this server and deserves its
 * own tests: everything outside `dir` must be unreachable, however the path is
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

async function filePayload(path: string): Promise<Payload> {
  return {
    body: await readFile(path),
    contentType: CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
  }
}

/**
 * What the prototype's own address serves: the rendered page, or — when there is
 * no base page left to render — the frozen deliverable.
 */
async function pagePayload(prototype: ServedPrototype): Promise<Payload | null> {
  const rendered = renderPage(prototype)
  if (rendered !== null) {
    return { body: Buffer.from(rendered, 'utf8'), contentType: 'text/html; charset=utf-8' }
  }

  const fallback = entryDocument(prototype)
  return fallback && (await isFile(fallback)) ? filePayload(fallback) : null
}

async function serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const fail = (status: number, reason: string) => {
    response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
    response.end(reason)
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { allow: 'GET, HEAD' })
    response.end()
    return
  }

  const label = labelFromHost(request.headers.host)
  const prototype = label ? served.get(label) : undefined
  if (!prototype) {
    fail(404, 'No prototype is served at this address. Open one from the workbench.')
    return
  }

  const pathname = new URL(request.url ?? '/', `http://${HOST_SUFFIX}`).pathname
  const requested = pathname.replace(/^\/+/, '')

  let payload: Payload | null = null
  if (!requested) {
    // The origin root is the prototype's page, so a bare address is openable.
    payload = await pagePayload(prototype)
  } else {
    const candidate = resolveServedPath(prototype.dir, requested)
    if (!candidate) {
      fail(404, 'Path escapes the prototype directory.')
      return
    }
    if (await isFile(candidate)) {
      payload = await filePayload(candidate)
    } else if (isDocumentRequest(pathname, request.headers.accept)) {
      // A history-API route: no such file, but the SPA owns this path.
      payload = await pagePayload(prototype)
    }
  }

  if (!payload) {
    fail(404, `Nothing to serve: ${requested || 'this prototype has no page yet'}`)
    return
  }

  response.writeHead(200, {
    'content-type': payload.contentType,
    'content-length': payload.body.byteLength,
    // Prototypes are edited and re-captured constantly; a cached base.html would
    // show the previous capture with no hint that it is stale.
    'cache-control': 'no-store',
    // The document is ours, but it may embed third-party snapshots; keep it from
    // claiming the privileges of the app shell.
    'x-content-type-options': 'nosniff',
  })
  response.end(request.method === 'HEAD' ? undefined : payload.body)
}

/**
 * Bind the server. Resolves to the port, or null when binding failed — a
 * prototype page then falls back to `file://`, which is worse but not fatal.
 */
export async function startPrototypeServer(): Promise<number | null> {
  if (server) return port

  try {
    server = createServer((request, response) => {
      serve(request, response).catch((error) => {
        mainLog.warn(`[prototype-server] request failed: ${String(error)}`)
        if (!response.headersSent) response.writeHead(500)
        response.end()
      })
    })

    await new Promise<void>((resolveListen, rejectListen) => {
      server!.once('error', rejectListen)
      // 127.0.0.1 only: this serves local files and must not be reachable from
      // the network. Port 0 lets the OS pick, so nothing here can collide with
      // (or be squatted by) another process.
      server!.listen(0, '127.0.0.1', resolveListen)
    })

    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('no port assigned')
    port = address.port
    mainLog.info(`[prototype-server] serving prototypes at http://<slug>-<hash>${HOST_SUFFIX}:${port}/`)
    return port
  } catch (error) {
    mainLog.warn(`[prototype-server] failed to start, prototypes fall back to file://: ${String(error)}`)
    server = null
    port = 0
    return null
  }
}

/**
 * Install the resolver the shared layer calls when it builds a prototype URL.
 *
 * Registration happens here, on demand, so only prototypes that were actually
 * opened (or exported) become reachable — the server itself never walks the
 * filesystem to find what to serve.
 */
export function installPrototypeBaseUrlResolver(): void {
  setPrototypeBaseUrlResolver((workspaceRootPath, slug) => {
    if (!port) return null

    const dir = resolve(getPrototypeDirPath(workspaceRootPath, slug))
    if (!existsSync(dir)) return null

    const label = prototypeLabel(slug, dir)
    served.set(label, { workspaceRootPath, slug, dir })

    return `http://${label}${HOST_SUFFIX}:${port}`
  })
}
