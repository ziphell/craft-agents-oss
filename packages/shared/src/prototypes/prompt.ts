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
import { readPrototypeConfig, type PrototypeKind } from './config.ts'

export interface PrototypePromptContext {
  slug: string
  /** `overlay` (patches on someone else's page) or `scratch` (our own page). */
  kind: PrototypeKind
  /** `overlay` only: the page this prototype injects into. */
  targetUrl?: string
  /**
   * Prototypes this one is being built with reference to (plan §14), resolved so
   * the agent knows each one's kind without having to read its config.
   */
  references: Array<{ slug: string; kind: PrototypeKind; targetUrl?: string }>
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
    kind: status.kind,
    ...(status.targetUrl ? { targetUrl: status.targetUrl } : {}),
    references: status.references.map((referenceSlug) => {
      const config = readPrototypeConfig(workspaceRootPath, referenceSlug)
      return {
        slug: referenceSlug,
        kind: config.kind,
        ...(config.targetUrl ? { targetUrl: config.targetUrl } : {}),
      }
    }),
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

  // Kind first: it decides where base.html comes from, what the deliverable is,
  // and whether there is an external page to keep in sync. Getting this wrong
  // makes every later instruction wrong too.
  if (ctx.kind === 'overlay') {
    lines.push(`This is an **overlay** prototype: the patches are injected on top of a page that belongs`)
    lines.push(`to someone else. They never flow back into that page's source — the deliverable is a spec a`)
    lines.push(`developer translates, not a patch anyone applies.`)
    if (ctx.targetUrl) {
      lines.push(`Target page: ${sanitize(ctx.targetUrl)}`)
    } else {
      lines.push(`No target page is recorded yet. If the user wants one remembered, it can be set when creating`)
      lines.push(`the prototype; there is no command to change it afterwards (the kind and target are fixed).`)
    }
    lines.push(`This is why base.html is a *snapshot*: it is the rendered DOM at capture time, and it goes stale`)
    lines.push(`when the other side ships a change. Re-capture rather than patching a stale base.`)
  } else {
    lines.push(`This is a **from-scratch** prototype: base.html is ours. It may have been written by hand or`)
    lines.push(`seeded by capturing a page that was studied first — either way the whole document is editable`)
    lines.push(`and there is nothing to keep in sync. Never re-capture over an existing base.html: that would`)
    lines.push(`discard edits without warning. Write it directly when it does not exist.`)
  }
  lines.push('')

  // References come right after the kind: they change how the agent should read
  // everything below (patches here are the deliverable; patches over there are
  // notes), so they cannot be deferred to a footnote.
  //
  // The rule is deliberately stated once, without regard to what kind either side
  // is: a reference is a relation between two independent projects, and a scratch
  // referencing another scratch works exactly like one referencing an overlay.
  if (ctx.references.length > 0) {
    lines.push(`This prototype is being built with reference to other prototypes:`)
    for (const reference of ctx.references) {
      const target = reference.targetUrl ? ` — ${sanitize(reference.targetUrl)}` : ''
      lines.push(`- ${sanitize(reference.slug)} (${reference.kind}${target}) at prototypes/${sanitize(reference.slug)}/`)
    }
    lines.push(`A reference is **evidence, not material**, whatever kind it is. Its patches were written`)
    lines.push(`against a different document: Do NOT copy a reference's patch files into this prototype's`)
    lines.push(`patches/ — their selectors would not match here, and they would ship inside the deliverable`)
    lines.push(`without erroring. Translate the intent into this prototype's own markup, and say in the`)
    lines.push(`conversation what you took from the reference.`)
    lines.push('')
  }

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
    lines.push(`Base page: none yet. Patches have nothing to apply to until one exists.`)
    lines.push(`Preferred: have the user open the product in a browser window (any address — a dev server,`)
    lines.push(`a test environment, or production) and press "Capture base". That stores the *rendered* DOM,`)
    lines.push(`which is what makes it usable as a base. To build a page from scratch, write base.html yourself.`)
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
