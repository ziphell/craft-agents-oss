/**
 * Prototype prompt context — what the agent is told about the prototype its
 * session is bound to.
 *
 * This is the reason a bound conversation needs no slugs: the block below is
 * injected into the system prompt, so the agent knows which prototype it is
 * working on, what state its base page is in, which patches exist, and how far
 * the service contract reaches — before the user says anything.
 *
 * Kept out of `status.ts` because this is a *presentation* concern: the same
 * facts are rendered differently for the panel (tables) and for the model
 * (prose + explicit instructions).
 *
 * @see docs/prototype-workbench-plan.md §3.1 (数据面 / 控制面分离)
 */

import { existsSync } from 'fs'
import { buildPrototypeStatus } from './status.ts'
import { getPrototypeProjectPath } from './storage.ts'
import { PROTOTYPE_LANES } from './ownership.ts'

export interface PrototypePromptContext {
  slug: string
  /** Absolute project directory (patches/ and base.html live here). */
  dir: string
  /** Absolute path to base.html, or null when the project has none yet. */
  baseHtmlPath: string | null
  /** Replayable patches, in replay order. Misnamed files are excluded. */
  patches: Array<{ file: string; lane: string | null; kind: string }>
  /** Per-service contract coverage. */
  services: Array<{
    slug: string
    endpoints: number
    mockedEndpoints: number
    missingFixtures: string[]
  }>
  /** File names already written to dist/. */
  distFiles: string[]
  /** Ownership violations — files that exist but will not be replayed. */
  violations: Array<{ path: string; reason: string }>
}

/**
 * Build the snapshot for a bound prototype.
 *
 * Returns null when the project does not exist (deleted while the session kept
 * its binding), so a stale binding degrades to an unbound conversation instead
 * of failing the turn.
 */
export function buildPrototypePromptContext(
  workspaceRootPath: string,
  slug: string,
): PrototypePromptContext | null {
  // Checked before the status read rather than after: `buildPrototypeStatus`
  // reports a missing project as an empty one, so existence is not inferable
  // from its output.
  if (!existsSync(getPrototypeProjectPath(workspaceRootPath, slug))) return null

  const status = buildPrototypeStatus(workspaceRootPath, slug)

  return {
    slug: status.slug,
    dir: status.dir,
    baseHtmlPath: status.baseHtmlPath,
    patches: status.patches.files.map((absolute) => {
      const file = absolute.slice(Math.max(absolute.lastIndexOf('/'), absolute.lastIndexOf('\\')) + 1)
      // Same convention as PATCH_NAME_RE in storage.ts — that regex is what
      // decided this file is replayable in the first place.
      const match = /^([A-Za-z])-\d+-.+\.(css|js)$/.exec(file)
      return { file, lane: match?.[1] ?? null, kind: match?.[2] ?? '' }
    }),
    services: status.services.map((service) => ({
      slug: service.slug,
      endpoints: service.endpoints,
      mockedEndpoints: service.mockedEndpoints,
      missingFixtures: service.missingFixtures,
    })),
    distFiles: status.distFiles,
    violations: status.ownership.violations,
  }
}

/** Escape the attribute-safe characters of a value placed inside a quoted attr. */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Strip control characters so injected values cannot break block parsing. */
function sanitize(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x1f\x7f]/g, '')
}

/**
 * Render the prototype block for the system prompt.
 *
 * The closing tag is written imperatively (not interpolated) and all injected
 * values are sanitized, so a file named `<prototype_context>` cannot terminate
 * the block early and smuggle instructions outside it.
 */
export function formatPrototypeContextForPrompt(ctx: PrototypePromptContext): string {
  const lines: string[] = []
  lines.push('')
  lines.push(`<prototype_context slug="${escapeAttr(ctx.slug)}">`)
  lines.push(sanitize(ctx.dir))
  lines.push('')

  lines.push(`This session is bound to the prototype above. Commands below target it by default —`)
  lines.push(`you do not need to pass a slug, though you may pass one to work on a different prototype.`)
  lines.push('')
  lines.push(`The state below is a snapshot taken when this session started, kept stable so the prompt`)
  lines.push(`stays cacheable. Run 'prototype-status' before relying on it for anything you have changed.`)
  lines.push('')

  // Base page first: without it nothing can be replayed, and the agent must not
  // write patches into a project that has no page to apply them to.
  if (ctx.baseHtmlPath) {
    lines.push(`Base page: ${sanitize(ctx.baseHtmlPath)}`)
  } else {
    lines.push(`Base page: MISSING. There is no base.html, so patches have nothing to apply to.`)
    lines.push(`Either write the starter markup with the Write tool, or tell the user to open the real`)
    lines.push(`product in a browser window and use "Capture base" to capture the rendered page.`)
  }
  lines.push('')

  lines.push(`Patches are plain files under patches/, named {lane}-{nnn}-{name}.{css|js}.`)
  lines.push(`The name is the ownership contract, not a convention — a file that does not match it is`)
  lines.push(`ignored by the injector. Lanes: ${Object.entries(PROTOTYPE_LANES).map(([id, desc]) => `${id} = ${desc}`).join('; ')}.`)
  lines.push(`To add a UI change, write a new file (e.g. patches/A-002-highlight.css) with the Write tool —`)
  lines.push(`do not edit base.html for presentation work, and do not rewrite an existing patch file owned`)
  lines.push(`by another lane. Every patch is replayed on reload, so the page state is reproducible.`)
  lines.push('')

  if (ctx.patches.length > 0) {
    lines.push(`Replayed patches, in order:`)
    for (const patch of ctx.patches) {
      lines.push(`- ${sanitize(patch.file)} (lane ${patch.lane ?? '?'}, ${patch.kind})`)
    }
  } else {
    lines.push(`Replayed patches: none yet.`)
  }
  lines.push('')

  if (ctx.services.length > 0) {
    lines.push(`Service contracts:`)
    for (const service of ctx.services) {
      const missing = service.missingFixtures.length > 0
        ? ` — MISSING FIXTURES: ${service.missingFixtures.map(sanitize).join(', ')}`
        : ''
      lines.push(`- ${sanitize(service.slug)}: ${service.mockedEndpoints}/${service.endpoints} endpoints mocked${missing}`)
    }
    lines.push('')
  }

  if (ctx.violations.length > 0) {
    lines.push(`Ownership violations (these files exist but are NOT replayed — fix or remove them):`)
    for (const violation of ctx.violations) {
      lines.push(`- ${sanitize(violation.path)}: ${sanitize(violation.reason)}`)
    }
    lines.push('')
  }

  lines.push(`Deliverables: ${ctx.distFiles.length > 0 ? ctx.distFiles.map(sanitize).join(', ') : 'none exported yet'}.`)
  lines.push('')
  lines.push(`Workflow: edit the files above, then 'prototype-apply' to see the result in the bound browser`)
  lines.push(`window, and 'prototype-export' to write the deliverable for developers. 'prototype-status'`)
  lines.push(`re-reads everything from disk when you need to confirm what is actually there.`)
  lines.push(`</prototype_context>`)
  lines.push('')
  return lines.join('\n')
}
