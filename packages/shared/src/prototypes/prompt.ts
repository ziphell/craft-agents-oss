/**
 * Prototype prompt context — what the agent is told about the prototype its
 * session is bound to.
 *
 * This is the reason a bound conversation needs no slugs: the block below is
 * injected into the system prompt, so the agent knows which prototype it is
 * working on, what its pages are and which kind each one is, which patches exist
 * and what they apply to, and how far the service contract reaches — before the
 * user says anything.
 *
 * Kept out of `status.ts` because this is a *presentation* concern: the same
 * facts are rendered differently for the panel (tables) and for the model
 * (prose + explicit instructions).
 *
 * @see docs/prototype-workbench-plan.md §3.1 (数据面 / 控制面分离), §19 (页层模型)
 */

import { existsSync } from 'fs'
import { getPrototypeDirPath, getPrototypeLayoutPath } from './storage.ts'
import { listPrototypePages } from './pages.ts'
import { buildPrototypeStatus } from './status.ts'
import { PROTOTYPE_LANES } from './ownership.ts'
import { PROTOTYPE_LAYOUT_SLOT, type PageKind } from './types.ts'

export interface PrototypePromptContext {
  slug: string
  /** Absolute path to the prototype's directory (its documents and patches/ live here). */
  dir: string
  /**
   * The flow's pages, in order (plan §19): every document of ours plus every
   * recorded live address, each with the kind that decides how it is changed.
   * Which page a *window* is on is a different, later question — `snapshot`
   * answers that.
   */
  pages: Array<{ name: string; kind: PageKind; url: string | null; file: string | null; entry: boolean }>
  /** The page `/` opens, or null when the root shows the generated page index (plan §19.3). */
  entryPage: string | null
  /**
   * Absolute path to the shared shell (`_layout.html`) every page of ours renders
   * inside, or null when the prototype has none. Reported so the agent reuses the
   * frame instead of inventing one per screen (plan §19.2).
   */
  layoutPath: string | null
  /**
   * Prototypes this one is being built with reference to (plan §14), each with a
   * one-line summary of what it is made of — enough to know what looking at it
   * means, without reading its config.
   */
  references: Array<{ slug: string; summary: string }>
  /**
   * The workspace project this prototype belongs to, or null (plan §15.1).
   *
   * Carried because a session can have **both** containers in front of it, and
   * nothing else in the prompt says which side a new file belongs on.
   */
  projectSlug: string | null
  /**
   * The PRD's requirements with what refers to each one (plan §20.1). Empty when
   * there is no `prd.md` — a state the prompt has to name out loud, because the
   * agent is the only writer of that file.
   */
  requirements: Array<{ id: string; title: string; pages: string[]; patches: string[]; findings: string[] }>
  /**
   * Findings already recorded under `research/` (plan §20.2). Carried so the agent
   * reads what it learned last time instead of studying the same product again.
   */
  findings: Array<{ id: string; claim: string | null; source: string | null; file: string }>
  /** Replayable patches, in replay order, each with the page it belongs to (null = every page). */
  patches: Array<{ file: string; lane: string | null; kind: string; page: string | null; targets: string[] }>
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

/** One line saying what a referenced prototype is made of. */
function describeReference(workspaceRootPath: string, slug: string): { slug: string; summary: string } {
  const pages = listPrototypePages(workspaceRootPath, slug)
  if (pages.length === 0) return { slug, summary: 'no pages yet' }

  const ours = pages.filter((page) => page.kind === 'scratch').length
  const live = pages.filter((page) => page.kind === 'overlay').length
  const parts = [
    ours > 0 ? `${ours} of ours` : '',
    live > 0 ? `${live} on a live site` : '',
  ].filter(Boolean)

  return { slug, summary: `${pages.length} page${pages.length === 1 ? '' : 's'} (${parts.join(', ')})` }
}

/**
 * Build the snapshot for a bound prototype.
 *
 * Returns null when the prototype does not exist (deleted while the session kept
 * its binding), so a stale binding degrades to an unbound conversation instead
 * of failing the turn.
 */
export function buildPrototypePromptContext(
  workspaceRootPath: string,
  slug: string,
): PrototypePromptContext | null {
  // Checked before the status read rather than after: `buildPrototypeStatus`
  // reports a missing prototype as an empty one, so existence is not inferable
  // from its output.
  if (!existsSync(getPrototypeDirPath(workspaceRootPath, slug))) return null

  const status = buildPrototypeStatus(workspaceRootPath, slug)

  return {
    slug: status.slug,
    dir: status.dir,
    pages: status.pages.map((page) => ({
      name: page.name,
      kind: page.kind,
      url: page.url,
      file: page.file,
      entry: page.entry,
    })),
    entryPage: status.entryPage,
    layoutPath: existsSync(getPrototypeLayoutPath(workspaceRootPath, slug))
      ? getPrototypeLayoutPath(workspaceRootPath, slug)
      : null,
    references: status.references.map((referenceSlug) => describeReference(workspaceRootPath, referenceSlug)),
    projectSlug: status.projectSlug,
    patches: status.patches.entries.map((entry) => ({
      file: entry.file,
      lane: entry.lane,
      kind: entry.kind,
      page: entry.page,
      targets: entry.targets,
    })),
    services: status.services.map((service) => ({
      slug: service.slug,
      endpoints: service.endpoints,
      mockedEndpoints: service.mockedEndpoints,
      missingFixtures: service.missingFixtures,
    })),
    requirements: status.requirements.map((requirement) => ({
      id: requirement.id,
      title: requirement.title,
      pages: requirement.pages,
      patches: requirement.patches,
      findings: requirement.findings,
    })),
    findings: status.findings.map((finding) => ({
      id: finding.id,
      claim: finding.claim,
      source: finding.source,
      file: finding.file,
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
  const overlayPages = ctx.pages.filter((page) => page.kind === 'overlay')
  const scratchPages = ctx.pages.filter((page) => page.kind === 'scratch')

  lines.push('')
  lines.push(`<prototype_context slug="${escapeAttr(ctx.slug)}">`)
  lines.push(sanitize(ctx.dir))
  lines.push('')

  // The model comes first because everything below depends on it: a page's kind
  // decides what the page even is (a live address or a document of ours), how it
  // is changed, and what the deliverable can contain. Getting it wrong makes every
  // later instruction wrong too.
  lines.push(`This is a prototype: a **flow of pages**, and each page is one of two kinds.`)
  lines.push(`- **scratch** — a document of ours: <name>.html in the directory above. We own it, so the change`)
  lines.push(`  is an edit to that file.`)
  lines.push(`- **overlay** — someone else's live page at an address. It is never copied: the page *is* that`)
  lines.push(`  address, with its own JavaScript, its own session and its own data. Study it with the browser`)
  lines.push(`  tool before writing selectors — the live DOM is the only thing that says what they will match —`)
  lines.push(`  and use the same window to ask the user to sign in when the page needs it.`)
  lines.push(`One flow may mix both, and the list below says which is which; the patches never flow back into`)
  lines.push(`a live page's source, so what leaves this workbench is a spec a developer translates onto it,`)
  lines.push(`plus a loadable Chrome extension that puts the change on the real page for whoever wants to see`)
  lines.push(`it — no clicking, no dependency on this workbench.`)
  lines.push('')

  if (ctx.pages.length > 0) {
    lines.push(`Pages, in flow order — 'prototype-open --page <name>' opens one, and 'snapshot' says which`)
    lines.push(`page a window is on:`)
    for (const page of ctx.pages) {
      const where = page.kind === 'overlay' ? (page.url ?? 'no address') : (page.file ?? 'document missing')
      lines.push(`- ${sanitize(page.name)} (${page.kind}) — ${sanitize(where)}${page.entry ? ' (entry)' : ''}`)
    }
    lines.push(
      ctx.entryPage
        ? `The address root (/) opens '${sanitize(ctx.entryPage)}'.`
        : `The address root (/) shows the generated page index, which lists every page above.`,
    )
    lines.push(`Mark a page as the entry with 'prototype-entry <name>', or go back to the index with`)
    lines.push(`'prototype-entry none'. Add a live page with 'prototype-pages --add <name>=<url>' and rename or`)
    lines.push(`remove one with --rename / --remove. A page of ours is a file: write it and it is a page —`)
    lines.push(`'prototype-pages --add <name>' only puts it in the flow order, once the file exists.`)
  } else {
    lines.push(`This prototype has **no pages yet**. That is a starting state, not a mistake: write`)
    lines.push(`<name>.html with the Write tool for a page of ours, or add a live page with`)
    lines.push(`'prototype-pages --add <name>=<url>'.`)
  }
  lines.push('')

  if (overlayPages.length > 0) {
    lines.push(`A live page's address usually exists in several environments (a dev server, staging, production).`)
    lines.push(`Repoint it with 'prototype-target <url> [--page <name>]' rather than making a second prototype — and`)
    lines.push(`say what that costs when you do: windows already open keep the old page, and the selectors were`)
    lines.push(`written against the old DOM (a patch that matches nothing looks like a patch that did nothing). A`)
    lines.push(`page's kind cannot change, and a page of ours has no external page for an address to mean.`)
    lines.push('')
  }

  // References come before the patch rules: they change how the agent should read
  // everything below (patches here are the deliverable; patches over there are
  // notes), so they cannot be deferred to a footnote.
  //
  // The rule is deliberately stated once, without regard to what kind either side
  // is: a reference is a relation between two independent prototypes, and one
  // scratch prototype referencing another works exactly like one referencing a
  // prototype of live pages.
  if (ctx.references.length > 0) {
    lines.push(`This prototype is being built with reference to other prototypes:`)
    for (const reference of ctx.references) {
      lines.push(`- ${sanitize(reference.slug)} — ${sanitize(reference.summary)}, at prototypes/${sanitize(reference.slug)}/`)
    }
    lines.push(`A reference is **evidence, not material**, whatever it is made of. Its patches were written`)
    lines.push(`against a different document: Do NOT copy a reference's patch files into this prototype's`)
    lines.push(`patches/ — their selectors would not match here, and they would ship inside the deliverable`)
    lines.push(`without erroring. Translate the intent into this prototype's own markup, and say in the`)
    lines.push(`conversation what you took from the reference.`)
    lines.push('')
  }

  // The project edge, and with it the answer to "which directory does this go in".
  // A session can have both containers in its context at once — the project from
  // the session's binding, the prototype from this one — and until this was said
  // out loud, nothing told the agent which side a new file belonged on (§15.1).
  if (ctx.projectSlug) {
    lines.push(`This prototype belongs to the workspace project '${sanitize(ctx.projectSlug)}' — an **edge, not a`)
    lines.push(`container**: nothing of the prototype lives inside the project, and nothing of the project lives`)
    lines.push(`inside the prototype. Keep the two apart when you write:`)
    lines.push(`- everything about *this prototype* — pages, patches/<page>/…, prd.md, config.json, research/ and`)
    lines.push(`  dist/ — goes to the prototype directory above.`)
    lines.push(`- the project holds its own concerns (its MEMORY.md, its tasks, its shared assets). Do not copy a`)
    lines.push(`  prototype artifact into it, and do not put project notes into the prototype.`)
    lines.push('')
  }

  // Requirements and research come next because they are what the work is *for*,
  // and because the agent is their only writer: nothing in the workbench produces
  // `prd.md` or a finding, so a block that does not ask for them leaves them not
  // existing at all (plan §20).
  lines.push(`Requirements and research — both are files you write; nothing else here produces them:`)
  lines.push(`- ${sanitize(ctx.dir)}/prd.md holds the requirements. One entry each, headed by a stable id:`)
  lines.push(`  '## R-001 <what it is>', then the prose — who it is for, what happens today, what has to be true.`)
  if (ctx.requirements.length > 0) {
    lines.push(`  Written so far, and what refers to each:`)
    for (const requirement of ctx.requirements) {
      const covered = [
        ...requirement.pages,
        ...requirement.patches,
        ...requirement.findings.map((id) => `${id} (finding)`),
      ]
      lines.push(
        `  - ${sanitize(requirement.id)} ${sanitize(requirement.title)} — ${
          covered.length > 0
            ? `referred to by ${covered.map(sanitize).join(', ')}`
            : '**nothing refers to it yet**'
        }`,
      )
    }
  } else {
    lines.push(`  There is no prd.md yet. Write it before building the next screen: a prototype nobody can read a`)
    lines.push(`  requirement out of is a picture, not a proposal.`)
  }
  lines.push(`- Say which requirement a change serves: '@requirement R-001' in a patch header, or in a comment in the`)
  lines.push(`  page document it changes. 'prototype-status' turns that into the two answers nobody can get by reading`)
  lines.push(`  files: which requirement nothing implements, and which marker names an id prd.md does not define.`)
  lines.push(`- ${sanitize(ctx.dir)}/research/ holds what you learned from other products. One finding per file:`)
  lines.push(`  '# F-001 <what you found>', then labelled lines 'claim:', 'source:', 'captured:', 'evidence:',`)
  lines.push(`  'requirements:'. Evidence names files you keep in research/ (screenshots go there), and 'requirements:'`)
  lines.push(`  names the requirements the finding argues for. A finding with no source cannot be checked later.`)
  if (ctx.findings.length > 0) {
    lines.push(`  Recorded so far — read these before studying the same product again:`)
    for (const finding of ctx.findings) {
      lines.push(
        `  - ${sanitize(finding.id)} ${sanitize(finding.claim ?? '(no claim)')}${
          finding.source ? ` — from ${sanitize(finding.source)}` : ''
        } (${sanitize(finding.file)})`,
      )
    }
  }
  lines.push(`- research/ is **not** packaged (assets/ is): the reader receives the requirements, not your notes.`)
  lines.push('')

  lines.push(`This session is bound to the prototype above. Commands below target it by default —`)
  lines.push(`you do not need to pass a slug, though you may pass one to work on a different prototype.`)
  lines.push('')
  lines.push(`The state below is a snapshot taken when this session started, kept stable so the prompt`)
  lines.push(`stays cacheable. Run 'prototype-status' before relying on it for anything you have changed.`)
  lines.push('')

  // Pages first: without one there is nothing for a patch to apply to, and the
  // agent must not write patches into a prototype that has no page at all.
  if (ctx.pages.length === 0) {
    lines.push(`Pages: none yet, so patches have nothing to apply to. Write the first page first.`)
  } else if (scratchPages.length === 0) {
    lines.push(`Pages: all of them are live pages (above). There is no document of ours in this prototype, and`)
    lines.push(`none is wanted for them — a copy would run none of that page's own JavaScript and carry none of`)
    lines.push(`its session.`)
  } else {
    lines.push(`Pages of ours live in the directory above as ordinary .html files; the others are addresses.`)
  }
  lines.push('')

  // How to write a page of ours. Worth stating because the file *is* the artifact:
  // there is no build step and no template language for a mistake to hide in, and
  // the constraints that bite are the ones a browser enforces only later (an
  // extension page's CSP) or never (a CDN that is simply unreachable offline).
  if (ctx.pages.length === 0 || scratchPages.length > 0) {
    lines.push(`Writing a page of ours — an ordinary HTML document, no build step and no template syntax:`)
    lines.push(`- A complete document (<!doctype html> …): the file is what the browser loads, and nothing compiles it.`)
    if (ctx.layoutPath) {
      lines.push(`- The frame is already written once, in ${sanitize(ctx.layoutPath)}: put only this screen's content in`)
      lines.push(`  the page and reuse the shell's tokens (var(--accent), .card, .row). Do not copy the frame into a page`)
      lines.push(`  — two copies drift, and the shell is where a change to the frame belongs.`)
    } else {
      lines.push(`- This prototype has no shared shell. If two pages would repeat the same frame, write _layout.html`)
      lines.push(`  with the slot ${PROTOTYPE_LAYOUT_SLOT} — the pages of ours render inside it.`)
    }
    lines.push(`- Assets: root-absolute paths (/assets/app.css) — the prototype's directory is the origin root. No CDN`)
    lines.push(`  and no external host: the prototype is opened offline and only its own directory answers.`)
    lines.push(`- Reach for standard HTML before writing any JS: <details> (disclosure), <dialog> (modal),`)
    lines.push(`  :has()/:checked (state-driven styling), required/pattern on inputs (validation), <template>+<slot>`)
    lines.push(`  (reuse). Most prototype interaction needs no script — and the standard version is what the preview`)
    lines.push(`  and the delivered package run identically.`)
    lines.push(`- No eval and no new Function (the delivered extension forbids them), and no bundler: plain <script>,`)
    lines.push(`  <style> and <script type="module"> with relative imports are all fine.`)
    lines.push(`- Shared behaviour goes in a file under assets/ that the pages needing it load; shared structure goes in`)
    lines.push(`  the shell. That is the whole component story — there is no template engine, by design.`)
    lines.push(`- Data: fetch('/api/…') (relative), answered by the contract's fixtures when mocked; keep state in`)
    lines.push(`  localStorage, which survives because this prototype's origin is stable.`)
    lines.push(`- Add a screen by writing a page; change how an existing screen looks by writing a patch under`)
    lines.push(`  patches/<page>/. Do not rewrite a page document to restyle it.`)
    lines.push(`- After writing or changing a page, open it ('prototype-open') and read the console ('console 50 error')`)
    lines.push(`  before calling it done: nothing else here checks a page, so a script error stays invisible until then.`)
    lines.push('')
  }

  lines.push(`Patches are plain files under patches/, named {lane}-{nnn}-{name}.{css|js}. **Where the file`)
  lines.push(`sits is which page it changes**: patches/<page>/… applies to that page only, patches/… applies to`)
  lines.push(`every page. The name is the ownership contract, not a convention — a file that does not match it`)
  lines.push(`is ignored by the injector. Lanes: ${Object.entries(PROTOTYPE_LANES).map(([id, desc]) => `${id} = ${desc}`).join('; ')}.`)
  lines.push(`To add a UI change, write a new file (e.g. patches/A-002-highlight.css for the whole flow, or`)
  lines.push(`patches/cart/B-002-total.js for one page) with the Write tool — do not edit a page's document for`)
  lines.push(`presentation work, and do not rewrite an existing patch file owned by another lane. Every patch is`)
  lines.push(`replayed on reload, so the page state is reproducible.`)
  lines.push(`Say what each patch is aimed at: a header line '@target <css selector>' (and '@requirement R-001').`)
  lines.push(`That is what makes the patch checkable — 'prototype-apply' reports which targets matched nothing, and`)
  lines.push(`a target that used to match and does not any more means the page moved, not that the patch was`)
  lines.push(`ignored. Without a '@target' nothing can tell the two apart, and the patch rots quietly.`)
  lines.push('')
  // These rules exist because the patches are also shipped inside a loadable
  // extension, running on pages we do not control. They are cheap to follow now
  // and expensive to discover later (the failure is "it looked right in the
  // preview and did nothing on the real page").
  lines.push(`Write each patch for the way it will be *replayed*, not just for the state you can see. Two rules:`)
  lines.push(`- It may run more than once, and on more than one page: every page it applies to gets it, a`)
  lines.push(`  single-page view change replays it, and reloading the extension runs it again. Read what is on the`)
  lines.push(`  page rather than assuming it, wait for an element instead of querying once, and keep each patch`)
  lines.push(`  idempotent — appending or inserting twice duplicates something.`)
  lines.push(`- It has no claim on running before the page does: stylesheets are in place before it paints, and js`)
  lines.push(`  runs once the document is there. Do not depend on being first.`)
  lines.push(`Keep the set small and delete patches that no longer change anything — all of them ship in the`)
  lines.push(`deliverable. Keep the source readable, no minifying and no obfuscating: whoever receives the preview`)
  lines.push(`is asked to run it on their page, and being able to read it is how they decide to.`)
  lines.push('')

  if (ctx.patches.length > 0) {
    lines.push(`Replayed patches, in order:`)
    for (const patch of ctx.patches) {
      const scope = patch.page ? `page ${sanitize(patch.page)}` : 'every page'
      const targets = patch.targets.length > 0 ? `, targets ${patch.targets.map(sanitize).join(', ')}` : ''
      lines.push(`- ${sanitize(patch.file)} (lane ${patch.lane ?? '?'}, ${patch.kind}, ${scope}${targets})`)
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
  lines.push(`window, and 'prototype-export' to build the deliverable — one loadable extension plus the change`)
  lines.push(`spec a developer reads. 'prototype-status' re-reads everything from disk when you need to confirm`)
  lines.push(`what is actually there.`)
  // Commit is described here rather than with the patches because it is the one
  // action that *removes* patches: an agent that has not read this would keep
  // writing new files where the change now has a home.
  lines.push(`'prototype-commit' folds the delta layer into what owns it, when the work has stopped moving: a`)
  lines.push(`page of ours gets its css folded into assets/<page>/committed.css and its js promoted into`)
  lines.push(`assets/<page>/committed.js (the document is linked to both, and the patch files are deleted); a live`)
  lines.push(`page's patches are folded into patches/<page>/Z-001-upper.css and Z-002-upper.js, which replay last.`)
  lines.push(`It is irreversible — a folded patch no longer exists as a file — so commit at a point, not after every`)
  lines.push(`change. Keep writing patches until then; a run of small edits is what the layer is for.`)
  lines.push(`</prototype_context>`)
  lines.push('')
  return lines.join('\n')
}
