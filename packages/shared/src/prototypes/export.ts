/**
 * Prototype export.
 *
 * Turns a prototype into role-shaped deliverables under `dist/`:
 *  - `extension/`     — a loadable Chrome extension: the piece a human *looks at*
 *                       (it applies the patches to the live pages of an overlay
 *                       page, and ships our own documents) (see extension.ts, and
 *                       §17/§19.5 of the plan)
 *  - `dev-spec.md`    — the change list a developer reads
 *
 * The patch order inside the extension is the same derived order used for live
 * replay, and the page scoping is the same directory rule, so the deliverable and
 * the workbench agree by construction.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { buildMockRoutes, listContractServices, loadContractService } from './contract.ts'
import {
  buildExtensionPackage,
  EXTENSION_INDEX_FILENAME,
  type ExtensionDocument,
  type ExtensionFile,
} from './extension.ts'
import { buildPrototypeIndexDocument, applyPrototypeLayout } from './page-document.ts'
import {
  findEntryPage,
  listPrototypePages,
  pageFileName,
  PROTOTYPE_INDEX_PATH,
  type PrototypePage,
} from './pages.ts'
import { readPrototypeLayout } from './create.ts'
import { buildPatchInitScript } from './patch-script.ts'
import { getPrototypeDistPath, getPrototypeDirPath, scanPrototypePatches } from './storage.ts'
import { prototypeDocumentUrl, prototypeOriginUrl } from './url.ts'
import type { MockRoute } from './contract.ts'
import type { PrototypePatch } from './types.ts'

const DEV_SPEC_FILENAME = 'dev-spec.md'
const EXTENSION_DIRNAME = 'extension'

export interface PrototypeExportResult {
  slug: string
  /** Absolute path to `dist/extension/` — the deliverable. */
  extensionDir: string
  /**
   * Absolute path to the page a recipient should open first, inside the package:
   * the entry page when it is one of ours, and the generated page index otherwise
   * (which is also the options page). Null when the entry page is an overlay's —
   * there is no page of ours to open, the recipient goes to the real address.
   */
  pagePath: string | null
  /** Address of that page, when there is one. */
  pageUrl: string | null
  /** The manifest's version, so "am I looking at the latest build?" has an answer. */
  version: string
  /** Absolute path to the change spec. */
  specPath: string
  /** How many patches went into the package. */
  applied: number
  /** How many pages the package covers. */
  pageCount: number
  /** What the package had to do to a document, or cannot cover (see extension.ts). */
  warnings: string[]
}

/**
 * Insert `block` immediately before the last occurrence of `closingTag`.
 */
function insertBeforeClosingTag(html: string, block: string, closingTag: string): string | null {
  const index = html.toLowerCase().lastIndexOf(closingTag)
  if (index === -1) return null
  return `${html.slice(0, index)}${block}\n${html.slice(index)}`
}

/**
 * id of the element that records which patches a document already carries.
 *
 * Read back by {@link buildInlinedPatchProbeScript}, which is what keeps a page
 * opened from the workbench from having its patches applied a second time.
 */
export const INLINED_PATCHES_ELEMENT_ID = '__craft_prototype_inlined__'

/** The marker element itself: a list of file names, escaped so it cannot end the tag. */
function inlinedMarkerBlock(files: string[]): string {
  const json = JSON.stringify(files).replace(/</g, '\\u003c')
  return `<script type="application/json" id="${INLINED_PATCHES_ELEMENT_ID}">${json}</script>`
}

/**
 * An expression that reads the file names a document already has inlined.
 *
 * Deliberately tolerant: a document with no marker, a marker whose payload is
 * not JSON, or one that is not an array of strings all mean "nothing known is
 * applied", which is the safe answer — the alternative (assuming patches are
 * already there) would silently skip work.
 */
export function buildInlinedPatchProbeScript(): string {
  return [
    '(() => {',
    `  const el = document.getElementById(${JSON.stringify(INLINED_PATCHES_ELEMENT_ID)});`,
    '  if (!el) return [];',
    '  try {',
    "    const parsed = JSON.parse(el.textContent || '[]');",
    "    return Array.isArray(parsed) ? parsed.filter((name) => typeof name === 'string') : [];",
    '  } catch {',
    '    return [];',
    '  }',
    '})()',
  ].join('\n')
}

/**
 * Inline every patch into a single self-contained HTML document.
 *
 * - css patches become one `<style>` block inside `<head>` (from a plain-text
 *   patch there is nothing to execute, so inlining the text is exactly
 *   equivalent to what the live injector does — and it survives with JS off).
 * - js patches are inlined through {@link buildPatchInitScript}, the same
 *   transform used for live replay, so behaviour cannot diverge.
 * - the list of what was inlined is written into the document as well
 *   ({@link INLINED_PATCHES_ELEMENT_ID}), so the injector can tell "this page
 *   already has these" from "this page is a foreign document" and not run the
 *   JS patches twice. A plain page carries no marker and is treated as
 *   untouched, which is what an overlay's page is.
 *
 * @param patches the patches **this page** carries — the shared ones plus its own
 *   (`scanPrototypePatchesForPage`), never the whole prototype's (plan §19.4).
 */
export function buildSelfContainedHtml(pageHtml: string, patches: PrototypePatch[]): string {
  const cssPatches = patches.filter((patch) => patch.kind === 'css')
  const jsPatches = patches.filter((patch) => patch.kind === 'js')

  const styleBlock = cssPatches.length > 0
    ? [
        '<style id="__craft_prototype_patches__">',
        ...cssPatches.map((patch) => `/* ${patch.file} */\n${patch.source}`),
        '</style>',
      ].join('\n')
    : ''

  const scriptBlock = jsPatches.length > 0
    ? ['<script>', ...jsPatches.map((patch) => buildPatchInitScript(patch)), '</script>'].join('\n')
    : ''

  if (!styleBlock && !scriptBlock) return pageHtml

  let out = pageHtml

  // The marker goes in on its own, before the styles, so that a document with no
  // `</head>` cannot lose it to a later fallback — it is the only record that the
  // patches inlined below are already applied.
  const marker = inlinedMarkerBlock(patches.map((patch) => patch.file))
  out = insertBeforeClosingTag(out, marker, '</head>')
    ?? insertBeforeClosingTag(out, marker, '</body>')
    ?? `${out}\n${marker}`

  if (styleBlock) {
    out = insertBeforeClosingTag(out, styleBlock, '</head>')
      ?? insertBeforeClosingTag(out, styleBlock, '</body>')
      ?? `${out}\n${styleBlock}`
  }

  if (scriptBlock) {
    out = insertBeforeClosingTag(out, scriptBlock, '</body>') ?? `${out}\n${scriptBlock}`
  }

  return out
}

/** A backtick fence longer than any run inside `source`, so content can't break out. */
function fenceFor(source: string): string {
  const runs = source.match(/`+/g) ?? []
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0)
  return '`'.repeat(Math.max(3, longest + 1))
}

/** One patch's full listing, with a heading that says where it belongs. */
function patchSection(patch: PrototypePatch, index: number): string[] {
  const fence = fenceFor(patch.source)
  const scope = patch.page ? `page \`${patch.page}\`` : 'every page'
  return [
    `#### ${index}. \`${patch.file}\``,
    '',
    `${patch.kind === 'css' ? 'CSS' : 'JavaScript'} patch, lane ${patch.lane ?? '—'}, order ${patch.order}, ${scope}.`,
    '',
    fence + (patch.kind === 'css' ? 'css' : 'javascript'),
    patch.source,
    fence,
    '',
  ]
}

/**
 * Human-readable change list for the developer receiving the prototype.
 *
 * Grouped by page, because that is the question a developer arrives with — "what
 * does this flow change, screen by screen" — and because the patch directories are
 * exactly that grouping (plan §19.4). The shared patches are listed once and every
 * page says how many of them it also carries, so the document is complete without
 * printing the same source N times.
 */
export function buildDevSpec(
  slug: string,
  input: { pages: PrototypePage[]; patches: PrototypePatch[] },
): string {
  const { pages, patches } = input
  const shared = patches.filter((patch) => patch.page === null)
  const entry = findEntryPage(pages)

  const lines = [
    `# Prototype change spec — ${slug}`,
    '',
    `${pages.length} page${pages.length === 1 ? '' : 's'}, ${patches.length} patch${patches.length === 1 ? '' : 'es'}. ` +
      `Derived from \`prototypes/${slug}/\` — the listings below are exactly what the prototype applies, in replay order.`,
    '',
    '## Pages',
    '',
    '| # | Page | Kind | Where | Entry |',
    '| --- | --- | --- | --- | --- |',
    ...pages.map((page, index) =>
      `| ${index + 1} | \`${page.name}\` | ${page.kind} | ${page.url ?? page.file ?? '—'} | ${
        page.entry ? 'yes' : '—'
      } |`,
    ),
    '',
    entry
      ? `The address root opens \`${entry.name}\`.`
      : 'The address root shows the generated page index (no page is marked as the entry).',
    '',
    '## Patches',
    '',
    '`patches/*` repeats on every page; `patches/<page>/*` belongs to that page only.',
    '',
  ]

  if (shared.length > 0) {
    lines.push('### Shared (every page)', '', `${shared.length} patch(es).`, '')
    shared.forEach((patch, index) => lines.push(...patchSection(patch, index + 1)))
  } else {
    lines.push('### Shared (every page)', '', '_None._', '')
  }

  if (patches.length === 0) {
    lines.push('_No patches at all._')
    return lines.join('\n')
  }

  for (const page of pages) {
    const own = patches.filter((patch) => patch.page === page.name)
    lines.push(
      `### \`${page.name}\` — ${page.kind} (${page.url ?? page.file ?? 'no document'})`,
      '',
      shared.length > 0
        ? `Carries all ${shared.length} shared patch(es)${page.kind === 'overlay' ? ' when the page loads' : ''}, and:`
        : 'Carries:',
      '',
    )
    if (own.length === 0) {
      lines.push('_None of its own._', '')
      continue
    }
    own.forEach((patch, index) => lines.push(...patchSection(patch, index + 1)))
  }

  return lines.join('\n')
}

/** Where a prototype's page is, and what showing it takes. */
export interface PrototypeEntry {
  /** The page being opened, or null when the address root shows the generated page index. */
  page: string | null
  /**
   * Absolute path to the document for a page of ours; null for an index (nothing
   * of the author's to read) and for an overlay page (the document is someone
   * else's, at an address).
   */
  path: string | null
  /** The address to open. */
  url: string
  /**
   * The prototype's **own** address (`http://<slug>-<hash>.localhost/`), whatever
   * the page's own address is. Null only when nothing is answering prototypes.
   *
   * Not the same thing as {@link url}, and that difference is the reason this
   * field exists: an overlay page's address is a third-party one, so once the view
   * loads it, **nothing in the URL says which prototype the window is working
   * on**. Callers opening a window should carry this along, so the address bar
   * and the prototype actions can read one fact instead of two (see
   * `browser-pane-manager`'s `prototypeBindingFor`).
   */
  origin: string | null
  /**
   * Whether the patches have to be replayed into the page after it loads.
   *
   * True for an overlay page: it is the live one, which knows nothing about the
   * prototype until the patches land in it. False for a page of ours, which the
   * host renders from the document plus that page's patches on every request, and
   * for the index, which is ours already.
   */
  injectPatches: boolean
}

/**
 * Resolve where a prototype is shown — its entry page, one named page, or the
 * generated page index.
 *
 * The answer follows the page table (plan §19.3), and the difference between the
 * cases is the whole point of having kinds:
 *
 * - **no entry page** — the root shows the **generated index**, a list of every
 *   page with a way into each. Nothing is rendered, so nothing can be stale.
 * - **an overlay page** — the address is the **live address** it records. That
 *   page brings its own JavaScript, its own session and its own data; the
 *   prototype is that page with patches replayed into it. Nothing is copied: a
 *   frozen snapshot could not run the app's own JS and would carry no session, so
 *   it would only *look* like the page being worked on.
 * - **a page of ours** — the host renders it, since the document is ours and there
 *   is no address to point at.
 *
 * `page` names one page explicitly, which is how "open the page this address
 * names" works: the caller resolves the address here and loads the result, rather
 * than asking the host to redirect it there (the address bar and the view are two
 * different things — the bar keeps saying which prototype and page, while the view
 * loads the real address).
 *
 * `injectPatches` is the one thing the caller has to act on: for an overlay page,
 * the address is not yet "the prototype" until the replay happens.
 *
 * @throws when there is nothing to open: no pages at all, a named page that does
 *   not exist, an entry page whose document is gone, or a prototype of ours with
 *   no host answering for it.
 */
export function resolvePrototypeEntry(
  workspaceRootPath: string,
  slug: string,
  page?: string | null,
): PrototypeEntry {
  const pages = listPrototypePages(workspaceRootPath, slug)
  const origin = prototypeOriginUrl(workspaceRootPath, slug)
  const dir = getPrototypeDirPath(workspaceRootPath, slug)

  if (pages.length === 0) {
    throw new Error(
      `Prototype "${slug}" has no pages yet, so there is nothing to open. Write one ` +
        `(a top-level <name>.html in ${dir}), or add an overlay page ` +
        `("prototype-pages --add <name>=<url>").`,
    )
  }

  if (page) {
    const wanted = pages.find((candidate) => candidate.name === page)
    if (!wanted) {
      const names = pages.map((candidate) => candidate.name).join(', ') || 'none'
      throw new Error(
        `Prototype "${slug}" has no page "${page}". Pages: ${names} (the index is at ${PROTOTYPE_INDEX_PATH}).`,
      )
    }

    if (wanted.kind === 'overlay') {
      if (!wanted.url) {
        throw new Error(
          `Page "${wanted.name}" of prototype "${slug}" records no address, so there is no live page to open.`,
        )
      }
      return { page: wanted.name, path: null, url: wanted.url, origin, injectPatches: true }
    }

    if (!wanted.file) {
      throw new Error(
        `Page "${wanted.name}" of prototype "${slug}" has no document: ${pageFileName(wanted.name)} is not in ${dir}.`,
      )
    }
    if (!origin) {
      throw new Error(
        `No host is serving prototypes, so "${slug}" has no address that renders "${wanted.name}" with its patches ` +
          `applied — opening ${wanted.file} directly would show the page with none of them.`,
      )
    }
    return {
      page: wanted.name,
      path: join(dir, wanted.file),
      url: wanted.url ?? origin,
      origin,
      injectPatches: false,
    }
  }

  const entry = findEntryPage(pages)
  if (!entry) {
    if (!origin) {
      throw new Error(
        `No host is serving prototypes, so "${slug}" has no address for its page index.`,
      )
    }
    return { page: null, path: null, url: origin, origin, injectPatches: false }
  }

  if (entry.kind === 'overlay') {
    if (!entry.url) {
      throw new Error(
        `Prototype "${slug}" has page "${entry.name}" as its entry page, but that row records no address, ` +
          `so there is no live page to open.`,
      )
    }
    // The window's identity is still the prototype's own address — that is what
    // its address bar reads and what makes it "the prototype's window" — even
    // though the view loads the live page whose origin is somebody else's.
    return { page: entry.name, path: null, url: entry.url, origin, injectPatches: true }
  }

  if (!entry.file) {
    throw new Error(
      `Prototype "${slug}" has "${entry.name}" as its entry page, but ${pageFileName(entry.name)} is not in ` +
        `${dir}. Write it, or point the entry at another page.`,
    )
  }

  if (!origin) {
    throw new Error(
      `No host is serving prototypes, so "${slug}" has no address that renders it with its patches ` +
        `applied — opening ${entry.file} directly would show the page with none of them.`,
    )
  }

  return { page: entry.name, path: join(dir, entry.file), url: origin, origin, injectPatches: false }
}

/**
 * The contract's `x-mock` routes across every service of this prototype, in
 * service-name order — the layer the extension ships (see `buildMockScript`).
 */
function collectMockRoutes(workspaceRootPath: string, slug: string): MockRoute[] {
  return listContractServices(workspaceRootPath, slug).flatMap(
    (service) => buildMockRoutes(loadContractService(workspaceRootPath, slug, service)).routes,
  )
}

/**
 * Static files that can travel as text. Anything else (images, fonts) would be
 * corrupted by a utf-8 round trip, so it is named in the warnings instead of
 * quietly arriving broken.
 */
const TEXT_ASSET_RE = /\.(css|js|mjs|json|html|htm|svg|txt|md|webmanifest)$/i

/**
 * The prototype's own static files, under the name they are referenced by.
 *
 * Pages address them with root-absolute paths (`/assets/app.css`), and inside an
 * extension page that path resolves to the *package* root — so copying the
 * directory unchanged is what makes the delivered page look like the previewed
 * one. Without it, a prototype that uses any stylesheet, script or image of its
 * own loses them the moment it is handed over, silently (plan §17).
 */
function collectAssetFiles(
  workspaceRootPath: string,
  slug: string,
): { files: ExtensionFile[]; warnings: string[] } {
  const assetsDir = join(getPrototypeDirPath(workspaceRootPath, slug), 'assets')
  if (!existsSync(assetsDir)) return { files: [], warnings: [] }

  const files: ExtensionFile[] = []
  const warnings: string[] = []

  const walk = (dir: string, prefix: string): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), relative)
        continue
      }
      if (!entry.isFile()) continue
      if (!TEXT_ASSET_RE.test(entry.name)) {
        warnings.push(
          `assets/${relative} is not a text file, so it is not in the package — a binary asset needs a ` +
            `delivery route of its own (the page will reference a file that is not there).`,
        )
        continue
      }
      files.push({ path: `assets/${relative}`, content: readFileSync(join(dir, entry.name), 'utf-8') })
    }
  }

  walk(assetsDir, '')
  return { files, warnings }
}

/**
 * `eval` / `new Function` in the code that is about to be shipped.
 *
 * These are the one mistake every other check misses: the export succeeds, and the
 * delivered extension then refuses to run that code (MV3 forbids dynamic
 * evaluation), on someone else's machine. Reported in the author's own output,
 * while the page is still in front of them.
 */
const DYNAMIC_EVAL_RE = /\beval\s*\(|new\s+Function\s*\(/

function dynamicEvaluationWarnings(documents: ExtensionDocument[], patches: PrototypePatch[]): string[] {
  const warnings: string[] = []

  for (const document of documents) {
    if (DYNAMIC_EVAL_RE.test(document.html)) {
      warnings.push(
        `${document.path} calls eval or new Function, which the delivered extension refuses to run ` +
          `(rewrite it as ordinary code — a table lookup or a switch is usually what was wanted).`,
      )
    }
  }
  for (const patch of patches) {
    if (patch.kind === 'js' && DYNAMIC_EVAL_RE.test(patch.source)) {
      warnings.push(
        `patches/${patch.file} calls eval or new Function, which the delivered extension refuses to run.`,
      )
    }
  }

  return warnings
}

/**
 * Write `dist/extension/` from scratch.
 *
 * A re-export replaces the folder rather than merging into it: a stale file left
 * behind (a patch that was deleted, a page renamed) would still be loaded by
 * Chrome, so "the package is exactly what this prototype is right now" only holds
 * if the folder is rebuilt.
 */
function writeExtensionPackage(dir: string, files: Array<{ path: string; content: string }>): void {
  rmSync(dir, { recursive: true, force: true })
  for (const file of files) {
    const target = join(dir, file.path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, file.content, 'utf-8')
  }
}

/**
 * Write the deliverables for a prototype.
 *
 * One artifact, and it covers the whole flow whatever it is made of (plan §19.5):
 * pages of ours ship as documents under the names they have on disk (a page left
 * out would be a link that 404s, so "every page" is not a nicety here — it is what
 * makes the package a flow), and overlay pages are injected into by a content
 * script scoped to their address. The entry page is named in the manifest, and the
 * generated page index is the options page either way.
 *
 * @throws when the prototype has no pages (there is no entry page to hand over,
 *   and an empty one would be a lie); when a page in the table has no document (the
 *   package would silently be missing a screen); and when an overlay page's address
 *   cannot become a match pattern (naming *which* page, since silently covering one
 *   page less is the failure this design keeps avoiding).
 */
export function exportPrototype(workspaceRootPath: string, slug: string): PrototypeExportResult {
  const dir = getPrototypeDirPath(workspaceRootPath, slug)
  const pages = listPrototypePages(workspaceRootPath, slug)
  const patches = scanPrototypePatches(workspaceRootPath, slug)
  const entry = findEntryPage(pages)
  const layout = readPrototypeLayout(workspaceRootPath, slug)

  if (pages.length === 0) {
    throw new Error(
      `Prototype "${slug}" has no pages, so there is nothing to deliver. Write a page ` +
        `(a top-level <name>.html in ${dir}) or add an overlay page first.`,
    )
  }

  // A page in the table with no document is not "one page less": it is a screen
  // the deliverable would be missing while the table still claims it. Say so.
  const missing = pages.filter((page) => page.kind === 'scratch' && !page.file)
  if (missing.length > 0) {
    throw new Error(
      `Prototype "${slug}" lists page(s) ${missing.map((page) => `"${page.name}"`).join(', ')} in its table, ` +
        `but their documents are not in ${dir}, so the package would be missing them.`,
    )
  }

  const documents: ExtensionDocument[] = pages
    .filter((page): page is PrototypePage & { file: string } => page.kind === 'scratch' && page.file !== null)
    .map((page) => ({
      path: page.file,
      page: page.name,
      // The shell travels with the page, exactly as the host applies it, so the
      // delivered document is the one that was previewed (plan §19.2).
      html: applyPrototypeLayout(readFileSync(join(dir, page.file), 'utf-8'), layout),
    }))

  const targets = pages
    .filter((page): page is PrototypePage & { url: string } => page.kind === 'overlay' && page.url !== null)
    .map((page) => ({ page: page.name, url: page.url }))

  // The same index the host serves at `/_index` (plan §19.3), written into the
  // package because the recipient has no host: their links are package files for
  // our pages and real addresses for the overlay ones.
  const indexDocument = buildPrototypeIndexDocument({
    slug,
    pages,
    href: (page) => (page.kind === 'overlay' ? page.url : page.file),
  })

  const pkg = buildExtensionPackage({
    slug,
    targets,
    documents,
    entryPage: entry?.name ?? null,
    indexDocument,
    patches,
    mocks: collectMockRoutes(workspaceRootPath, slug),
    builtAt: new Date(),
  })

  const extensionDir = join(getPrototypeDistPath(workspaceRootPath, slug), EXTENSION_DIRNAME)
  // The prototype's own static files go in with the package, under the same paths
  // the pages address them by — before the generated files, so a generated file
  // wins if a hand-written one ever collides with it.
  const assets = collectAssetFiles(workspaceRootPath, slug)
  writeExtensionPackage(extensionDir, [...assets.files, ...pkg.files])

  // What a recipient should open first: our entry page when there is one, and the
  // index (the options page) otherwise. An overlay's entry page is not ours to
  // open, so there is nothing to point at.
  const pagePath = entry
    ? entry.kind === 'scratch' && entry.file
      ? join(extensionDir, entry.file)
      : null
    : join(extensionDir, EXTENSION_INDEX_FILENAME)

  const specPath = join(getPrototypeDistPath(workspaceRootPath, slug), DEV_SPEC_FILENAME)
  writeFileSync(specPath, buildDevSpec(slug, { pages, patches }), 'utf-8')

  return {
    slug,
    extensionDir,
    pagePath,
    pageUrl: pagePath ? prototypeDocumentUrl(workspaceRootPath, slug, pagePath) : null,
    version: pkg.version,
    specPath,
    applied: patches.length,
    pageCount: pages.length,
    warnings: [...pkg.warnings, ...assets.warnings, ...dynamicEvaluationWarnings(documents, patches)],
  }
}
