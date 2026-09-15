/**
 * Prototype export.
 *
 * Turns a prototype into role-shaped deliverables under `dist/`:
 *  - `prototype.html` — one self-contained file that runs standalone
 *  - `dev-spec.md`    — the change list a developer reads
 *
 * The inlined patch order is the same derived order used for live replay, so the
 * deliverable and the workbench agree by construction.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { buildPatchInitScript } from './patch-script.ts'
import { getPrototypeDistPath, getPrototypeDirPath, scanPrototypePatches } from './storage.ts'
import { prototypeDocumentUrl, prototypeOriginUrl } from './url.ts'
import type { PrototypePatch } from './types.ts'

const BASE_FILENAME = 'base.html'
const PROTOTYPE_FILENAME = 'prototype.html'
const DEV_SPEC_FILENAME = 'dev-spec.md'

export interface PrototypeExportResult {
  slug: string
  /** Absolute path to the self-contained deliverable. */
  htmlPath: string
  /**
   * Address of the deliverable — open it with `browser_tool navigate`. An HTTP
   * URL when the host serves prototypes (see url.ts), else `file://`.
   */
  htmlUrl: string
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
export function buildDevSpec(slug: string, patches: PrototypePatch[]): string {
  const lines = [
    `# Prototype change spec — ${slug}`,
    '',
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

/** Where a prototype's page is. */
export interface PrototypeEntry {
  /** Absolute path to the base page the address renders. */
  path: string
  /**
   * The prototype's **origin root**, always. That address is `base.html`
   * rendered with every patch, computed per request — the prototype as it stands
   * right now, and the same bytes an export would write this second.
   */
  url: string
}

/**
 * Resolve the address to open for a prototype.
 *
 * There is exactly one answer when there is an answer at all: the origin root,
 * which the host renders from `base.html` + `patches/` on every request.
 *
 * The rules this replaces all pointed somewhere that was not the prototype:
 * preferring a previous `dist/prototype.html` opened a document frozen at export
 * time, and a bare `base.html` opened one with none of the patches applied. The
 * exported deliverable is still reachable *by name* for anyone who wants to look
 * at it, but it is never what "open this prototype" means — opening it would
 * hand back a page you cannot go on editing.
 *
 * @throws when there is no base page to render, or when this host has no server
 *   to render it on — a `file://` page would be the raw base with none of the
 *   patches, which is worse than saying so.
 */
export function resolvePrototypeEntry(workspaceRootPath: string, slug: string): PrototypeEntry {
  const base = join(getPrototypeDirPath(workspaceRootPath, slug), BASE_FILENAME)
  if (!existsSync(base)) {
    throw new Error(
      `Prototype "${slug}" has no ${BASE_FILENAME}, so there is nothing to render. ` +
        `Write ${base}, capture a real page as the base, or import another prototype's page.`,
    )
  }

  const origin = prototypeOriginUrl(workspaceRootPath, slug)
  if (!origin) {
    throw new Error(
      `No host is serving prototypes, so "${slug}" has no address that renders it with its patches ` +
        `applied — opening ${BASE_FILENAME} directly would show the page with none of them.`,
    )
  }

  return { path: base, url: origin }
}

/**
 * Write the deliverables for a prototype.
 *
 * @throws when the prototype has no `base.html` — a prototype with nothing to
 *   apply patches to would otherwise export a meaningless file.
 */
export function exportPrototype(workspaceRootPath: string, slug: string): PrototypeExportResult {
  const prototypeDir = getPrototypeDirPath(workspaceRootPath, slug)
  const basePath = join(prototypeDir, BASE_FILENAME)
  if (!existsSync(basePath)) {
    throw new Error(`Prototype "${slug}" has no ${BASE_FILENAME}. Create ${basePath} first.`)
  }

  const baseHtml = readFileSync(basePath, 'utf-8')
  const patches = scanPrototypePatches(workspaceRootPath, slug)

  const distDir = getPrototypeDistPath(workspaceRootPath, slug)
  mkdirSync(distDir, { recursive: true })

  const htmlPath = join(distDir, PROTOTYPE_FILENAME)
  writeFileSync(htmlPath, buildSelfContainedHtml(baseHtml, patches), 'utf-8')

  const specPath = join(distDir, DEV_SPEC_FILENAME)
  writeFileSync(specPath, buildDevSpec(slug, patches), 'utf-8')

  return {
    slug,
    htmlPath,
    htmlUrl: prototypeDocumentUrl(workspaceRootPath, slug, htmlPath),
    specPath,
    applied: patches.length,
  }
}
