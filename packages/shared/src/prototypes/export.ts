/**
 * Prototype export.
 *
 * Turns a prototype into role-shaped deliverables under `dist/`:
 *  - an HTML artifact that shows the prototype to a human, whose shape depends
 *    on the kind — a from-scratch prototype's own page, or an overlay's preview
 *    carrier that applies the patches to the live page (bookmarklet.ts)
 *  - `dev-spec.md`    — the change list a developer reads
 *
 * The inlined patch order is the same derived order used for live replay, so the
 * deliverable and the workbench agree by construction.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { buildOverlayPreviewHtml } from './bookmarklet.ts'
import { getPrototypeConfigPath, readPrototypeConfig } from './config.ts'
import { buildPatchInitScript } from './patch-script.ts'
import { getPrototypeDistPath, getPrototypeDirPath, scanPrototypePatches } from './storage.ts'
import { prototypeDocumentUrl, prototypeOriginUrl } from './url.ts'
import type { PrototypePatch } from './types.ts'

const BASE_FILENAME = 'base.html'
const PROTOTYPE_FILENAME = 'prototype.html'
const OVERLAY_PREVIEW_FILENAME = 'overlay-preview.html'
const DEV_SPEC_FILENAME = 'dev-spec.md'

export interface PrototypeExportResult {
  slug: string
  /**
   * Absolute path to the HTML artifact, or null when there is none. What it is
   * depends on the kind: a from-scratch prototype exports its own page, an
   * overlay exports the carrier that puts its patches onto the live page (see
   * bookmarklet.ts).
   */
  htmlPath: string | null
  /** Address of the deliverable, or null when there is no HTML. */
  htmlUrl: string | null
  /** Absolute path to the change spec. */
  specPath: string
  /** Number of patches inlined. */
  applied: number
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
 *   JS patches twice. A plain base page carries no marker and is treated as
 *   untouched, which is what an overlay's target page is.
 */
export function buildSelfContainedHtml(baseHtml: string, patches: PrototypePatch[]): string {
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

  if (!styleBlock && !scriptBlock) return baseHtml

  let out = baseHtml

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

/** Human-readable change list for the developer receiving the prototype. */
export function buildDevSpec(
  slug: string,
  patches: PrototypePatch[],
  options: { targetUrl?: string } = {},
): string {
  const lines = [
    `# Prototype change spec — ${slug}`,
    '',
    // For an overlay this line carries what the HTML deliverable used to: the
    // changes belong to a page that lives elsewhere, and nothing else here says
    // which page that is.
    ...(options.targetUrl ? [`Applies to: ${options.targetUrl}`, ''] : []),
    `Derived from \`prototypes/${slug}/patches/\` — ${patches.length} patch${patches.length === 1 ? '' : 'es'} in replay order.`,
    'Each patch is an ordinary file; the listings below are exactly what the prototype applies.',
    '',
  ]

  if (patches.length === 0) {
    lines.push('_No patches._')
    return lines.join('\n')
  }

  lines.push('| # | File | Lane | Kind | Chars |', '| --- | --- | --- | --- | --- |')
  patches.forEach((patch, index) => {
    lines.push(`| ${index + 1} | \`${patch.file}\` | ${patch.lane ?? '—'} | ${patch.kind} | ${patch.source.length} |`)
  })
  lines.push('')

  patches.forEach((patch, index) => {
    const fence = fenceFor(patch.source)
    lines.push(
      `## ${index + 1}. \`${patch.file}\``,
      '',
      `${patch.kind === 'css' ? 'CSS' : 'JavaScript'} patch, lane ${patch.lane ?? '—'}, order ${patch.order}.`,
      '',
      fence + (patch.kind === 'css' ? 'css' : 'javascript'),
      patch.source,
      fence,
      '',
    )
  })

  return lines.join('\n')
}

/** Where a prototype's page is, and what showing it takes. */
export interface PrototypeEntry {
  /**
   * Absolute path to `base.html` for a from-scratch prototype; null for an
   * overlay, whose page is an address and never a file.
   */
  path: string | null
  /** The address to open. */
  url: string
  /**
   * Whether the patches have to be replayed into the page after it loads.
   *
   * True for an overlay: its page is the live one, which knows nothing about the
   * prototype until the patches land in it. False for a from-scratch prototype,
   * whose page is rendered by the host from `base.html` + `patches/` on every
   * request — it arrives with the patches already inlined.
   */
  injectPatches: boolean
}

/**
 * Resolve where a prototype is shown.
 *
 * The two kinds answer this differently, and the difference is the whole point of
 * having kinds:
 *
 * - **overlay** — the page is the **live address** it was created against. That
 *   page brings its own JavaScript, its own session and its own data; the
 *   prototype is that page with patches replayed into it. Nothing is copied: a
 *   frozen snapshot could not run the app's own JS and would carry no session,
 *   so it would only *look* like the page being worked on. A `base.html` lying
 *   around here (written by hand, or left by an older version) is not the page
 *   and is not used.
 * - **scratch** — the page is the host rendering `base.html` + `patches/`, since
 *   the document is ours and there is no address to point at.
 *
 * `injectPatches` is the one thing the caller has to act on: for an overlay, the
 * address is not yet "the prototype" until the replay happens.
 *
 * @throws when there is nothing to open: an overlay with no recorded target page,
 *   a from-scratch prototype with no document, or a host that serves neither.
 */
export function resolvePrototypeEntry(workspaceRootPath: string, slug: string): PrototypeEntry {
  const base = join(getPrototypeDirPath(workspaceRootPath, slug), BASE_FILENAME)
  const hasBase = existsSync(base)
  const config = readPrototypeConfig(workspaceRootPath, slug)

  if (config.kind === 'overlay') {
    if (config.targetUrl) {
      return { path: null, url: config.targetUrl, injectPatches: true }
    }
    throw new Error(
      `Prototype "${slug}" is an overlay with no target page recorded, so there is no live page to open. ` +
        `Set "targetUrl" in ${getPrototypeConfigPath(workspaceRootPath, slug)}, or make a new one against the address.`,
    )
  }

  if (!hasBase) {
    throw new Error(
      `Prototype "${slug}" has no ${BASE_FILENAME}, so there is nothing to render. ` +
        `Write ${base}, or start it from another prototype's page with "prototype-import --from <slug>".`,
    )
  }

  const origin = prototypeOriginUrl(workspaceRootPath, slug)
  if (!origin) {
    throw new Error(
      `No host is serving prototypes, so "${slug}" has no address that renders it with its patches ` +
        `applied — opening ${BASE_FILENAME} directly would show the page with none of them.`,
    )
  }

  return { path: base, url: origin, injectPatches: false }
}

/**
 * Write the deliverables for a prototype.
 *
 * What a deliverable *is* depends on the kind, which is the reason kinds exist:
 *
 * - **from-scratch** — the prototype is a document, so the deliverable is a
 *   document: one self-contained HTML with the patches inlined.
 * - **overlay** — the changes belong to a page that lives somewhere else, and
 *   freezing that page into HTML would hand over something that cannot run its
 *   own JS and carries none of the session it was written against: it *looks*
 *   like the page. So the HTML deliverable is the carrier that puts the patches
 *   onto the real page for a human (`overlay-preview.html`, see bookmarklet.ts),
 *   and the change spec names the address the changes belong to.
 *
 * @throws for a from-scratch prototype with no `base.html` (there is no document
 *   to hand over, and an empty one would be a lie), and for an overlay with no
 *   target page (the preview has no page to apply itself to, and no address to
 *   name).
 */
export function exportPrototype(workspaceRootPath: string, slug: string): PrototypeExportResult {
  const basePath = join(getPrototypeDirPath(workspaceRootPath, slug), BASE_FILENAME)
  const config = readPrototypeConfig(workspaceRootPath, slug)
  const patches = scanPrototypePatches(workspaceRootPath, slug)

  // Each kind validates the thing its own deliverable is built from, next to the
  // use — so neither precondition can be checked and then quietly forgotten.
  const htmlPath = join(
    getPrototypeDistPath(workspaceRootPath, slug),
    config.kind === 'overlay' ? OVERLAY_PREVIEW_FILENAME : PROTOTYPE_FILENAME,
  )
  let html: string
  if (config.kind === 'overlay') {
    const targetUrl = config.targetUrl
    if (!targetUrl) {
      throw new Error(
        `Prototype "${slug}" is an overlay with no target page recorded, so its preview would have no page to ` +
          `apply itself to. Set "targetUrl" in ${getPrototypeConfigPath(workspaceRootPath, slug)}.`,
      )
    }
    html = buildOverlayPreviewHtml(slug, targetUrl, patches)
  } else {
    if (!existsSync(basePath)) {
      throw new Error(`Prototype "${slug}" has no ${BASE_FILENAME}. Write ${basePath} first.`)
    }
    html = buildSelfContainedHtml(readFileSync(basePath, 'utf-8'), patches)
  }

  mkdirSync(getPrototypeDistPath(workspaceRootPath, slug), { recursive: true })
  writeFileSync(htmlPath, html, 'utf-8')

  const specPath = join(getPrototypeDistPath(workspaceRootPath, slug), DEV_SPEC_FILENAME)
  writeFileSync(specPath, buildDevSpec(slug, patches, { targetUrl: config.targetUrl }), 'utf-8')

  return {
    slug,
    htmlPath,
    htmlUrl: prototypeDocumentUrl(workspaceRootPath, slug, htmlPath),
    specPath,
    applied: patches.length,
  }
}
