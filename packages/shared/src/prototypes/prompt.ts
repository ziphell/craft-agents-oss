/**
 * Prototype prompt context — what the agent is told about the prototype its
 * session is bound to.
 *
 * This is the reason a bound conversation needs no slugs: the block below is
 * injected into the system prompt, so the agent knows which prototype it is
 * working on and what its specs are — before the user says anything.
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
   * The specification's specs — one per `*.spec.md` file. Empty when the folder holds none —
   * a state the prompt has to name out loud, because the agent is their only writer.
   */
  specs: Array<{
    /** The spec's file, prototype-relative — its identity. */
    file: string
    title: string
  }>
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
    specs: status.specs.map((spec) => ({
      file: spec.file,
      title: spec.title,
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
  lines.push(`- The specification is the folder's '*.spec.md' files in ${sanitize(ctx.dir)} — one file per`)
  lines.push(`  spec, flat or in folders, and the file's name is the spec's identity. The file's`)
  lines.push(`  first heading is its title and the rest of it is the spec.`)
  lines.push(`- Everything else in that folder is yours, in any format — flows, personas, screenshots, a spreadsheet,`)
  lines.push(`  a stack of notes. There is no rule about what may sit there, and nothing enumerates or filters it.`)
  lines.push('')

  // Specs come next because they are what the work is *for*,
  // and because the agent is their only writer: nothing in the workbench produces
  // a spec document, so a block that does not ask for one leaves it not
  // existing at all.
  lines.push(`The specification — files you write; nothing else here produces them:`)
  lines.push(`- Before writing a spec, think from first principles about the value: what the person cannot`)
  lines.push(`  do today, and what actually changes for them if this exists. Start from that problem rather than`)
  lines.push(`  from a screen, a competitor's feature or the user's own phrasing — a spec that only`)
  lines.push(`  restates one of those has not been thought about, and nothing here can check that for you: this`)
  lines.push(`  workbench can say what a spec is about, never that it was worth writing.`)
  lines.push(`- One file per spec: give it its own '<name>.spec.md', and the file's name is the`)
  lines.push(`  spec's identity — there is no id to keep in sync, and the prose in the file is the`)
  lines.push(`  spec.`)
  if (ctx.specs.length > 0) {
    lines.push(`  Written so far:`)
    for (const spec of ctx.specs) {
      lines.push(`  - ${sanitize(spec.title)} (${sanitize(spec.file)})`)
    }
  } else {
    lines.push(`  No spec has been written yet. Write one before building anything: a prototype nobody can`)
    lines.push(`  read a spec out of is a picture, not a proposal.`)
  }
  lines.push(`- Material can live in its own document: split personas, the flow as it stands today or a`)
  lines.push(`  glossary into their own markdown file rather than growing one document nobody can skim.`)
  lines.push(`- Documents point at each other with an ordinary markdown link, '[the flow](docs/checkout.md)',`)
  lines.push(`  resolved from this document's folder and then the folder root ('../spec.md' works too). That is how`)
  lines.push(`  one file indexes several: a complex spec stays a line in the entry document and its detail`)
  lines.push(`  lives beside it. A link is navigation and nothing else — it says where to read next, never that`)
  lines.push(`  something exists — and a link that points at nothing is reported.`)
  lines.push(`- material is read for intent and translated into this prototype's own files; another prototype's`)
  lines.push(`  files are NEVER copied in — they were written against a different body of work, and whatever they`)
  lines.push(`  claim would be a second, contradictory statement of the thread.`)
  lines.push('')

  lines.push(`This session is bound to the prototype above. Commands below target it by default —`)
  lines.push(`you do not need to pass a slug, though you may pass one to work on a different prototype.`)
  lines.push('')
  lines.push(`The state below is a snapshot taken when this session started, kept stable so the prompt`)
  lines.push(`stays cacheable. Run 'status' before relying on it for anything you have changed.`)
  lines.push('')

  lines.push(`Workflow: write the files above, then 'status' to re-read the folder from disk — the specs,`)
  lines.push(`the files beside them, and any link that points at nothing.`)
  lines.push(`</prototype_context>`)
  lines.push('')
  return lines.join('\n')
}
