/**
 * Prototype prompt context — what the agent is told about the prototype its
 * session is bound to.
 *
 * This is the reason a bound conversation needs no slugs: the block below is
 * injected into the system prompt, so the agent knows which prototype it is
 * working on, what its requirements are, and what research and reviews already
 * exist — before the user says anything.
 *
 * Kept out of `status.ts` because this is a *presentation* concern: the same
 * facts are rendered differently for the panel (tables) and for the model
 * (prose + explicit instructions).
 */

import { existsSync } from 'fs'
import { getPrototypeDirPath } from './storage.ts'
import { buildPrototypeStatus } from './status.ts'

export interface PrototypePromptContext {
  slug: string
  /** Absolute path to the prototype's directory — the folder the author's files live in. */
  dir: string
  /**
   * The specification's requirements, each with the findings that argue for it. Empty when no
   * markdown file states one — a state the prompt has to name out loud, because the agent is their
   * only writer.
   */
  requirements: Array<{
    id: string
    title: string
    findings: string[]
  }>
  /**
   * Findings already recorded under `research/`. Carried so the agent
   * reads what it learned last time instead of studying the same product again.
   */
  findings: Array<{ id: string; claim: string | null; source: string | null; file: string }>
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
    requirements: status.requirements.map((requirement) => ({
      id: requirement.id,
      title: requirement.title,
      findings: requirement.findings,
    })),
    findings: status.findings.map((finding) => ({
      id: finding.id,
      claim: finding.claim,
      source: finding.source,
      file: finding.file,
    })),
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

  lines.push(`This is a prototype: a **folder that holds a specification**, and nothing else of ours.`)
  lines.push(`- The specification is the markdown files in ${sanitize(ctx.dir)} — one file or several, flat or`)
  lines.push(`  in folders. A requirement is a heading whose id starts with R- ('## R-001 <what it is>'), and`)
  lines.push(`  that id is what a finding names when it argues for one.`)
  lines.push(`- Everything else in that folder is yours, in any format — flows, personas, screenshots, a spreadsheet,`)
  lines.push(`  a stack of notes. There is no rule about what may sit there, and nothing enumerates or filters it.`)
  lines.push('')

  // Requirements and research come next because they are what the work is *for*,
  // and because the agent is their only writer: nothing in the workbench produces
  // a requirement document or a finding, so a block that does not ask for them leaves them not
  // existing at all.
  lines.push(`Requirements and research — both are files you write; nothing else here produces them:`)
  lines.push(`- Before writing a requirement, think from first principles about the value: what the person cannot`)
  lines.push(`  do today, and what actually changes for them if this exists. Start from that problem rather than`)
  lines.push(`  from a screen, a competitor's feature or the user's own phrasing — a requirement that only`)
  lines.push(`  restates one of those has not been thought about, and nothing here can check that for you: this`)
  lines.push(`  workbench can say what a requirement is about, never that it was worth writing.`)
  lines.push(`- One entry per requirement, headed by a stable id — '## R-001 <what it is>' — and the id is the`)
  lines.push(`  entire mechanism: short, survives rewriting the prose around it, and is what every reference is`)
  lines.push(`  written against. The prose under it is the requirement.`)
  if (ctx.requirements.length > 0) {
    lines.push(`  Written so far:`)
    for (const requirement of ctx.requirements) {
      const argued = requirement.findings.map((id) => `${id} (finding)`)
      lines.push(
        `  - ${sanitize(requirement.id)} ${sanitize(requirement.title)}${
          argued.length > 0 ? ` — argued for by ${argued.map(sanitize).join(', ')}` : ''
        }`,
      )
    }
  } else {
    lines.push(`  No requirement has been written yet. Write one before building anything: a prototype nobody can`)
    lines.push(`  read a requirement out of is a picture, not a proposal.`)
  }
  lines.push(`- The specification may be one file or several: split a subject out (personas, the flow as it stands`)
  lines.push(`  today, a glossary) into its own markdown file rather than growing one document nobody can skim.`)
  lines.push(`- Documents point at each other with an ordinary markdown link, '[the flow](docs/checkout.md)',`)
  lines.push(`  resolved from this document's folder and then the folder root ('../PRD.md' works too). That is how`)
  lines.push(`  one file indexes several: a complex requirement stays a line in the entry document and its detail`)
  lines.push(`  lives beside it. A link is navigation and nothing else — it says where to read next, never that`)
  lines.push(`  something exists — and a link that points at nothing is reported.`)
  lines.push(`- ${sanitize(ctx.dir)}/research/ holds what you learned from other products. One finding per file:`)
  lines.push(`  '# F-001 <what you found>', then labelled lines 'claim:', 'source:', 'captured:', 'evidence:',`)
  lines.push(`  'requirements:'. Evidence names files you keep in research/ (a screenshot you took, for`)
  lines.push(`  instance), and 'requirements:' names the requirements the finding argues for. A finding with`)
  lines.push(`  no source cannot be checked later.`)
  lines.push(`- material is read for intent and translated into this prototype's own files; another prototype's`)
  lines.push(`  files are NEVER copied in — they were written against a different body of work, and whatever they`)
  lines.push(`  claim would be a second, contradictory statement of the thread.`)
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
  lines.push(`- research/ is **not** delivered: the reader receives the specification, not your notes.`)
  lines.push('')

  lines.push(`This session is bound to the prototype above. Commands below target it by default —`)
  lines.push(`you do not need to pass a slug, though you may pass one to work on a different prototype.`)
  lines.push('')
  lines.push(`The state below is a snapshot taken when this session started, kept stable so the prompt`)
  lines.push(`stays cacheable. Run 'status' before relying on it for anything you have changed.`)
  lines.push('')

  lines.push(`Workflow: write the files above, then 'status' to re-read the folder from disk — the requirements,`)
  lines.push(`the files beside them, and any link that points at nothing.`)
  lines.push(`</prototype_context>`)
  lines.push('')
  return lines.join('\n')
}
