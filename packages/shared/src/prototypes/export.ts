/**
 * Prototype export.
 *
 * Turns a prototype project into role-shaped deliverables under `dist/`:
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
import { getPrototypeDistPath, getPrototypeProjectPath, scanPrototypePatches } from './storage.ts'
import type { PrototypePatch } from './types.ts'

const BASE_FILENAME = 'base.html'
const PROTOTYPE_FILENAME = 'prototype.html'
const DEV_SPEC_FILENAME = 'dev-spec.md'

export interface PrototypeExportResult {
  slug: string
  /** Absolute path to the self-contained deliverable. */
  htmlPath: string
  /** `file://` URL for the deliverable — open it with `browser_tool navigate`. */
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

/** Which file `prototype-open` should show, and how to reach it. */
export interface PrototypeEntry {
  /** `export` = the self-contained deliverable, `base` = the work-in-progress page. */
  kind: 'export' | 'base'
  /** Absolute path of the file. */
  path: string
  /** `file://` URL, ready to hand to `navigate`. */
  url: string
}

/**
 * Resolve what to open for a prototype.
 *
 * Prefers the exported deliverable when it exists — that is the artifact the
 * user actually ships, so verifying it is the more meaningful default.
 *
 * @throws when neither file exists — opening a project with nothing in it would
 *   fail confusingly inside the browser instead of here.
 */
export function resolvePrototypeEntry(workspaceRootPath: string, slug: string): PrototypeEntry {
  const exported = join(getPrototypeDistPath(workspaceRootPath, slug), PROTOTYPE_FILENAME)
  if (existsSync(exported)) {
    return { kind: 'export', path: exported, url: pathToFileURL(exported).toString() }
  }

  const base = join(getPrototypeProjectPath(workspaceRootPath, slug), BASE_FILENAME)
  if (existsSync(base)) {
    return { kind: 'base', path: base, url: pathToFileURL(base).toString() }
  }

  throw new Error(
    `Prototype "${slug}" has neither ${PROTOTYPE_FILENAME} (run prototype-export) nor ${BASE_FILENAME}. ` +
    `Write ${base} first, or capture a real page as the base.`,
  )
}

/**
 * Write the deliverables for a prototype project.
 *
 * @throws when the project has no `base.html` — a prototype with nothing to
 *   apply patches to would otherwise export a meaningless file.
 */
export function exportPrototype(workspaceRootPath: string, slug: string): PrototypeExportResult {
  const projectDir = getPrototypeProjectPath(workspaceRootPath, slug)
  const basePath = join(projectDir, BASE_FILENAME)
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
    htmlUrl: pathToFileURL(htmlPath).toString(),
    specPath,
    applied: patches.length,
  }
}
