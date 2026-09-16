/**
 * The prototype's deliverable: a loadable Chrome extension — one per prototype.
 *
 * Both kinds hand over the same *shape* of thing, because both answer the same
 * question — "show me this prototype, on my machine, with the changes in" — and
 * the answer differs only in where the page lives:
 *
 * - **`scratch`** — the pages are ours, so the extension *ships* them: one package
 *   file per page, under the name it has on disk, with the manifest's options page
 *   naming the entry (open it from `chrome://extensions`, or from the toolbar
 *   icon). No content scripts, nothing to inject into; the links between pages are
 *   the ones the author wrote.
 * - **`overlay`** — the pages belong to a running product, so the extension
 *   injects into them: a content script carrying the match patterns of the whole
 *   flow, which Chrome itself scopes.
 *
 * Chrome is only the runtime. Nothing here is published to a store: the package is
 * static, self-contained, and disposable — load it unpacked, delete it when done.
 *
 * ## Why an extension rather than the bookmarklet this replaces
 *
 * The bookmarklet carrier had three costs that were all properties of the
 * *carrier*, not of the work:
 *
 * - **Page CSP could refuse it.** A bookmark runs as an inline script in the page,
 *   so a site sending `script-src 'self'` (GitHub, Gmail, most banks) refused it,
 *   and a console snippet was the workaround.
 * - **One click per document.** It applied to the page you clicked it on; every
 *   reload and every page of a flow needed another click.
 * - **A hard size budget.** Everything travelled inside one URL.
 *
 * A content script is injected by the browser rather than by the page, so the
 * page's policy does not apply to it, it runs on every matching document by
 * itself, and it is a file.
 *
 * ## What this demands of a patch
 *
 * - **Re-runnable.** A single-page app swaps views without a reload, and the view
 *   it lands on is one the patches never saw — so they are replayed on route
 *   changes (see {@link buildPatchBundle}). Setting text or styles is naturally
 *   idempotent; `appendChild` is not.
 * - **Not assuming document-start.** Stylesheets are in place before the page
 *   paints; the javascript side runs at `document_idle`.
 * - **Readable, not small.** The size budget is gone; "no dead patches" is now a
 *   quality argument rather than a load-bearing one.
 *
 * ## What the delivered page cannot do (and how it is covered)
 *
 * An extension page runs under Manifest V3's own CSP, which allows no inline
 * script. So a from-scratch document's inline `<script>` blocks are **hoisted into
 * files**, and its inline event handlers (`onclick="…"`) are turned into generated
 * functions plus a `data-` marker a small runtime binds — no `eval` involved, and
 * handlers inside HTML the page builds at runtime are bound too (the runtime
 * watches the DOM). Nothing about this is asked of the author: see §17.1 of the
 * plan — the generator absorbs it, or says what it could not absorb.
 *
 * ## The mock layer is part of the deliverable
 *
 * The contract's `x-mock` fixtures travel with the extension: a script that
 * wraps the page's own `fetch` / `XHR` and answers the declared routes. It is the
 * same idea as the workbench's own layer (CDP fulfilling the request), moved to
 * the only place an exported extension can reach — the page's world. The README
 * lists which routes are faked, and says what it cannot cover (requests a PWA's
 * own service worker makes never pass through the page).
 *
 * @see docs/prototype-workbench-plan.md §17 (交付物：扩展)
 */

import { buildPatchInitScript } from './patch-script.ts'
import type { MockRoute } from './contract.ts'
import type { PageKind, PrototypePatch } from './types.ts'

const PATCH_SCRIPT_FILENAME = '__prototype_patches.js'
const MOCK_SCRIPT_FILENAME = 'mocks.js'
const HANDLERS_FILENAME = 'handlers.js'
const HANDLER_ATTRIBUTE = 'data-craft-on'

/**
 * The generated page index, which is the package's options page (plan §19.5).
 *
 * Options is where Chrome offers to open a prototype, so it is the one place that
 * should always exist in a package — whatever mixture of our pages and someone
 * else's it contains. The toolbar icon opens the entry page when there is one, and
 * this index otherwise (see {@link buildBackgroundScript}).
 */
export const EXTENSION_INDEX_FILENAME = 'index.html'

/** Global the bundle installs, so a second injection reuses the first install. */
function bundleGlobalName(slug: string): string {
  return `__craft_prototype_${slug.replace(/[^A-Za-z0-9]/g, '_')}__`
}

/**
 * The javascript patches as one runnable script — the delivered `patches.js`.
 *
 * The patches themselves go through {@link buildPatchInitScript} — the same
 * transform the live injector uses — so the delivered artifact cannot behave
 * differently from what the workbench shows. Only the frame around them is new,
 * and it does three things:
 *
 * 1. **Install once.** A re-injection (a route change, an extension reload) reuses
 *    the existing install rather than adding a second set of listeners.
 * 2. **Replay on view changes.** A single-page app swaps views without a reload,
 *    and the view it lands on is one the patches never saw. Hooking `pushState` /
 *    `replaceState` / `popstate` covers that.
 * 3. **Keep the stylesheet honest.** Re-running a css patch overwrites the
 *    `<style>` element it owns, so css can be replayed freely; js patches have to
 *    be written for it (see the module note).
 */
export function buildPatchBundle(slug: string, patches: PrototypePatch[]): string {
  const global = bundleGlobalName(slug)
  return [
    '(() => {',
    `  const GLOBAL = ${JSON.stringify(global)};`,
    '  const apply = () => {',
    ...patches.map((patch) => indent(buildPatchInitScript(patch), 4)),
    '  };',
    '',
    '  const installed = window[GLOBAL];',
    '  if (installed) { installed.apply(); return; }',
    '  window[GLOBAL] = { apply };',
    '  apply();',
    '',
    "  for (const method of ['pushState', 'replaceState']) {",
    '    const original = history[method];',
    '    history[method] = function (...args) {',
    '      const result = original.apply(this, args);',
    '      apply();',
    '      return result;',
    '    };',
    '  }',
    "  window.addEventListener('popstate', apply);",
    '})()',
  ].join('\n')
}

/** Indent every non-empty line, so a nested script stays readable in the bundle. */
function indent(source: string, spaces: number): string {
  const pad = ' '.repeat(spaces)
  return source
    .split('\n')
    .map((line) => (line.trim() ? pad + line : line))
    .join('\n')
}

/**
 * An address as a Chrome match pattern: the window it is a page *of*.
 *
 * The page's own path gets a trailing `*` on purpose. Real addresses carry query
 * strings, trailing slashes and sub-routes, and a pattern that misses them fails
 * **silently** — the injection simply never happens, which is the one failure this
 * whole design keeps trying to avoid. So the pattern is anchored on scheme + host
 * + path and left open after that.
 *
 * Null when the address cannot be parsed; the caller decides what to do about a
 * page it cannot scope.
 */
export function matchPatternForUrl(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null

  const path = parsed.pathname === '' ? '/' : parsed.pathname
  return `${parsed.protocol}//${parsed.host}${path}*`
}

export interface ExtensionFile {
  /** Path inside `dist/extension/`. */
  path: string
  content: string
}

export interface ExtensionPage {
  html: string
  /** Files the document's own transforms produced, under this page's asset directory. */
  files: ExtensionFile[]
  /**
   * Things that will not work in the delivered page, in the author's words. Never
   * empty silently: a page that behaves differently once delivered has to say so.
   */
  warnings: string[]
}

/**
 * One page of ours going into the package.
 *
 * The file keeps the name it has in the prototype (`cart.html`, `orders.html`), so
 * links between pages — which the author wrote as ordinary relative links — keep
 * working with nothing rewritten, and so "which file is this" needs no second
 * lookup. Everything in the package is a build output either way.
 */
export interface ExtensionDocument {
  /** Path inside the package — the source file's own name. */
  path: string
  /** The page it is, as the table knows it: patches are scoped by this name (plan §19.4). */
  page: string
  /** The document as it was written, before this module's transforms. */
  html: string
}

/** Where a page's own generated files live, so several pages cannot collide. */
function pageAssetDir(page: string): string {
  return `assets/${page}`
}

/** The compiled patch bundle for one page, so no page is handed another page's changes. */
function patchBundlePath(page: string): string {
  return `${pageAssetDir(page)}/${PATCH_SCRIPT_FILENAME}`
}

/**
 * The javascript patches that apply to one page, as a single runnable file.
 *
 * One bundle per page rather than one per package: a patch under `patches/<page>/`
 * belongs to that page, and handing it to every page is exactly the silent
 * over-application the directory rule exists to prevent (plan §19.4). Null when the
 * page has no javascript patches to run.
 */
export function buildPagePatchBundle(
  slug: string,
  page: string,
  patches: PrototypePatch[],
): ExtensionFile | null {
  const applicable = patches.filter(
    (patch) => patch.kind === 'js' && (patch.page === null || patch.page === page),
  )
  if (applicable.length === 0) return null
  return { path: patchBundlePath(page), content: `${buildPatchBundle(slug, applicable)}\n` }
}

/**
 * The artifacts every page shares, at the package root: the css patches, as real
 * stylesheets, and the mock layer.
 *
 * One copy, whichever pages reference it — a stylesheet is a plain file that each
 * page links to, and a mock is a property of the prototype rather than of a page.
 * The javascript side is per page instead ({@link buildPagePatchBundle}), because
 * a bundle is code that runs rather than a reference.
 */
export function buildSharedExtensionFiles(input: {
  patches: PrototypePatch[]
  mocks?: MockRoute[]
}): ExtensionFile[] {
  const mocks = input.mocks ?? []
  const files: ExtensionFile[] = input.patches
    .filter((patch) => patch.kind === 'css')
    .map((patch) => ({ path: `patches/${patch.file}`, content: `${patch.source}\n` }))

  if (mocks.length > 0) {
    files.push({ path: MOCK_SCRIPT_FILENAME, content: buildMockScript(mocks) })
  }

  return files
}

/**
 * One of our documents as an extension page.
 *
 * One transform, and only because MV3's CSP for extension pages allows no inline
 * script: **inline `<script>` blocks are hoisted into files**. Inline event-handler
 * attributes (`onclick="…"`) cannot be hoisted either, so they are lifted into a
 * generated file plus a `data-` marker a small runtime binds.
 *
 * Everything else is a reference, not a copy: the page's css patches become real
 * stylesheets it links to (`patches/<file>`, the same files an overlay's content
 * script lists), and its javascript patches become one file it loads with `defer`
 * — the patches expect the document to exist. Only what *this* page carries is
 * linked (plan §19.4); the page's own generated files go under `assets/<page>/`.
 */
export function buildExtensionPage(input: {
  /** The page this document is, as the table knows it (plan §19.4). */
  page: string
  document: string
  patches: PrototypePatch[]
  slug: string
  mocks?: MockRoute[]
}): ExtensionPage {
  const mocks = input.mocks ?? []
  const files: ExtensionFile[] = []
  const warnings: string[] = []
  /** Where this page's own generated files go, e.g. `assets/orders/`. */
  const assetDir = `${pageAssetDir(input.page)}/`
  // Only what this page carries: a patch under `patches/<other>/` belongs to
  // another page, and linking it here is the silent over-application the
  // directory rule prevents (plan §19.4).
  const patches = input.patches.filter(
    (patch) => patch.page === null || patch.page === input.page,
  )

  let index = 0
  let html = input.document.replace(
    /<script\b(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gi,
    (_match, attributes: string, body: string) => {
      if (!body.trim()) return ''
      index += 1
      const path = `${assetDir}inline-${index}.js`
      files.push({ path, content: body.replace(/^\n/, '') })
      return `<script${attributes} src="${path}"></script>`
    },
  )
  if (index > 0) {
    warnings.push(
      `${index} inline <script> block(s) were moved into files (inline script is not allowed in an extension page).`,
    )
  }

  // Inline handlers become real functions before anything else looks at the
  // document: this is the transform that lets the author keep writing `onclick`.
  const handlers = extractInlineHandlers(html)
  html = handlers.html
  if (handlers.count > 0) {
    const handlerPath = `${assetDir}${HANDLERS_FILENAME}`
    files.push({ path: handlerPath, content: handlers.script })
    warnings.push(
      `${handlers.count} inline event handler(s) were lifted into ${handlerPath} ` +
        '(an extension page runs no inline script; they behave the same).',
    )
  }

  const cssPatches = patches.filter((patch) => patch.kind === 'css')

  for (const patch of cssPatches) {
    const tag = `<link rel="stylesheet" href="patches/${patch.file}">`
    html = insertBeforeClosingTag(html, tag, '</head>') ?? insertBeforeClosingTag(html, tag, '</body>') ?? `${tag}\n${html}`
  }

  // Order matters only in that these run before the patches (`defer` keeps them in
  // document order): a mock the patches' own code fetches, and a handler a patch
  // might click.
  if (mocks.length > 0) {
    const tag = `<script defer src="${MOCK_SCRIPT_FILENAME}"></script>`
    html = insertBeforeClosingTag(html, tag, '</body>') ?? insertBeforeClosingTag(html, tag, '</head>') ?? `${html}\n${tag}`
  }

  if (handlers.count > 0) {
    const tag = `<script defer src="${assetDir}${HANDLERS_FILENAME}"></script>`
    html = insertBeforeClosingTag(html, tag, '</body>') ?? insertBeforeClosingTag(html, tag, '</head>') ?? `${tag}\n${html}`
  }

  const bundle = buildPagePatchBundle(input.slug, input.page, input.patches)
  if (bundle) {
    files.push(bundle)
    const tag = `<script defer src="${bundle.path}"></script>`
    html = insertBeforeClosingTag(html, tag, '</body>') ?? insertBeforeClosingTag(html, tag, '</head>') ?? `${html}\n${tag}`
  }

  return { html, files, warnings }
}

/** `block` before the last `closingTag`, or null when the document has none. */
function insertBeforeClosingTag(html: string, block: string, closingTag: string): string | null {
  const at = html.toLowerCase().lastIndexOf(closingTag)
  if (at === -1) return null
  return `${html.slice(0, at)}${block}\n${html.slice(at)}`
}

/**
 * The mock layer as a script the page itself runs.
 *
 * Matching is **by pathname only**, exactly like the workbench's own layer (see
 * plan §5): a route declared as `/api/orders` answers that path on whatever host
 * the page happens to call, which is what makes one contract serve a prototype in
 * several environments.
 *
 * It wraps `window.fetch` and `XMLHttpRequest` rather than intercepting at the
 * network layer, because that is the only interception point an exported extension
 * has: `declarativeNetRequest` cannot synthesize a response body, and the blocking
 * `webRequest` API is gone for ordinary extensions in MV3. The cost is stated in
 * the README — requests a page's own service worker makes never pass through here.
 */
export function buildMockScript(routes: MockRoute[]): string {
  return [
    '// Mock responses from this prototype\'s contract.',
    '// Matched by pathname, like the workbench does — one route answers that path on any host.',
    '(() => {',
    `  const ROUTES = ${JSON.stringify(routes, null, 2).replace(/\n/g, '\n  ')};`,
    '',
    '  const findRoute = (method, url) => {',
    '    let path;',
    '    try { path = new URL(String(url), location.href).pathname; } catch { return null; }',
    '    const verb = String(method || "GET").toUpperCase();',
    '    return ROUTES.find((route) => route.method === verb && route.path === path) ?? null;',
    '  };',
    '',
    '  const payload = (route) => (route.body === null ? null : JSON.stringify(route.body));',
    '',
    '  const originalFetch = window.fetch;',
    '  window.fetch = async (input, init) => {',
    '    const method = (init && init.method) || (input instanceof Request ? input.method : "GET");',
    '    const url = input instanceof Request ? input.url : input;',
    '    const route = findRoute(method, url);',
    '    if (!route) return originalFetch(input, init);',
    '    return new Response(payload(route), {',
    '      status: route.status,',
    '      headers: { "content-type": "application/json" },',
    '    });',
    '  };',
    '',
    '  const { open, send } = XMLHttpRequest.prototype;',
    '  XMLHttpRequest.prototype.open = function (method, url, ...rest) {',
    '    this.__craftMockRoute = findRoute(method, url);',
    '    return open.call(this, method, url, ...rest);',
    '  };',
    '  XMLHttpRequest.prototype.send = function (...args) {',
    '    const route = this.__craftMockRoute;',
    '    if (!route) return send.apply(this, args);',
    '    const xhr = this;',
    '    const body = payload(route);',
    '    setTimeout(() => {',
    '      Object.defineProperty(xhr, "readyState", { value: 4, configurable: true });',
    '      Object.defineProperty(xhr, "status", { value: route.status, configurable: true });',
    '      Object.defineProperty(xhr, "responseText", { value: body ?? "", configurable: true });',
    '      Object.defineProperty(xhr, "response", { value: body, configurable: true });',
    '      xhr.getResponseHeader = (name) =>',
    '        String(name).toLowerCase() === "content-type" ? "application/json" : null;',
    '      xhr.dispatchEvent(new Event("readystatechange"));',
    '      xhr.dispatchEvent(new Event("load"));',
    '      xhr.dispatchEvent(new Event("loadend"));',
    '    }, 0);',
    '  };',
    '})();',
    '',
  ].join('\n')
}

/**
 * Inline event handlers as real functions.
 *
 * An extension page will not run `onclick="…"`, and the fix cannot be `eval` (MV3
 * forbids it). So each handler's code is lifted into a function in a generated
 * file, the attribute becomes a marker naming that function, and a small runtime
 * binds markers to listeners — on load, and again whenever the DOM changes, so
 * HTML the page builds later is covered too.
 *
 * Returns the rewritten document, the generated file (empty when there were no
 * handlers) and how many handlers were lifted.
 */
export function extractInlineHandlers(html: string): {
  html: string
  script: string
  count: number
} {
  const handlers: Array<{ id: string; event: string; code: string }> = []
  const rewritten = html.replace(
    /\son([a-z]+)\s*=\s*("([^"]*)"|'([^']*)')/gi,
    (_match, event: string, _quoted: string, doubleQuoted: string, singleQuoted: string) => {
      const code = doubleQuoted ?? singleQuoted ?? ''
      if (!code.trim()) return ''
      const id = `h${handlers.length + 1}`
      handlers.push({ id, event: event.toLowerCase(), code })
      return ` ${HANDLER_ATTRIBUTE}-${event.toLowerCase()}="${id}"`
    },
  )

  if (handlers.length === 0) return { html: rewritten, script: '', count: 0 }

  // Each handler body is the author's own code, verbatim, wrapped in a function —
  // no rewriting of what it does, only of where it lives.
  const table = handlers
    .map((handler) => `  ${JSON.stringify(handler.id)}: function (event) { ${handler.code}\n  },`)
    .join('\n')

  const script = [
    '// Inline event handlers, lifted out of the document (an extension page runs no inline script).',
    '(() => {',
    '  const handlers = {',
    table,
    '  };',
    `  const ATTRIBUTES = ${JSON.stringify([...new Set(handlers.map((handler) => `${HANDLER_ATTRIBUTE}-${handler.event}`))])};`,
    '  const BOUND = "__craftHandlerBound";',
    '',
    '  const bind = (root) => {',
    '    for (const attribute of ATTRIBUTES) {',
    '      for (const element of root.querySelectorAll(`[${attribute}]`)) {',
    '        const id = element.getAttribute(attribute);',
    '        const event = attribute.slice("' + HANDLER_ATTRIBUTE + '-".length);',
    '        const key = `${event}:${id}`;',
    '        if (!handlers[id] || element[BOUND]?.[key]) continue;',
    '        element[BOUND] = { ...(element[BOUND] || {}), [key]: true };',
    '        element.addEventListener(event, handlers[id]);',
    '      }',
    '    }',
    '  };',
    '',
    '  const start = () => {',
    '    bind(document);',
    '    new MutationObserver(() => bind(document)).observe(document.documentElement, {',
    '      childList: true,',
    '      subtree: true,',
    '    });',
    '  };',
    '',
    '  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);',
    '  else start();',
    '})();',
    '',
  ].join('\n')

  return { html: rewritten, script, count: handlers.length }
}

export interface ExtensionPackageInput {
  slug: string
  /**
   * The prototype's overlay pages, in flow order. One content script is built per
   * entry, so each page carries its own patches and the shared ones — never
   * another page's (plan §19.4).
   */
  targets?: Array<{ page: string; url: string }>
  /**
   * The pages of ours going into the package, each keeping the file name it has in
   * the prototype, so the links between them keep working.
   */
  documents?: ExtensionDocument[]
  /**
   * The page `/` opens, or null when that is the generated index (plan §19.3) —
   * which is what the toolbar icon opens when there is no entry page.
   */
  entryPage: string | null
  /** The generated page index, written as the package's options page. */
  indexDocument: string
  patches: PrototypePatch[]
  /** The contract's `x-mock` routes, compiled into the package (see {@link buildMockScript}). */
  mocks?: MockRoute[]
  /** When the package was generated — the version and the README are derived from it. */
  builtAt: Date
}

export interface ExtensionPackage {
  files: ExtensionFile[]
  /** The manifest's `version`, monotonic across exports so "am I on the latest?" has an answer. */
  version: string
  /** Anything the delivered artifact has to admit to (see {@link buildExtensionPage}). */
  warnings: string[]
}

/**
 * Everything `dist/extension/` should contain.
 *
 * A file map rather than a writer: the export step owns the filesystem (export.ts),
 * this owns the shape of the deliverable — which is also what makes the whole
 * package testable without touching disk.
 *
 * One package covers **one prototype**, which is now a flow that may mix both kinds
 * (plan §19.5): our documents ship as pages under the names they have on disk,
 * overlay pages are covered by a content script each, and both are listed in the
 * generated index the options page shows. Nothing is rewritten to move a document,
 * because nothing moves.
 */
export function buildExtensionPackage(input: ExtensionPackageInput): ExtensionPackage {
  const { slug, patches, builtAt } = input
  const mocks = input.mocks ?? []
  const version = extensionVersion(builtAt)
  const documents = input.documents ?? []
  const overlayPages = input.targets ?? []
  const files: ExtensionFile[] = []
  const warnings: string[] = []

  if (documents.length === 0 && overlayPages.length === 0) {
    throw new Error(
      `Prototype "${slug}" has no pages, so there is nothing to deliver. Write a page ` +
        `(a top-level <name>.html) or add an overlay page first.`,
    )
  }

  files.push(...buildSharedExtensionFiles({ patches, mocks }))
  files.push({ path: EXTENSION_INDEX_FILENAME, content: input.indexDocument })

  for (const document of documents) {
    const page = buildExtensionPage({
      page: document.page,
      document: document.html,
      patches,
      slug,
      mocks,
    })
    files.push({ path: document.path, content: page.html })
    files.push(...page.files)
    // Named per page: with several pages, "2 inline <script> block(s)" would not
    // say which document needed adapting.
    warnings.push(...page.warnings.map((warning) => `${document.path}: ${warning}`))
  }

  // Each overlay page gets its own pattern and its own file list. A page that
  // cannot become a pattern is an error rather than a page that quietly gets no
  // patches — silently covering one page less is the failure this design keeps
  // avoiding.
  const targets = overlayPages.map((page) => {
    const pattern = matchPatternForUrl(page.url)
    if (!pattern) {
      throw new Error(
        `Prototype "${slug}" page "${page.page}" records "${page.url}", which is not an address a browser can match on. ` +
          `Include the scheme, e.g. https://app.example.com/checkout`,
      )
    }

    const bundle = buildPagePatchBundle(slug, page.page, patches)
    if (bundle) files.push(bundle)

    return {
      pattern,
      css: patches
        .filter((patch) => patch.kind === 'css' && (patch.page === null || patch.page === page.page))
        .map((patch) => `patches/${patch.file}`),
      js: bundle ? [bundle.path] : [],
    }
  })

  files.push({
    path: 'manifest.json',
    content: `${buildManifest({
      slug,
      version,
      builtAt,
      targets,
      mockFile: mocks.length > 0 && targets.length > 0 ? MOCK_SCRIPT_FILENAME : null,
      pages: documents.length + overlayPages.length,
      patches,
    })}\n`,
  })

  const entryPath = documents.find((document) => document.page === input.entryPage)?.path ?? null

  files.push({
    path: 'README.md',
    content: buildReadme({
      slug,
      version,
      builtAt,
      matches: targets.map((target) => target.pattern),
      patches,
      mocks,
      pages: [
        ...documents.map((document) => ({
          name: document.page,
          kind: 'scratch' as const,
          where: document.path,
          entry: document.page === input.entryPage,
        })),
        ...overlayPages.map((page) => ({
          name: page.page,
          kind: 'overlay' as const,
          where: page.url,
          entry: page.page === input.entryPage,
        })),
      ],
    }),
  })
  files.push({ path: 'background.js', content: buildBackgroundScript(entryPath ?? EXTENSION_INDEX_FILENAME) })

  return { files, version, warnings }
}

/**
 * A version that changes on every export.
 *
 * Chrome's version parts are numbers, and "which build am I looking at?" is a real
 * question for a reviewer who has to reload the extension after every change.
 * `days since epoch . minutes of the day` is monotonic, readable, and nowhere near
 * the 65535-per-part limit.
 */
function extensionVersion(builtAt: Date): string {
  const days = Math.floor(builtAt.getTime() / 86_400_000)
  const minutes = builtAt.getUTCHours() * 60 + builtAt.getUTCMinutes()
  return `1.${days}.${minutes}`
}

function buildManifest(input: {
  slug: string
  version: string
  builtAt: Date
  /** One entry per overlay page: the address pattern it applies on, and the files it needs. */
  targets: Array<{ pattern: string; css: string[]; js: string[] }>
  /** The compiled mock layer, when the contract has `x-mock` routes. */
  mockFile?: string | null
  /** How many pages of the flow this build covers — the flow's shape, in one number. */
  pages: number
  patches?: PrototypePatch[]
}): string {
  const contentScripts = input.targets.map((target) => ({
    matches: [target.pattern],
    run_at: 'document_idle',
    ...(target.css.length > 0 ? { css: target.css } : {}),
    ...(target.js.length > 0 ? { js: target.js } : {}),
  }))

  // The mock layer has to run in the page's own world (it replaces the page's
  // `fetch`), and early — before the product's own code captures a reference.
  const mockScript: Record<string, unknown> | null =
    input.targets.length === 0 || !input.mockFile
      ? null
      : {
          matches: input.targets.map((target) => target.pattern),
          run_at: 'document_start',
          world: 'MAIN',
          js: [input.mockFile],
        }

  const pageCount = `${input.pages} page${input.pages === 1 ? '' : 's'}`
  const manifest: Record<string, unknown> = {
    manifest_version: 3,
    name: `Prototype — ${input.slug}`,
    version: input.version,
    description:
      input.targets.length === 0
        ? `Opens the prototype (${pageCount}) · built ${input.builtAt.toISOString()}`
        : `Applies ${input.patches?.length ?? 0} patch(es) to ${pageCount} · built ${input.builtAt.toISOString()}`,
    // Options is where Chrome offers to open the prototype, so it is always the
    // generated page index: a flow can mix our documents with someone else's
    // addresses, and one page cannot represent that (plan §19.5).
    options_ui: { page: EXTENSION_INDEX_FILENAME, open_in_tab: true },
    action: { default_title: `Open ${input.slug}` },
    background: { service_worker: 'background.js' },
  }

  const scripts = [mockScript, ...contentScripts].filter(
    (script): script is Record<string, unknown> => script !== null,
  )
  if (scripts.length > 0) manifest.content_scripts = scripts

  return JSON.stringify(manifest, null, 2)
}

/**
 * How a person loads this, what it will change, and what to do after the prototype
 * moves on.
 *
 * Written for the recipient, not for us: the artefact asks someone to run code on a
 * page they use (or to open a page we generated), so it has to say what that code
 * is, where it will run, and how to get rid of it. Being readable is the only
 * credential it has.
 */
function buildReadme(input: {
  slug: string
  version: string
  builtAt: Date
  matches: string[]
  patches: PrototypePatch[]
  mocks?: MockRoute[]
  /** The prototype's pages, in flow order. */
  pages?: Array<{ name: string; kind: PageKind; where: string; entry: boolean }>
}): string {
  const patchList = input.patches.length > 0
    ? input.patches
        .map(
          (patch) =>
            `- \`${patch.file}\` — ${patch.kind}, lane ${patch.lane ?? '—'}` +
            `${patch.page ? `, page \`${patch.page}\`` : ', every page'}`,
        )
        .join('\n')
    : '- (no patches yet)'

  const pages = input.pages ?? []
  const where = input.matches.length === 0
    ? `This prototype's pages are its own documents, so the extension ships them. Open the
entry page from the extension's **Options** (or the toolbar icon); the rest are
linked from it.`
    : `Some of this prototype's pages are changes to pages that already exist, and those are
not shipped: they apply on top of the real product, in your own browser, so you see
them with **your** session and **real** data.

Open the addresses below — for those there is nothing to click, the changes are
already there.`

  const matches = input.matches.length > 0
    ? `\n## Where it applies\n\n${input.matches.map((match) => `- \`${match}\``).join('\n')}\n`
    : ''

  // The flow's own order, so a reviewer can walk it the way it was meant to be
  // walked. A page list that was only alphabetical would say nothing. The kind is
  // part of each line because it decides what "open it" means: a document of ours
  // is in the package, an overlay page is an address on the real product.
  const pageList = pages.length > 0
    ? `\n## Pages\n\n${pages
        .map((page) => {
          const location = page.kind === 'overlay' ? `<${page.where}>` : `\`${page.where}\``
          const entry = page.entry ? ' — the entry page (Options or the toolbar icon opens this one)' : ''
          return `- \`${page.name}\` (${page.kind}) — ${location}${entry}`
        })
        .join('\n')}\n`
    : ''

  // Faked responses are the one thing a reviewer can be misled by without being
  // told, so the list is not optional: it says *which* data is not real, and what
  // the layer cannot reach.
  const mocks = (input.mocks ?? []).length > 0
    ? `\n## Faked responses

These requests are answered by this extension, not by the product's backend — the
data you see for them is written in the prototype's contract:

${(input.mocks ?? []).map((route) => `- \`${route.method} ${route.path}\``).join('\n')}

Requests made by a page's own service worker (a PWA) never pass through the page
and are **not** faked.\n`
    : ''

  return `# Prototype — ${input.slug}

${where}

Built ${input.builtAt.toISOString()} · version ${input.version}

## Load it

1. Open \`chrome://extensions\`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and choose this folder

Nothing is published anywhere and no account is needed. To get rid of it, remove it
from the same \`chrome://extensions\` page.
${matches}${pageList}${mocks}
## What it changes

${patchList}

## If the prototype changes

A re-export makes a new folder. In \`chrome://extensions\`, press **Reload** on this
extension (and refresh the page) — the version number above tells you which build
you are running.
`
}

/**
 * The action's service worker: a from-scratch prototype has pages to open, so the
 * toolbar icon opens the entry one. Two lines, no state, no permissions.
 */
export function buildBackgroundScript(entryPath: string): string {
  return [
    "// The entry page is the extension's options page; the toolbar icon just opens it.",
    'chrome.action.onClicked.addListener(() => {',
    `  chrome.tabs.create({ url: chrome.runtime.getURL('${entryPath}') })`,
    '})',
    '',
  ].join('\n')
}
