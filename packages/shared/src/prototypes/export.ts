/**
 * Prototype export.
 *
 * Turns a prototype into role-shaped deliverables under `dist/`:
 *  - `extension/`     — a loadable Chrome extension: the piece a human *looks at*
 *                       (it applies the patches to the live pages of an overlay
 *                       page, and ships our own documents) (see extension.ts, and
 *                       §17/§19.5 of the plan)
 *  - `static/`        — every page of ours as one self-contained HTML file: the
 *                       same page with nothing to install and no host to serve it
 *                       (see {@link buildStaticPage}, and §17.8 of the plan)
 *  - `bookmarklet.html` — the live pages' changes as draggable bookmarks, for a
 *                       browser that will not load an extension (see bookmarklet.ts,
 *                       and §17.9 of the plan)
 *  - `dev-spec.md`    — the change list a developer reads
 *  - `handoff.md`     — the delivery's index: what to open, in what order, for whom, and what the
 *                       last verification still left outstanding (see {@link buildHandoff})
 *
 * The patch order inside the extension is the same derived order used for live
 * replay, and the page scoping is the same directory rule, so the deliverable and
 * the workbench agree by construction.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'path'
import { buildMockRoutes, listContractServices, loadContractService } from './contract.ts'
import { BOOKMARKLET_FILENAME, buildBookmarkletDocument } from './bookmarklet.ts'
import { readAllPrototypeAnchors, SHARED_ANCHOR_SCOPE, type PrototypeAnchor, type PrototypeAnchorFile } from './anchors.ts'
import { mergeMockStores, noMockProgram, type MockProgram } from './mock-engine.ts'
import { resolveRequirementCoverage, type RequirementCoverageReport } from './coverage.ts'
import {
  buildExtensionPackage,
  buildMockScript,
  EXTENSION_INDEX_FILENAME,
  type ExtensionDocument,
  type ExtensionFile,
} from './extension.ts'
import { buildPrototypeIndexDocument, applyPrototypeLayout } from './page-document.ts'
import {
  findEntryPage,
  isPrototypePagePath,
  listPrototypePages,
  pageFileName,
  PROTOTYPE_INDEX_PATH,
  type PrototypePage,
} from './pages.ts'
import { readPrototypeLayout } from './create.ts'
import { buildPatchInitScript, buildPatchMatchRecorderScript } from './patch-script.ts'
import { extractPatchHeader } from './patch-header.ts'
import { buildPrototypeStatus } from './status.ts'
import { getPrototypeDistPath, getPrototypeDirPath, scanPrototypePatches } from './storage.ts'
import { prototypeDocumentUrl, prototypeOriginUrl } from './url.ts'
import type { MockRoute } from './contract.ts'
import { CONSOLIDATED_WRITER, isConsolidatedWriter, type PrototypePatch } from './types.ts'

const DEV_SPEC_FILENAME = 'dev-spec.md'
const HANDOFF_FILENAME = 'handoff.md'
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
  /**
   * Absolute path to `dist/handoff.md` — which artifact each reader takes, and what the last
   * verification left outstanding (see {@link buildHandoff}). The index a recipient opens first.
   */
  handoffPath: string
  /**
   * Absolute path to `dist/static/` — every page of ours as one self-contained
   * HTML file — or null when the prototype has none. A flow made only of live pages
   * is carried by the extension alone: those pages are not ours to freeze.
   */
  staticDir: string | null
  /**
   * The static file a recipient opens first: the entry page's, since that is where
   * the flow is walked from. Null when the entry page is a live one — nothing of
   * ours is the way in, though the other pages are still there.
   */
  staticPath: string | null
  /**
   * What a static page could not carry — a reference to a file that is not in the
   * prototype, which a single file has no way to resolve.
   *
   * Kept apart from {@link warnings} because the two deliverables are adapted
   * differently: those are things the *extension* had to change about a document,
   * and this one has no directory of its own rather than a CSP.
   */
  staticWarnings: string[]
  /**
   * Absolute path to `dist/bookmarklet.html` — the live pages' changes as draggable
   * bookmarks — or null when there is no live page with anything to apply.
   *
   * The same changes the extension carries, for the machine where an unpacked
   * extension cannot be loaded at all; what a bookmark gives up for that is written
   * in the file itself (see bookmarklet.ts).
   */
  bookmarkletPath: string | null
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

  // The css above was inlined as text, so it has no script to report what its
  // selectors matched. One recorder for the whole page fills that in, which is
  // what keeps "matched nothing" from looking like "changed nothing" on the page
  // the author is looking at (plan §21.1).
  const recorder = buildPatchMatchRecorderScript(patches)
  if (recorder) {
    out = insertBeforeClosingTag(out, recorder, '</body>') ?? `${out}\n${recorder}`
  }

  return out
}

// ---------------------------------------------------------------------------
// The static deliverable: every page of ours as one file that needs nothing
// ---------------------------------------------------------------------------

/**
 * The second deliverable, for the half of a prototype that can travel in a file.
 *
 * A page of ours *is* a document, so it can be handed over whole: the patches
 * inlined (css as text, js through the replay transform), the mock layer inlined,
 * and every reference it makes to a file of this prototype inlined too. No host,
 * no extension, no server — double-click it, or attach it to a message.
 *
 * It exists because an extension is a heavy thing to ask of a reader when the
 * page is ours anyway: `chrome://extensions`, Developer mode, Load unpacked, and
 * a folder that has to stay where it is. Live pages have no such alternative —
 * they are somebody else's, they run their own code and carry their own session,
 * so a copy of one would only *look* like the page being worked on (see
 * {@link resolvePrototypeEntry}) — which is why a prototype made only of live
 * pages has no static deliverable at all, and the export says so by leaving
 * {@link PrototypeExportResult.staticPath} null rather than writing an empty folder.
 *
 * The transform is the **preview's** ({@link buildSelfContainedHtml}), not a second
 * renderer: same patches, same order, same inlining, so the file a recipient opens
 * is the page the author previewed. What the preview gets from the host — the mock
 * layer, and a directory to resolve `/assets/…` against — is inlined here instead.
 */

const STATIC_DIRNAME = 'static'

/** Media type by extension, for the references inlined as data URLs. */
const ASSET_MEDIA_TYPES: Record<string, string> = {
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
}

function mediaTypeFor(file: string): string {
  return ASSET_MEDIA_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * What a page's reference to a file of this prototype becomes in a single file.
 *
 * Three answers rather than "inlined or not", because one of them has to be said
 * out loud: a reference that names no file of this prototype is a link that breaks
 * the moment the page leaves the prototype directory, and that is worth reporting
 * rather than leaving for the recipient to find.
 */
export type StaticAssetResolution =
  /** The file, carried inside the page as a data URL. */
  | { kind: 'inline'; dataUrl: string }
  /** A page of ours: it travels beside this file, so a root-absolute link to it is made relative. */
  | { kind: 'sibling' }
  /** Names no file of this prototype, so nothing here can make it work. */
  | { kind: 'missing' }

export type StaticAssetResolver = (reference: string) => StaticAssetResolution

/**
 * A reference in an attribute — what a page *points at*, as opposed to what it
 * says. `src` and `href` only: those are the two a page of ours uses to pull a
 * file in (`<link>`, `<script>`, `<img>`), and the two whose meaning changes once
 * the page has no directory beside it.
 */
const REFERENCE_ATTRIBUTE_RE = /(\s(?:src|href)\s*=\s*)(["'])([^"']*)\2/gi

/** A value that is not a path into this prototype: a scheme, protocol-relative, or a fragment. */
const EXTERNAL_REFERENCE_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i

/**
 * Replace every reference a document makes to a file of this prototype with
 * something the file itself can carry.
 *
 * Runs over the document **before** anything of ours is inlined into it, so a js
 * patch that happens to contain something shaped like an attribute cannot be
 * rewritten by it. It is a text transform over the document, so a reference
 * written inside the page's own inline script is treated like any other — the same
 * technique (and the same blind spot) as the extension's document rewriting.
 *
 * @param resolve decides what a reference becomes; a `missing` one is reported
 *   rather than left silently broken.
 */
export function inlineLocalReferences(
  html: string,
  resolve: StaticAssetResolver,
): { html: string; warnings: string[] } {
  const warnings: string[] = []
  const reported = new Set<string>()

  const rewritten = html.replace(
    REFERENCE_ATTRIBUTE_RE,
    (match, prefix: string, quote: string, value: string) => {
      if (!value || EXTERNAL_REFERENCE_RE.test(value)) return match

      // A fragment belongs to the reference rather than to the file — `sprite.svg#icon`
      // has to stay `…data:…#icon` or the `<use>` finds nothing. A query string is a
      // cache-buster, and a file that carries its own content has no cache to bust,
      // so it is dropped.
      const fragmentAt = value.indexOf('#')
      const fragment = fragmentAt === -1 ? '' : value.slice(fragmentAt)
      const withoutFragment = fragmentAt === -1 ? value : value.slice(0, fragmentAt)
      const queryAt = withoutFragment.indexOf('?')
      const reference = queryAt === -1 ? withoutFragment : withoutFragment.slice(0, queryAt)
      const query = queryAt === -1 ? '' : withoutFragment.slice(queryAt)
      if (!reference) return match

      const resolution = resolve(reference)
      if (resolution.kind === 'sibling') {
        // A page of ours travels beside this file under the name it has on disk,
        // but a **root-absolute** link to it (`/orders.html`) resolves against the
        // server's document root in the browser and against the filesystem root
        // here — so it becomes the relative name the file actually has. A link
        // already written relative is left exactly as the author wrote it.
        if (!reference.startsWith('/')) return match
        return `${prefix}${quote}${reference.replace(/^\/+/, '')}${query}${fragment}${quote}`
      }
      if (resolution.kind === 'missing') {
        if (!reported.has(value)) {
          reported.add(value)
          warnings.push(
            `the page references \`${value}\`, which is not a file of this prototype — a single file ` +
              'cannot carry it, so it is a broken reference once the page is opened on its own.',
          )
        }
        return match
      }
      return `${prefix}${quote}${resolution.dataUrl}${fragment}${quote}`
    },
  )

  return { html: rewritten, warnings }
}

/** `block` just after the opening tag starting with `openingTag` — attributes and all. */
function insertAfterOpeningTag(html: string, block: string, openingTag: string): string | null {
  const at = html.toLowerCase().indexOf(openingTag)
  if (at === -1) return null
  const end = html.indexOf('>', at)
  if (end === -1) return null
  return `${html.slice(0, end + 1)}\n${block}${html.slice(end + 1)}`
}

/**
 * One page of ours as a self-contained file.
 *
 * The order matters: the document's own references are inlined **first**, so the
 * blocks this adds are never scanned by the reference transform — a js patch is
 * source code that may contain anything, and rewriting a string inside it would be
 * a change to the patch rather than to the page.
 *
 * The mock layer goes in at the top of `<head>` rather than with the patches at
 * the end of `<body>`, because it has to be installed before the page's own code
 * captures a reference to `fetch` — the same reason the extension declares it
 * `document_start`, in the page's world.
 *
 * @param document the page, with the shared shell already applied — what the host
 *   would serve and the extension package ships.
 * @param patches the whole prototype's patches; only the ones **this page** carries
 *   are inlined, by the same rule as everywhere else (plan §19.4).
 */
export function buildStaticPage(input: {
  /** The page this document is, as the table knows it. */
  page: string
  document: string
  patches: PrototypePatch[]
  /** The contract's `x-mock` routes, inlined so the page's own fetches are answered. */
  mocks?: MockProgram
  resolveAsset: StaticAssetResolver
}): { html: string; warnings: string[] } {
  const mocks = input.mocks ?? noMockProgram()
  const references = inlineLocalReferences(input.document, input.resolveAsset)
  const carries = input.patches.filter(
    (patch) => patch.page === null || patch.page === input.page,
  )
  let html = buildSelfContainedHtml(references.html, carries)

  if (mocks.routes.length > 0) {
    const block = `<script>\n${buildMockScript(mocks)}</script>`
    html =
      insertAfterOpeningTag(html, block, '<head') ??
      insertBeforeClosingTag(html, block, '</body>') ??
      `${block}\n${html}`
  }

  return { html, warnings: references.warnings }
}

/**
 * Resolve a reference to a file of this prototype, as something one file can carry.
 *
 * A page lives at the root of the prototype, so a reference is resolved against
 * the prototype directory whether it is written root-absolute (`/assets/app.css`)
 * or relative (`assets/app.css`) — the same tree the origin serves out of, which is
 * why both forms name one file.
 *
 * Text and binary travel alike, as a base64 data URL: one rule, and no escaping to
 * get wrong (`#`, `%` and quotes are all legal in a path). The cost is the one worth
 * stating rather than hiding — an inlined script's stack traces name a data URL
 * instead of a file, and the page is about a third larger than its parts.
 */
function buildStaticAssetResolver(dir: string): StaticAssetResolver {
  return (reference) => {
    const at = resolve(dir, reference.replace(/^\/+/, ''))
    const inside = relative(dir, at)
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) return { kind: 'missing' }
    if (!existsSync(at) || !statSync(at).isFile()) return { kind: 'missing' }

    // A page of ours is a *file beside this one*, not something to carry: the
    // author's `<a href="orders.html">` is a navigation, and inlining it would
    // replace the page with a copy of itself and lose its own link base.
    if (isPrototypePagePath(inside.replace(/\\/g, '/'))) return { kind: 'sibling' }
    return {
      kind: 'inline',
      dataUrl: `data:${mediaTypeFor(at)};base64,${readFileSync(at).toString('base64')}`,
    }
  }
}

/**
 * Every page of ours, as the files of the static deliverable.
 *
 * One file per page, under the name it has on disk — the same rule the extension
 * package follows, and for the same reason: the links between pages are ordinary
 * relative links the author wrote, and they keep working if the names do. The entry
 * page is named back, so the caller can say which file to open first.
 */
function buildStaticPages(input: {
  documents: ExtensionDocument[]
  patches: PrototypePatch[]
  mocks: MockProgram
  /** The prototype directory: what a page's references are resolved against. */
  dir: string
  entryPage: string | null
}): { files: Array<{ path: string; content: string }>; entryPath: string | null; warnings: string[] } {
  const resolveAsset = buildStaticAssetResolver(input.dir)
  const files: Array<{ path: string; content: string }> = []
  const warnings: string[] = []
  let entryPath: string | null = null

  for (const document of input.documents) {
    const page = buildStaticPage({
      page: document.page,
      document: document.html,
      patches: input.patches,
      mocks: input.mocks,
      resolveAsset,
    })
    files.push({ path: document.path, content: page.html })
    // Named per page: with several pages, "the page references …" would not say
    // which document needed it.
    warnings.push(...page.warnings.map((warning) => `${document.path}: ${warning}`))
    if (document.page === input.entryPage) entryPath = document.path
  }

  return { files, entryPath, warnings }
}

/** A backtick fence longer than any run inside `source`, so content can't break out. */
function fenceFor(source: string): string {
  const runs = source.match(/`+/g) ?? []
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0)
  return '`'.repeat(Math.max(3, longest + 1))
}

/**
 * One declared `@target`, with what the anchor record says about it.
 *
 * Three states, and they are three different problems for whoever has to translate this into the
 * page's own source:
 *
 * - **it matched** — the record holds how many elements and when, so the reader knows the change
 *   was seen working against a real page rather than merely written;
 * - **it was recorded and matches nothing now** — the page moved. The fingerprint is what makes
 *   this recoverable rather than only reportable: it carries candidate selectors for the element
 *   that moved, which is the thing the reader needs next (plan §21.2);
 * - **no record at all** — nothing has ever seen it match. Said as that, not as "broken": an
 *   untouched prototype has no record either.
 */
function targetLine(target: string, anchor: PrototypeAnchor | undefined): string[] {
  if (!anchor) return [`Aimed at \`${target}\` — nothing has recorded it matching.`]

  const when = anchor.lastMatchedAt.slice(0, 10) || '—'
  if (anchor.matched > 0) {
    return [`Aimed at \`${target}\` — matched ${anchor.matched} element(s), last seen ${when}.`]
  }

  const { tag, text, attrs } = anchor.fingerprint
  const was = [tag, text ? `“${text}”` : ''].filter(Boolean).join(' ')
  const moved = `Aimed at \`${target}\` — recorded ${when} as ${was}, and matching nothing since: the page moved.`
  return attrs.length > 0
    ? [moved, `It is now reachable as ${attrs.map((candidate) => `\`${candidate}\``).join(', ')}.`]
    : [moved]
}

/** One patch's full listing, with a heading that says where it belongs. */
function patchSection(
  patch: PrototypePatch,
  index: number,
  anchorFor: (target: string) => PrototypeAnchor | undefined,
): string[] {
  const fence = fenceFor(patch.source)
  const scope = patch.page ? `page \`${patch.page}\`` : 'every page'
  const header = extractPatchHeader(patch.source)
  // What the patch declares about itself, and — for each declared target — what the record says
  // about whether that selector still describes the page. The second half is the fact a reader
  // cannot get anywhere else: it is only knowable by having been there when the change ran.
  const declared = header.targets.flatMap((target) => targetLine(target, anchorFor(target)))
  const lines = [
    `#### ${index}. \`${patch.file}\``,
    '',
    `${patch.kind === 'css' ? 'CSS' : 'JavaScript'} patch, writer ${patch.writer ?? '—'}${
      isConsolidatedWriter(patch.writer) ? ' (consolidated)' : ''
    }, order ${patch.order}, ${scope}.`,
    '',
  ]
  if (declared.length > 0) lines.push(...declared, '')
  else lines.push('Declares no `@target`, so nothing checked what it matched.', '')
  if (header.requirements.length > 0) {
    lines.push(`Serves ${header.requirements.map((id) => `\`${id}\``).join(', ')}.`, '')
  }
  lines.push(fence + (patch.kind === 'css' ? 'css' : 'javascript'), patch.source, fence, '')
  return lines
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
  input: {
    pages: PrototypePage[]
    patches: PrototypePatch[]
    coverage?: RequirementCoverageReport
    /** The anchor records (`anchors/`), so each `@target` can be reported with its health. */
    anchors?: PrototypeAnchorFile[]
  },
): string {
  const { pages, patches, coverage, anchors } = input
  const shared = patches.filter((patch) => patch.page === null)
  const entry = findEntryPage(pages)

  // Anchors are keyed by scope, and a patch's scope is where it lives: its own page's directory, or
  // the shared one. A target with no entry simply has no record — nothing is invented here.
  const anchorIndex = new Map<string, PrototypeAnchor>()
  for (const file of anchors ?? []) {
    const scope = file.page ?? SHARED_ANCHOR_SCOPE
    for (const anchor of file.anchors) anchorIndex.set(`${scope}\u0000${anchor.target}`, anchor)
  }
  const anchorFor = (patch: PrototypePatch) => (target: string) =>
    anchorIndex.get(`${patch.page ?? SHARED_ANCHOR_SCOPE}\u0000${target}`)

  const lines = [
    `# Prototype change spec — ${slug}`,
    '',
    `${pages.length} page${pages.length === 1 ? '' : 's'}, ${patches.length} patch${patches.length === 1 ? '' : 'es'}. ` +
      `Derived from \`prototypes/${slug}/\` — the listings below are exactly what the prototype applies, in replay order.`,
    '',
    // Requirements before pages, when there are any: this document is translated
    // onto a real page by someone who was not in the room, and the *why* is what
    // decides how that translation goes (plan §20.1).
    ...(coverage && coverage.requirements.length > 0
      ? [
          '## Requirements',
          '',
          'From `PRD.md`. The last column is derived from `@requirement R-00x` markers in patch headers and page',
          'documents, so a row without one is a requirement that nothing here implements.',
          '',
          '| # | Id | Requirement | Referred to by |',
          '| --- | --- | --- | --- |',
          ...coverage.requirements.map((requirement, index) => {
            const covered = [
              ...requirement.pages,
              ...requirement.patches,
              ...requirement.findings.map((id) => `${id} (finding)`),
            ]
            return `| ${index + 1} | \`${requirement.id}\` | ${requirement.title || '—'} | ${
              covered.map((entry) => `\`${entry}\``).join(', ') || '**nothing**'
            } |`
          }),
          '',
          ...(coverage.unclaimed.length > 0
            ? [
                `Changes that name no requirement: ${coverage.unclaimed.map((path) => `\`${path}\``).join(', ')}.`,
                '',
              ]
            : []),
          // The argument against the work, in the document the recipient reads: a spec that lists
          // only what was built hands over a claim, not a position. Both lists are the same objects
          // the status report uses, so the package cannot say something the workbench does not.
          ...(coverage.reviews.total > 0
            ? [
                '## Reviews',
                '',
                `${coverage.reviews.total} dispute(s) filed under \`reviews/\`, ` +
                  `${coverage.reviews.unresolved.length} still standing.`,
                '',
                ...(coverage.reviews.unresolved.length > 0
                  ? [
                      '| Id | About | Status | Claim |',
                      '| --- | --- | --- | --- |',
                      ...coverage.reviews.unresolved.map(
                        (dispute) =>
                          `| \`${dispute.id}\` | ${dispute.about}${dispute.stale ? ' **(stale)**' : ''} | ${dispute.status ?? '—'} | ${dispute.claim ?? '—'} |`,
                      ),
                      '',
                      ...coverage.reviews.unresolved
                        .filter((dispute) => dispute.stale && dispute.staleReason)
                        .map((dispute) => `- \`${dispute.id}\`: ${dispute.staleReason}`),
                      ...(coverage.reviews.unresolved.some((dispute) => dispute.stale) ? [''] : []),
                      'These were not resolved when this package was built: read them before implementing the',
                      'change, because each one is a question about whether it should be implemented as written.',
                      '',
                    ]
                  : ['Nothing is standing: every dispute filed so far was answered.', '']),
              ]
            : []),
        ]
      : []),
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
    '`patches/*` repeats on every page; `patches/<page>/*` belongs to that page only. Writer `Z` is a copy whose',
    'changes were folded in — it replays after everything else, and its provenance comments name',
    'the patches it replaced.',
    '',
    'Each change says what its `@target` was aimed at, and what the anchor record knows about that',
    'selector: how many elements it matched and when, or that it was recorded and matches nothing now.',
    'The second is the one worth reading before translating anything into source — it means the page has',
    'changed since this was written, so the change describes a page that is no longer there.',
    '',
  ]

  if (shared.length > 0) {
    lines.push('### Shared (every page)', '', `${shared.length} patch(es).`, '')
    shared.forEach((patch, index) => lines.push(...patchSection(patch, index + 1, anchorFor(patch))))
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
    own.forEach((patch, index) => lines.push(...patchSection(patch, index + 1, anchorFor(patch))))
  }

  return lines.join('\n')
}

/** `dist/` listing — file names, directories with a trailing slash, sorted. */
function listDistNames(dir: string): string[] {
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir, { withFileTypes: true })
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.isFile() ? entry.name : null))
      .filter((name): name is string => name !== null)
      .sort()
  } catch {
    return []
  }
}

/**
 * The delivery's own table of contents: which artifact each reader takes, and what to do with it.
 *
 * `dev-spec.md` answers "what does this change do"; this answers "what do I open, and in what
 * order" — the question a recipient asks first, and the one a folder of four files and a package
 * cannot answer by itself. It is written from the `dist/` listing as it exists at write time, so it
 * cannot point at an artifact that is not in the box.
 *
 * The last section is the workbench's own gate (`settleBlockers`, plan §3.7). A package handed over
 * with an unanswered objection or a failed check should say so on its first page rather than at the
 * end of a spec nobody read that far into.
 */
export function buildHandoff(input: {
  slug: string
  version: string
  builtAt: Date
  pages: PrototypePage[]
  patches: PrototypePatch[]
  entry: PrototypePage | null
  /** Names inside `dist/`, as they exist right now — the only artifacts the index may name. */
  files: string[]
  /** What is still outstanding, in the gate's own words. */
  blockers: string[]
}): string {
  const { slug, version, builtAt, pages, patches, entry, files, blockers } = input
  const has = (name: string) => files.includes(name)

  const rows: Array<[string, string, string]> = []
  if (has(DEV_SPEC_FILENAME)) {
    rows.push([
      `\`${DEV_SPEC_FILENAME}\``,
      'the developer implementing the change',
      "read this first — what each page changes, in replay order, with each change's `@target` and whether that selector still matches the page",
    ])
  }
  if (has(`${EXTENSION_DIRNAME}/`)) {
    rows.push([
      `\`${EXTENSION_DIRNAME}/\``,
      'the same developer, or anyone reviewing on the real pages',
      `Chrome → \`chrome://extensions\` → Load unpacked → pick this folder, then open the flow's addresses; \`${EXTENSION_DIRNAME}/README.md\` says which responses it fakes`,
    ])
  }
  if (has(`${STATIC_DIRNAME}/`)) {
    rows.push([
      `\`${STATIC_DIRNAME}/\``,
      'anyone who wants to look without installing anything',
      'open the entry page\'s file — every page of ours as one self-contained file',
    ])
  }
  if (has(BOOKMARKLET_FILENAME)) {
    rows.push([
      `\`${BOOKMARKLET_FILENAME}\``,
      'someone whose browser will not load an unpacked extension',
      'open it, drag the bookmark for the page you are on to the bookmarks bar, then reload that page',
    ])
  }
  if (has('acceptance.md')) {
    rows.push([
      '`acceptance.md`',
      'the person accepting the work',
      'what the checks in `PRD.md` answered last time, and how that differs from the round before',
    ])
  }
  if (has('contract.md')) {
    rows.push([
      '`contract.md`',
      'the backend',
      'the API this flow was built against — including what the contract does not declare yet',
    ])
  }
  if (has('openapi.yaml')) {
    rows.push(['`openapi.yaml`', 'the backend', 'the same contract, as OpenAPI 3.1'])
  }
  if (has('fixtures/')) {
    rows.push(['`fixtures/`', 'the backend', 'the recorded responses, one file per example'])
  }

  return [
    `# Handover — ${slug}`,
    '',
    `Built ${builtAt.toISOString()}, version \`${version}\`, from \`prototypes/${slug}/\`: ` +
      `${pages.length} page${pages.length === 1 ? '' : 's'}, ${patches.length} change${patches.length === 1 ? '' : 's'}.`,
    '',
    entry
      ? `The flow starts at \`${entry.name}\`${entry.url ? ` (${entry.url})` : ''}.`
      : 'No page is marked as the entry, so the address root opens the generated index — every page, in order.',
    '',
    `\`${DEV_SPEC_FILENAME}\` says what was changed. This file says what to open, in what order, and who each file is for.`,
    '',
    '## What to read, and what to do with it',
    '',
    '| Artifact | Who it is for | What to do with it |',
    '| --- | --- | --- |',
    ...rows.map(([artifact, who, what]) => `| ${artifact} | ${who} | ${what} |`),
    '',
    '## What this delivery does not settle',
    '',
    ...(blockers.length > 0
      ? [
          'Outstanding when this package was built, and the same list the workbench refuses a strict',
          'export on:',
          '',
          ...blockers.map((blocker) => `- ${blocker}`),
        ]
      : [
          'Nothing: every requirement in `PRD.md` is implemented, no objection is still standing, and the',
          'last verification round had no failures.',
        ]),
    '',
  ].join('\n')
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
        `("pages --add <name>=<url>").`,
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
 * The contract's mock program across every service of this prototype, in
 * service-name order — the layer the extension package and the static pages carry,
 * and the same one the workbench applies to a live page.
 *
 * One program rather than one per service, because nothing in a path item says
 * which service a collection belongs to: the author writes a dot path. Two
 * services naming the same top-level key is therefore a conflict, reported by
 * whoever applies the mock (`mock-apply`) rather than resolved here.
 * A service whose `state.json` is unusable still contributes its routes — an empty
 * store answers per request (404/500) instead of taking the whole mock down.
 */
function collectMockRoutes(workspaceRootPath: string, slug: string): { program: MockProgram; conflicts: string[] } {
  const loaded = listContractServices(workspaceRootPath, slug).map((service) =>
    loadContractService(workspaceRootPath, slug, service),
  )

  const merged = mergeMockStores(
    loaded.map((service) => ({ service: service.slug, store: service.state ?? {} })),
  )

  return {
    program: { routes: loaded.flatMap((service) => buildMockRoutes(service).routes), store: merged.store },
    conflicts: merged.conflicts,
  }
}

/**
 * The prototype's own static files, under the name they are referenced by.
 *
 * Pages address them with root-absolute paths (`/assets/app.css`), and inside an
 * extension page that path resolves to the *package* root — so copying the
 * directory unchanged is what makes the delivered page look like the previewed
 * one. Without it, a prototype that uses any stylesheet, script or image of its
 * own loses them the moment it is handed over, silently (plan §17).
 *
 * **Everything under `assets/` travels, bytes and all.** Which of those files a
 * page addresses is not answerable from the markup — a script builds the URL, a
 * stylesheet pulls in a font — so the directory goes whole rather than through a
 * list of extensions that would be wrong in both directions. Bytes and not text:
 * reading a png as utf-8 and writing it back is what corrupts it, so only this
 * module's own generated files are strings.
 */
function collectAssetFiles(workspaceRootPath: string, slug: string): ExtensionFile[] {
  const assetsDir = join(getPrototypeDirPath(workspaceRootPath, slug), 'assets')
  if (!existsSync(assetsDir)) return []

  const files: ExtensionFile[] = []

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
      files.push({ path: `assets/${relative}`, content: readFileSync(join(dir, entry.name)) })
    }
  }

  walk(assetsDir, '')
  return files
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
 * Write a deliverable folder from scratch.
 *
 * A re-export replaces the folder rather than merging into it: a stale file left
 * behind (a patch that was deleted, a page renamed) would still be loaded by
 * Chrome or still be opened by the recipient, so "the folder is exactly what this
 * prototype is right now" only holds if it is rebuilt.
 *
 * Text is written as utf-8; a buffer is written as it stands, which is the whole
 * reason the asset copy carries bytes rather than strings.
 */
function writeFileMap(dir: string, files: Array<{ path: string; content: string | Uint8Array }>): void {
  rmSync(dir, { recursive: true, force: true })
  for (const file of files) {
    const target = join(dir, file.path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, file.content)
  }
}

/**
 * Write the deliverables for a prototype.
 *
 * Two artifacts, and between them they cover the whole flow whatever it is made
 * of (plan §17/§19.5): pages of ours ship as documents under the names they have
 * on disk (a page left out would be a link that 404s, so "every page" is not a
 * nicety here — it is what makes the package a flow), and overlay pages are
 * injected into by a content script scoped to their address. The entry page is
 * named in the manifest, and the generated page index is the options page either
 * way.
 *
 * The second artifact is `dist/static/`: the same documents, each as one file that
 * carries its patches, its mock layer and its references, so the half of the flow
 * that is ours can be looked at with nothing installed and no host. Both are built
 * from one reading of the prototype — the same pages, the same patches, the same
 * mocks — so they cannot disagree about what a page is.
 *
 * The third is `dist/bookmarklet.html`: the *live* pages' changes in the one carrier
 * that needs neither an extension nor a host. Same patches, same mock layer, same
 * bundle the extension ships (see bookmarklet.ts) — what differs is only how the
 * code gets into the page, and what that costs.
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

  // Read once: both deliverables ship the mock layer, and a second reading is a
  // second chance for them to disagree about the contract.
  const mockCollection = collectMockRoutes(workspaceRootPath, slug)
  const mocks = mockCollection.program
  // One build time for everything this export writes, so "which build is this?" has
  // one answer rather than one per artifact.
  const builtAt = new Date()

  const pkg = buildExtensionPackage({
    slug,
    targets,
    documents,
    entryPage: entry?.name ?? null,
    indexDocument,
    patches,
    mocks,
    builtAt,
  })

  const extensionDir = join(getPrototypeDistPath(workspaceRootPath, slug), EXTENSION_DIRNAME)
  // The prototype's own static files go in with the package, under the same paths
  // the pages address them by — before the generated files, so a generated file
  // wins if a hand-written one ever collides with it.
  writeFileMap(extensionDir, [...collectAssetFiles(workspaceRootPath, slug), ...pkg.files])

  // The pages of ours, each as one file that needs nothing to be looked at. A
  // prototype of live pages only has none — those pages are not ours to freeze —
  // and then a folder left over from an earlier export is removed rather than kept
  // as a static page of a state this prototype is no longer in.
  const staticDir = join(getPrototypeDistPath(workspaceRootPath, slug), STATIC_DIRNAME)
  const staticPages = documents.length > 0
    ? buildStaticPages({ documents, patches, mocks, dir, entryPage: entry?.name ?? null })
    : null
  if (staticPages) writeFileMap(staticDir, staticPages.files)
  else rmSync(staticDir, { recursive: true, force: true })

  // The live pages' half, in the one carrier that needs nothing installed: what the
  // extension would inject, as a bookmark. Written only when a live page has
  // something to apply — a bookmark that does nothing looks like it worked — and a
  // file from an earlier export is removed when that stops being true.
  const bookmarkletFile = join(getPrototypeDistPath(workspaceRootPath, slug), BOOKMARKLET_FILENAME)
  const bookmarklet = buildBookmarkletDocument({ slug, pages: targets, patches, mocks, builtAt })
  if (bookmarklet.pages.length > 0) writeFileSync(bookmarkletFile, bookmarklet.html, 'utf-8')
  else rmSync(bookmarkletFile, { force: true })

  // What a recipient should open first: our entry page when there is one, and the
  // index (the options page) otherwise. An overlay's entry page is not ours to
  // open, so there is nothing to point at.
  const pagePath = entry
    ? entry.kind === 'scratch' && entry.file
      ? join(extensionDir, entry.file)
      : null
    : join(extensionDir, EXTENSION_INDEX_FILENAME)

  const specPath = join(getPrototypeDistPath(workspaceRootPath, slug), DEV_SPEC_FILENAME)
  writeFileSync(
    specPath,
    buildDevSpec(slug, {
      pages,
      patches,
      coverage: resolveRequirementCoverage(workspaceRootPath, slug),
      // The selector record travels into the spec: whether each `@target` still matches the page is
      // only knowable from an apply, and it is the first thing the reader has to know (plan §21.2).
      anchors: readAllPrototypeAnchors(workspaceRootPath, slug),
    }),
    'utf-8',
  )

  // Last, because it is the listing of what the run produced: the gate's verdict comes from the
  // status report the workbench itself shows, so a package cannot be handed over quietly while the
  // panel says something is still standing.
  const handoffPath = join(getPrototypeDistPath(workspaceRootPath, slug), HANDOFF_FILENAME)
  writeFileSync(
    handoffPath,
    buildHandoff({
      slug,
      version: pkg.version,
      builtAt,
      pages,
      patches,
      entry,
      files: listDistNames(getPrototypeDistPath(workspaceRootPath, slug)),
      // The gate is quoted in the words the agent uses: the handoff is a document
      // for whoever implements the change, and the panel's translation of these
      // lines belongs to the panel (`notices.ts`).
      blockers: buildPrototypeStatus(workspaceRootPath, slug).settleBlockers.map((blocker) => blocker.text),
    }),
    'utf-8',
  )

  return {
    slug,
    extensionDir,
    pagePath,
    pageUrl: pagePath ? prototypeDocumentUrl(workspaceRootPath, slug, pagePath) : null,
    version: pkg.version,
    specPath,
    handoffPath,
    staticDir: staticPages ? staticDir : null,
    // Built relative to `dist/static/` and made absolute here: the builder knows
    // the files, the caller knows where the folder is.
    staticPath: staticPages?.entryPath ? join(staticDir, staticPages.entryPath) : null,
    staticWarnings: staticPages?.warnings ?? [],
    bookmarkletPath: bookmarklet.pages.length > 0 ? bookmarkletFile : null,
    applied: patches.length,
    pageCount: pages.length,
    warnings: [
      ...pkg.warnings,
      ...dynamicEvaluationWarnings(documents, patches),
      // A state key two services both declare: the package still ships, but which
      // one a route reads is not something to leave to file order silently.
      ...mockCollection.conflicts.map((conflict) => `mock state: ${conflict} — the first one wins.`),
    ],
  }
}
