/**
 * Where a prototype document is opened from.
 *
 * Prototype pages are **not** opened as `file://`. That scheme has an opaque
 * origin, which costs exactly three things this workbench depends on:
 *
 * 1. **No cookie jar** — nothing can model a signed-in state, and
 *    `document.cookie` is a no-op.
 * 2. **No relative `fetch`/XHR** — Blink blocks file→file requests before they
 *    reach the network, which means the CDP mock layer (browser-cdp.ts, keyed on
 *    pathname) never sees a request to answer. The whole "契约 → mock → 前端"
 *    loop is unusable on an exported deliverable.
 * 3. **No ES modules** — `<script type="module">` is fetched with CORS and fails.
 *
 * So the host may install a resolver that maps (workspace, slug) onto a loopback
 * HTTP address it serves (`apps/electron/src/main/prototype-server.ts`). An HTTP
 * origin gives all three back, and it is what lets the mock layer answer a
 * prototype's own API calls.
 *
 * With no resolver installed — unit tests, or any host that runs no such server
 * — URLs fall back to `file://`. That is still correct for a document with no
 * cookies, no API calls and no modules, so nothing breaks for those callers.
 */

import { relative, sep } from 'path'
import { pathToFileURL } from 'url'
import { getPrototypeDirPath } from './storage.ts'

/**
 * Host-supplied mapping from a prototype to the origin its files are served
 * under. Returns null when this prototype cannot be served (unknown workspace,
 * no server running) — the caller then falls back to `file://`.
 *
 * It deliberately takes no file path: which file a prototype's *page* is, is
 * `resolvePrototypeEntry`'s rule, and the host asks that directly rather than
 * being told by whichever call happened to build a URL first.
 */
export type PrototypeBaseUrlResolver = (workspaceRootPath: string, slug: string) => string | null

let resolveBaseUrl: PrototypeBaseUrlResolver | null = null

/** Installed once by the host at startup. Pass `null` to uninstall. */
export function setPrototypeBaseUrlResolver(resolver: PrototypeBaseUrlResolver | null): void {
  resolveBaseUrl = resolver
}

/**
 * The prototype's origin root — where its **rendered page** is served.
 *
 * That page is `base.html` with every patch applied, computed per request (see
 * `prototype-server.ts`), so the address is stable no matter which patches exist
 * or whether anything has been exported. Null when nothing serves prototypes.
 */
export function prototypeOriginUrl(workspaceRootPath: string, slug: string): string | null {
  return resolveBaseUrl?.(workspaceRootPath, slug) ?? null
}

/**
 * Absolute path of a file inside a prototype → the address to open it at.
 *
 * The prototype's directory is that address's **root**, and the path is made
 * relative to it. Two things follow, and both matter for real pages:
 *
 * - Root-absolute references (`/assets/app.css`, `fetch('/api/orders')`) land
 *   back on this prototype instead of on some shared prefix it does not know
 *   about. Serving under a path prefix breaks exactly the pages that assume they
 *   own their origin, which is most of them.
 * - Relative references (`logo.png`) resolve to the same place, because the
 *   entry document sits at the root too.
 *
 * Prefer {@link prototypeOriginUrl} when you mean "the prototype's page" — this
 * one is for naming a *specific* file (`/base.html`, `/dist/prototype.html`).
 */
export function prototypeDocumentUrl(workspaceRootPath: string, slug: string, filePath: string): string {
  const base = resolveBaseUrl?.(workspaceRootPath, slug)
  if (!base) return pathToFileURL(filePath).toString()

  const prototypeDir = getPrototypeDirPath(workspaceRootPath, slug)
  const relativePath = relative(prototypeDir, filePath)
  // Never build a URL that climbs out of the prototype, even if a caller passes
  // a path from somewhere else: fall back rather than serve a neighbour's file.
  if (!relativePath || relativePath.startsWith('..')) return pathToFileURL(filePath).toString()

  return `${base.replace(/\/+$/, '')}/${relativePath.split(sep).join('/')}`
}
