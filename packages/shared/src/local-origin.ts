/**
 * The app's own origins: `<label>.localhost`, answered from disk.
 *
 * A directory is served this way: it is reachable at an origin of its own, so
 * its documents can load their own files by root-absolute path, keep state in
 * `localStorage`, and `fetch` their own endpoints. The mechanism lives here rather than
 * inside each feature because the security-relevant half is here: the label a directory is
 * reachable at, the suffix that makes that label resolvable, the fence that keeps a
 * request inside the directory it names, and the content types a file is answered with.
 * What a feature *serves* is its own business.
 *
 * ## Why the label carries a hash
 *
 * `<slug>-<8 hex of the resolved directory>`: a slug is unique only within one workspace,
 * so the readable part is for a person reading an address bar and the hash is the
 * identity. Two directories that share a slug — the same name in two places — get
 * two labels, and neither can answer for the other.
 *
 * ## Why `*.localhost` and not a port
 *
 * `*.localhost` resolves to loopback in Chromium, so no DNS entry is needed and no
 * port is involved — which is what makes the origin the same on every start. That
 * matters because the origin is the key cookies and `localStorage` are stored under:
 * an ephemeral port changed the origin on every launch.
 */

import { createHash } from 'crypto'
import { extname, resolve, sep } from 'path'

/** Any `*.localhost` resolves to loopback in Chromium, so no DNS entry is needed. */
export const LOCAL_HOST_SUFFIX = '.localhost'

/** A DNS label caps at 63 chars; the slug part is truncated to leave room for `-` + 8 hex. */
const MAX_LABEL_LENGTH = 63
const HASH_LENGTH = 8
const SLUG_BUDGET = MAX_LABEL_LENGTH - HASH_LENGTH - 1

/**
 * The host label for a directory: readable (the slug) and unique (the directory hash).
 *
 * Deriving uniqueness from the directory rather than trusting the slug is the point —
 * a slug is only unique within one workspace, and two features can hold the same one.
 */
export function localHostLabel(slug: string, dir: string): string {
  const hash = createHash('sha256').update(resolve(dir)).digest('hex').slice(0, HASH_LENGTH)
  const readable = slug
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, SLUG_BUDGET)
    .replace(/-+$/, '')
  return readable ? `${readable}-${hash}` : hash
}

/** The origin a label is reachable at. No trailing slash: it is an origin, not a URL. */
export function localHostOrigin(label: string): string {
  return `http://${label}${LOCAL_HOST_SUFFIX}`
}

/** `slug-hash.localhost` (with or without a port) → `slug-hash`. Null for anything else. */
export function labelFromHost(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null
  const host = hostHeader.split(':')[0]!.trim().toLowerCase()
  if (!host.endsWith(LOCAL_HOST_SUFFIX)) return null

  const label = host.slice(0, -LOCAL_HOST_SUFFIX.length)
  // Exactly one label: `a.b.localhost` would otherwise reach for something
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
  // Stencil and mxgraph geometry files: XML documents, not opaque blobs. The wrong
  // type is not cosmetic here — responses carry `nosniff`, so a font or a document
  // answered as octet-stream is dropped by the browser rather than decoded.
  '.xml': 'application/xml; charset=utf-8',
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
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
}

/** The content type a file at `path` is answered with. */
export function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Map a request path onto a file inside `dir`.
 *
 * Exported because it is the security boundary of these hosts and deserves its own
 * tests: everything outside `dir` must be unreachable, however the path is spelled.
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

/**
 * Is this a navigation, i.e. may a history-API route fall back to a document?
 *
 * A path that names a file (`.js`, `.css`, …) never falls back: answering a missing
 * script with an HTML document turns a clear 404 into a confusing parse error.
 */
export function isDocumentRequest(pathname: string, accept: string | undefined): boolean {
  const extension = extname(pathname).toLowerCase()
  const namesAFile = extension !== '' && extension !== '.html'
  return !namesAFile && (accept ?? '').includes('text/html')
}
