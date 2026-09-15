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
import { pathToFileURL } from 'url'
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

/** Insert `block` immediately before the last occurrence of `closingTag`. */
function insertBeforeClosingTag(html: string, block: string, closingTag: string): string | null {
  const index = html.toLowerCase().lastIndexOf(closingTag)
  if (index === -1) return null
  return `${html.slice(0, index)}${block}\n${html.slice(index)}`
}

/**
 * Inline every patch into a single self-contained HTML document.
 *
 * - css patches become one `<style>` block inside `<head>` (from a plain-text
 *   patch there is nothing to execute, so inlining the text is exactly
 *   equivalent to what the live injector does — and it survives with JS off).
 * - js patches are inlined through {@link buildPatchInitScript}, the same
 *   transform used for live replay, so behaviour cannot diverge.
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

/** Where a prototype's page is, and what that address actually serves. */
export interface PrototypeEntry {
  /**
   * `page` — `base.html` is the source, and the address renders it with every
   * patch applied. `export` — no base page is left, so the address serves the
   * frozen deliverable instead.
   */
  kind: 'page' | 'export'
  /** Absolute path of the file the page is built from. */
  path: string
  /**
   * Address to open. The prototype's **origin root** whenever a host serves
   * prototypes, because that address is `base.html` rendered with all patches —
   * the current state, and the same bytes an export would write right now.
   * Falls back to `file://` on a host that serves nothing.
   */
  url: string
}

/**
 * Whether this prototype has anything to show at all.
 *
 * The condition `resolvePrototypeEntry` is built on, exported so callers that
 * need to *offer* an action can ask it instead of restating the rule — a UI that
 * re-derives "base or export" drifts the moment the rule changes, and its failure
 * mode is a button that is silently wrong.
 */
export function hasPrototypePage(workspaceRootPath: string, slug: string): boolean {
  return (
    existsSync(join(getPrototypeDirPath(workspaceRootPath, slug), BASE_FILENAME)) ||
    existsSync(join(getPrototypeDistPath(workspaceRootPath, slug), PROTOTYPE_FILENAME))
  )
}

/**
 * Resolve the prototype's page.
 *
 * Deliberately **not** "which file wins": the address is the prototype's origin,
 * and the server renders it from `base.html` + `patches/` on every request. That
 * removes the whole class of staleness the old rule had — preferring a previously
 * exported `dist/prototype.html` would show a document frozen at export time, and
 * falling back to a bare `base.html` would show one with no patches applied at
 * all, neither of which is the prototype.
 *
 * `kind` only describes what the address has to fall back to, and `path` names
 * the file behind it.
 *
 * @throws when there is nothing to show at all, naming both ways to get one.
 */
export function resolvePrototypeEntry(workspaceRootPath: string, slug: string): PrototypeEntry {
  const base = join(getPrototypeDirPath(workspaceRootPath, slug), BASE_FILENAME)
  const exported = join(getPrototypeDistPath(workspaceRootPath, slug), PROTOTYPE_FILENAME)
  const origin = prototypeOriginUrl(workspaceRootPath, slug)

  // With an origin, the rendered page is always the answer; the file choice only
  // matters when there is no base page to render (deleted source, kept export).
  if (origin && existsSync(base)) {
    return { kind: 'page', path: base, url: origin }
  }
  if (origin && existsSync(exported)) {
    return { kind: 'export', path: exported, url: prototypeDocumentUrl(workspaceRootPath, slug, exported) }
  }

  // No host server: the fully-applied document exists only as the exported file,
  // so it is the better fallback even though it may be stale.
  if (existsSync(exported)) {
    return { kind: 'export', path: exported, url: pathToFileURL(exported).toString() }
  }
  if (existsSync(base)) {
    return { kind: 'page', path: base, url: pathToFileURL(base).toString() }
  }

  throw new Error(
    `Prototype "${slug}" has neither ${BASE_FILENAME} nor ${PROTOTYPE_FILENAME} (run prototype-export). ` +
    `Write ${base} first, or capture a real page as the base.`,
  )
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
