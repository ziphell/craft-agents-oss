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
   * The specification's requirements with what refers to each one. Empty when no markdown file
   * states one — a state the prompt has to name out loud, because the agent is their only writer.
   */
  requirements: Array<{
    id: string
    title: string
    files: string[]
    findings: string[]
  }>
  /**
   * Findings already recorded under `research/`. Carried so the agent
   * reads what it learned last time instead of studying the same product again.
   */
  findings: Array<{ id: string; claim: string | null; source: string | null; file: string }>
  /**
   * The argument against the work (`reviews/`): what still stands, and how many were
   * settled. Carried for the same reason the findings are — an agent that cannot see the objection
   * will keep building the thing somebody already argued about.
   */
  reviews: {
    total: number
    unresolved: Array<{
      id: string
      file: string
      about: string
      status: string | null
      stale: boolean
      staleReason: string | null
      claim: string | null
    }>
  }
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
      files: requirement.files,
      findings: requirement.findings,
    })),
    findings: status.findings.map((finding) => ({
      id: finding.id,
      claim: finding.claim,
      source: finding.source,
      file: finding.file,
    })),
    reviews: {
      total: status.reviews.total,
      unresolved: status.reviews.unresolved.map((dispute) => ({
        id: dispute.id,
        file: dispute.file,
        about: dispute.about,
        status: dispute.status,
        stale: dispute.stale,
        staleReason: dispute.staleReason,
        claim: dispute.claim,
      })),
    },
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
  lines.push(`  that id is what every other file refers back to.`)
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
  lines.push(`  restates one of those has not been thought about, and nothing here can check that for you: the`)
  lines.push(`  workbench can show a requirement is unimplemented, never that it was worth writing.`)
  lines.push(`- One entry per requirement, headed by a stable id — '## R-001 <what it is>' — and the id is the`)
  lines.push(`  entire mechanism: short, survives rewriting the prose around it, and is what every reference is`)
  lines.push(`  written against. The prose under it is the requirement.`)
  if (ctx.requirements.length > 0) {
    lines.push(`  Written so far, and what refers to each:`)
    for (const requirement of ctx.requirements) {
      const covered = [
        ...requirement.files,
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
    lines.push(`  No requirement has been written yet. Write one before building anything: a prototype nobody can`)
    lines.push(`  read a requirement out of is a picture, not a proposal.`)
  }
  lines.push(`- Say which requirement what you write serves: '@requirement R-001' in a comment in the file. That`)
  lines.push(`  is what 'status' turns into the two answers nobody can get by reading files: which requirement`)
  lines.push(`  nothing implements, and which marker names an id no document defines.`)
  lines.push(`- The specification may be one file or several: split a subject out (personas, the flow as it stands`)
  lines.push(`  today, a glossary) into its own markdown file rather than growing one document nobody can skim.`)
  lines.push(`- Documents point at each other with a wiki link — '[[docs/checkout.md]]' by path, or '[[checkout]]' by`)
  lines.push(`  name. That is how one file indexes several: a complex requirement stays a line in the entry document`)
  lines.push(`  and its detail lives beside it. A link is navigation, not a claim about the work — what implements a`)
  lines.push(`  requirement is still only '@requirement R-00x' — and a link that points at nothing is reported.`)
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

  lines.push(`The argument *against* the work lives in ${sanitize(ctx.dir)}/reviews/ — one dispute per file. It is`)
  lines.push(`how you disagree with something without the disagreement dying with this conversation, and it is`)
  lines.push(`the point a task's critic writes to instead of a paragraph nobody can find later:`)
  lines.push(`- '# D-001 <what is disputed>', then labelled lines: 'about:', 'status:', 'claim:', 'evidence:'`)
  lines.push(`  (and 'on:' for a requirement dispute).`)
  lines.push(`- 'about:' names one thing: 'requirement R-001'.`)
  lines.push(`- A dispute also needs 'on:' — the fingerprint printed beside that requirement by 'status'. It is`)
  lines.push(`  what lets a later reader tell an argument about the current wording from one about a wording`)
  lines.push(`  that no longer exists; without it the objection cannot be checked, and the report says so.`)
  lines.push(`- 'status:' is one of open (it stands), fixed (the thing was changed), rebutted (you judged it`)
  lines.push(`  unfounded, reason in the body) or accepted (valid, and the cost was taken deliberately). 'fixed'`)
  lines.push(`  on a requirement that has not changed is reported as a record that disagrees with the files.`)
  if (ctx.reviews.unresolved.length > 0) {
    lines.push(`  Still standing (${ctx.reviews.total} filed so far) — reading these is part of the work, not a`)
    lines.push(`  formality: an objection nobody answered is the one thing a "finished" prototype must not hide.`)
    for (const dispute of ctx.reviews.unresolved) {
      const stale = dispute.stale ? `, **stale**: ${sanitize(dispute.staleReason ?? '')}` : ''
      lines.push(
        `  - ${sanitize(dispute.id)} (${sanitize(dispute.status ?? 'no status')}${stale}) about ${sanitize(dispute.about)} — ${sanitize(dispute.claim ?? '(no claim)')} (${sanitize(dispute.file)})`,
      )
    }
  } else if (ctx.reviews.total > 0) {
    lines.push(`  Nothing is standing: all ${ctx.reviews.total} filed so far were answered.`)
  }
  lines.push('')

  lines.push(`This session is bound to the prototype above. Commands below target it by default —`)
  lines.push(`you do not need to pass a slug, though you may pass one to work on a different prototype.`)
  lines.push('')
  lines.push(`The state below is a snapshot taken when this session started, kept stable so the prompt`)
  lines.push(`stays cacheable. Run 'status' before relying on it for anything you have changed.`)
  lines.push('')

  lines.push(`Workflow: write the files above, then 'status' to re-read everything from disk — it is what turns`)
  lines.push(`the markers into the answers nobody can get by reading files one at a time.`)
  lines.push(`</prototype_context>`)
  lines.push('')
  return lines.join('\n')
}
