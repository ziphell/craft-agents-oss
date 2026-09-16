/**
 * prototype-commit — folding the delta layer back into the artifact that owns it.
 *
 * Every prototype is a two-layer thing, the way a qcow2 image is: a **base** that
 * is not ours to write, and a layer of deltas we own. What the workbench has been
 * missing is the operation that collapses the layer — so the deltas only ever
 * accumulate, nobody ever sees the prototype as one artifact, and a person who
 * wants to change something has to edit the middle of a chain.
 *
 * Whether the collapse is possible is decided by **whose the base is**, and that
 * is exactly the difference between the two kinds of page:
 *
 * | | base | can it be committed? |
 * | --- | --- | --- |
 * | a page of ours (`scratch`) | `cart.html`, under `assets/` | **yes** — the deltas belong *in* the document |
 * | a live page (`overlay`) | someone else's address | **no** — the page is not a file we can rewrite |
 *
 * So a commit produces two shapes, and both end with the delta layer gone:
 *
 * - **scratch**: css is folded into the page's own stylesheet
 *   (`assets/<page>/committed.css`, linked from the document) and js is
 *   **promoted** into `assets/<page>/committed.js` plus a `<script src>`. That is
 *   the honest form of "the change is now the source": a runtime patch cannot be
 *   folded into a document at all — doing that means rendering the page and
 *   serializing the result, which is the deleted "freeze the live page into
 *   `base.html`" idea, and it costs the readable document.
 * - **overlay**: css and js are folded into the page's consolidated patch
 *   (`patches/<page>/Z-001-upper.css` / `Z-002-upper.js`). The base stays
 *   someone else's forever, so the upper layer is the most this can be folded
 *   into — one file we own, replaying last by rule (`byReplayOrder`), which is
 *   what makes a live page's prototype a thing that converges instead of a chain
 *   that grows.
 *
 * Three rules keep the fold honest:
 *
 * 1. **Provenance is written into the file.** Each folded patch leaves a header
 *    naming where it came from, when, and — because a consolidated file is now
 *    the only declaration of them — its `@target` and `@requirement` markers. The
 *    markers are last on their line so the selector reads cleanly; without them
 *    every anchor recorded for the folded patches would look orphaned the moment
 *    they were folded.
 * 2. **Nothing is deleted that was not written.** The folded patches are removed
 *    only after the file that now carries them is on disk.
 * 3. **What could not be checked is said out loud.** A folded patch with no
 *    `@target` cannot be verified against the page; it is reported, not guessed
 *    about. Nothing is refused for being unverifiable — a fold is textual and
 *    safe — but the reader is told which part of it nobody checked.
 *
 * There is no automatic commit: collapsing a layer is irreversible in the same
 * way `qemu-img commit` is, and the user's own git is the place where the before
 * and after survive. It is a deliberate action, taken when the work has stopped
 * moving.
 *
 * @see docs/prototype-workbench-plan.md §21.3
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { dropPrototypeAnchors } from './anchors.ts'
import { extractRequirementIds } from './patch-header.ts'
import { listPrototypePages, type PrototypePage } from './pages.ts'
import { getPrototypeDirPath, scanPrototypePatches } from './storage.ts'
import { CONSOLIDATED_LANE, type PageKind, type PrototypePatch } from './types.ts'

/** What a commit did to one scope — the shared patches, or one page's own. */
export interface PrototypeCommitScopeResult {
  /** The page name, or null for the shared scope (`patches/*`). */
  page: string | null
  kind: PageKind | 'shared'
  /** Files written by the fold, relative to the prototype directory. */
  wrote: string[]
  /** Patches whose source was folded into a file of ours. */
  folded: string[]
  /** js patches promoted into an asset of ours and referenced by the document. */
  promoted: string[]
  /** Patch files removed because their content lives on in what was written. */
  deleted: string[]
  /** Folded css patches with no `@target`, so nothing could check what they match. */
  unverified: string[]
  /** Patches left alone, each with the reason a commit could not take it. */
  refused: Array<{ file: string; reason: string }>
}

export interface PrototypeCommitResult {
  slug: string
  scopes: PrototypeCommitScopeResult[]
  /** True when there was nothing left to fold — the honest answer for a second commit. */
  nothingToCommit: boolean
}

/** `prototypes/<slug>/assets/<page>/committed.css` — the stylesheet a page of ours owns. */
const COMMITTED_CSS = 'committed.css'
/** `prototypes/<slug>/assets/<page>/committed.js` — where a promoted js patch lands. */
const COMMITTED_JS = 'committed.js'

/** The consolidated patch files, per kind. `Z` sorts last; the numbers are readable order. */
function upperFileName(kind: 'css' | 'js'): string {
  return kind === 'css' ? `${CONSOLIDATED_LANE}-001-upper.css` : `${CONSOLIDATED_LANE}-002-upper.js`
}

/** `insertBeforeClosingTag`, for the two tags a fold has to add. */
function insertBeforeClosingTag(html: string, block: string, closingTag: string): string | null {
  const index = html.toLowerCase().lastIndexOf(closingTag.toLowerCase())
  if (index === -1) return null
  return `${html.slice(0, index)}${block}\n${html.slice(index)}`
}

/**
 * The provenance a folded patch leaves behind.
 *
 * One marker **per line**, because the parser reads everything after a marker to
 * the end of that line: two markers on one line would make the first one's value
 * `".pay-btn @target .card"`. That is also why the explanatory note, when there is
 * one, comes last.
 */
function provenanceLines(patch: PrototypePatch, kind: 'css' | 'js', now: string): string[] {
  const head = `patches/${patch.file} — committed ${now.slice(0, 10)}`
  const requirements = extractRequirementIds(patch.source)
  // Requirements first, then one target per line: the parser reads the rest of a
  // marker's line as its value, so two markers on one line would make the first
  // one's value swallow the second.
  const markers = [
    ...(requirements.length > 0 ? [`@requirement ${requirements.join(' ')}`] : []),
    ...patch.targets.map((target) => `@target ${target}`),
  ]
  if (kind === 'js') {
    return [`// ${head}`, ...markers.map((marker) => `// ${marker}`)]
  }
  return [
    `/* ${head}`,
    ...markers.map((marker) => `   ${marker}`),
    '   (the markers above are read by the workbench — keep them) */',
  ]
}

/** One patch's contribution to a consolidated file. */
function foldedBlock(patch: PrototypePatch, kind: 'css' | 'js', now: string): string {
  return [...provenanceLines(patch, kind, now), patch.source.trimEnd(), ''].join('\n')
}

function readIfPresent(path: string): string {
  if (!existsSync(path)) return ''
  try {
    return readFileSync(path, 'utf-8')
  } catch {
    return ''
  }
}

function writeFileEnsuringDir(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf-8')
}

/**
 * A banner so a consolidated file explains itself to whoever opens it next.
 *
 * Written without naming a marker literally: anything after a marker on a line is
 * read as that marker's value, so prose *about* a marker would be parsed as one.
 * (A test caught exactly that here — the banner said "its @target markers" and the
 * folded file ended up declaring a selector called "markers, which the workbench
 * reads".)
 */
function banner(target: string, kind: 'css' | 'js'): string {
  const lines = [
    `Consolidated by prototype-commit — the patches below were folded into ${target}.`,
    `Each keeps its own provenance header, and the markers that header carries are read by the workbench.`,
    `Nothing folded in here is duplicated: the patch files this replaced were removed.`,
  ]
  return kind === 'js' ? `${lines.map((line) => `// ${line}`).join('\n')}\n\n` : `/*\n${lines.map((line) => `   ${line}`).join('\n')}\n*/\n\n`
}

/** One page's own scope: folder for its deltas, and the page it belongs to. */
interface Scope {
  page: PrototypePage | null
  patches: PrototypePatch[]
}

/**
 * Fold a prototype's delta layer into the artifacts that own it.
 *
 * With `page`, only that page's own patches are folded: the shared ones stay
 * shared (folding them into one page would change what they apply to, which is a
 * different edit from collapsing a layer). Without it, the shared patches fold
 * into their own upper layer and every page's own patches fold in their page.
 */
export function commitPrototype(
  workspaceRootPath: string,
  slug: string,
  options: { page?: string; now?: Date } = {},
): PrototypeCommitResult {
  const now = (options.now ?? new Date()).toISOString()
  const dir = getPrototypeDirPath(workspaceRootPath, slug)
  const pages = listPrototypePages(workspaceRootPath, slug)
  // The consolidated files are the *target* of a commit, never its input: a
  // second commit folds into them rather than folding them into themselves.
  const patches = scanPrototypePatches(workspaceRootPath, slug).filter(
    (patch) => patch.lane?.toUpperCase() !== CONSOLIDATED_LANE,
  )

  const scopes: Scope[] = []
  if (options.page) {
    const page = pages.find((candidate) => candidate.name === options.page)
    if (!page) {
      throw new Error(
        `No page "${options.page}" in prototype "${slug}". Pages: ${pages.map((p) => p.name).join(', ') || '(none)'}`,
      )
    }
    scopes.push({ page, patches: patches.filter((patch) => patch.page === page.name) })
  } else {
    const shared = patches.filter((patch) => patch.page === null)
    if (shared.length > 0) scopes.push({ page: null, patches: shared })
    for (const page of pages) {
      const own = patches.filter((patch) => patch.page === page.name)
      if (own.length > 0) scopes.push({ page, patches: own })
    }
  }

  const results = scopes.map((scope) => commitScope(workspaceRootPath, slug, scope, now))
  return {
    slug,
    scopes: results,
    nothingToCommit: results.every(
      (scope) => scope.folded.length === 0 && scope.promoted.length === 0 && scope.refused.length === 0,
    ),
  }
}

/** Every selector the patches of one scope declare — what a scratch fold makes moot. */
function foldedTargets(patches: PrototypePatch[]): string[] {
  return [...new Set(patches.flatMap((patch) => patch.targets))]
}

/** Fold one scope, writing what it can and reporting what it cannot. */
function commitScope(
  workspaceRootPath: string,
  slug: string,
  scope: Scope,
  now: string,
): PrototypeCommitScopeResult {
  const dir = getPrototypeDirPath(workspaceRootPath, slug)
  const page = scope.page
  const css = scope.patches.filter((patch) => patch.kind === 'css')
  const js = scope.patches.filter((patch) => patch.kind === 'js')

  // Scratch pages own a document, so the deltas belong in the document's own
  // assets. A shared scope has no document (it applies to every page, including
  // live ones), so it folds into patch files like an overlay page does.
  const asAssets = page !== null && page.kind === 'scratch'
  const base = asAssets ? `assets/${page.name}` : page ? `patches/${page.name}` : 'patches'

  const result: PrototypeCommitScopeResult = {
    page: page?.name ?? null,
    kind: page?.kind ?? 'shared',
    wrote: [],
    folded: [],
    promoted: [],
    deleted: [],
    unverified: [],
    refused: [],
  }

  // A page of ours whose document is gone has nothing to fold into: the fold is
  // the document, so its absence is a refusal rather than an empty success.
  const documentPath = asAssets && page?.file ? join(dir, page.file) : null
  if (asAssets && (!documentPath || !existsSync(documentPath))) {
    const reason = 'the page document is missing, so there is nothing to fold into it'
    result.refused.push(...scope.patches.map((patch) => ({ file: patch.file, reason })))
    return result
  }

  let document = documentPath ? readIfPresent(documentPath) : null

  if (css.length > 0) {
    const cssTarget = `${base}/${asAssets ? COMMITTED_CSS : upperFileName('css')}`
    const existing = readIfPresent(join(dir, cssTarget))
    const body = css.map((patch) => foldedBlock(patch, 'css', now)).join('\n')
    writeFileEnsuringDir(
      join(dir, cssTarget),
      existing.length > 0 ? `${existing.trimEnd()}\n\n${body}` : `${banner(cssTarget, 'css')}${body}`,
    )

    result.wrote.push(cssTarget)
    result.folded.push(...css.map((patch) => patch.file))
    result.unverified.push(...css.filter((patch) => patch.targets.length === 0).map((patch) => patch.file))
    result.deleted.push(...css.map((patch) => patch.file))

    if (asAssets && document !== null && page) {
      const href = `/assets/${page.name}/${COMMITTED_CSS}`
      if (!document.includes(href)) {
        const tag = `<link rel="stylesheet" href="${href}">`
        document =
          insertBeforeClosingTag(document, tag, '</head>') ??
          insertBeforeClosingTag(document, tag, '</body>') ??
          `${document}\n${tag}`
      }
    }
  }

  if (js.length > 0) {
    // Promoted, never folded: a js patch is behaviour, and behaviour cannot be
    // folded into a static document without rendering the page and serializing
    // the result (which is the deleted "freeze the page" idea). Moving it into an
    // asset of ours is the same collapse — it stops being a delta and becomes the
    // source — and it keeps the document readable.
    const promotedTarget = `${base}/${asAssets ? COMMITTED_JS : upperFileName('js')}`
    const existing = readIfPresent(join(dir, promotedTarget))
    const body = js.map((patch) => foldedBlock(patch, 'js', now)).join('\n')
    writeFileEnsuringDir(
      join(dir, promotedTarget),
      existing.length > 0 ? `${existing.trimEnd()}\n\n${body}` : `${banner(promotedTarget, 'js')}${body}`,
    )

    result.wrote.push(promotedTarget)
    result.promoted.push(...js.map((patch) => patch.file))
    // No `unverified` for js: a stylesheet is checked by counting what its
    // selector matched, and a script has no equivalent — its own report is
    // whether it threw, which the replay already says. Listing every js patch
    // here would be noise dressed as diligence.
    result.deleted.push(...js.map((patch) => patch.file))

    if (asAssets && document !== null && page) {
      const src = `/assets/${page.name}/${COMMITTED_JS}`
      if (!document.includes(src)) {
        const tag = `<script src="${src}"></script>`
        document =
          insertBeforeClosingTag(document, tag, '</body>') ??
          insertBeforeClosingTag(document, tag, '</html>') ??
          `${document}\n${tag}`
      }
    }
  }

  // The document is written before anything is deleted: a fold that wrote the
  // asset but lost its reference would leave a page that is silently wrong.
  if (documentPath && document !== null && document !== readIfPresent(documentPath)) {
    writeFileEnsuringDir(documentPath, document)
  }

  for (const file of result.deleted) {
    rmSync(join(dir, 'patches', file), { force: true })
  }

  // A page of ours is now where its targets live, so their anchors have nothing
  // left to drift against — see `dropPrototypeAnchors`. A live page keeps them:
  // the page is still someone else's, which is when drift checking earns its keep.
  if (asAssets) {
    dropPrototypeAnchors(workspaceRootPath, slug, page!.name, foldedTargets(scope.patches))
  }

  return result
}
