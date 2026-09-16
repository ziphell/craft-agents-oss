/**
 * Prototype requirements — the PRD, and the thread back to it.
 *
 * Every other artifact this workbench derives says **what changed**: a page is a
 * screen, a patch is an edit, `dev-spec.md` lists both, a contract is an
 * interface. None of them says *what problem was being solved* — which is the one
 * thing the person handed the package has to judge. A delivery without that is
 * something to copy rather than something to agree with, so this module is the
 * difference between a prototype tool and a requirement workbench (plan §20.1).
 *
 * A requirement is a **heading with a stable id** in `prd.md`:
 *
 * ```md
 * ## R-001 A cart holds its line until stock runs out
 *
 * Given a line is in the cart, when another shopper takes the last unit…
 * ```
 *
 * The id is the entire mechanism. It is short, survives rewriting the prose
 * around it, and — the point — is **referable**: a patch says `@requirement
 * R-001` in its header, a page document says it in a comment, and the status
 * report can then answer the two questions nobody can answer by reading files:
 * which requirement has nothing implementing it, and which change belongs to no
 * requirement at all.
 *
 * The PRD is deliberately **not** in `config.json`. It is prose that the agent
 * writes as a file, and parsing it here is what keeps it a document people can
 * read rather than a form they have to fill in.
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { getPrototypeDirPath } from './storage.ts'
import { normalizeRequirementId } from './patch-header.ts'

// The marker parser lives in `patch-header.ts` (which imports nothing) because
// `storage.ts` needs it too, and it already imports this module — see the note
// there. Re-exported so a caller that reads requirements never needs a second
// import, and so the public surface of this workbench is unchanged.
export { extractRequirementIds, normalizeRequirementId } from './patch-header.ts'

export const PROTOTYPE_PRD_FILENAME = 'prd.md'

/** Absolute path to a prototype's `prd.md`. */
export function getPrototypePrdPath(workspaceRootPath: string, slug: string): string {
  return join(getPrototypeDirPath(workspaceRootPath, slug), PROTOTYPE_PRD_FILENAME)
}

/** The kinds of acceptance check a requirement can carry (plan §20.7). */
export type PrototypeCheckKind = 'selector' | 'endpoint'

/**
 * One acceptance check, as the PRD states it.
 *
 * `selector` is asserted against the page on screen, `endpoint` against the
 * contract. Both are deliberately mechanical: an acceptance criterion that only a
 * person can judge is a criterion nobody runs, and the point of these lines is
 * that `prototype-verify` can answer pass or fail without an opinion.
 */
export interface PrototypeCheck {
  kind: PrototypeCheckKind
  /** `[data-cart-total]` for a selector, `GET /api/cart` for an endpoint. */
  target: string
}

/** One requirement of the PRD, as the document states it. */
export interface PrototypeRequirement {
  /** `R-001`. Stable, and what every reference is written against. */
  id: string
  /** The rest of the heading, or an empty string when the heading is just the id. */
  title: string
  /**
   * The prose under the heading, trimmed. An empty body is a requirement whose
   * acceptance criteria have not been written yet — reported, not hidden.
   */
  body: string
  /** The `check:` lines under it, in the order written. */
  checks: PrototypeCheck[]
}

export interface PrototypeRequirements {
  /** In the order the PRD states them: the document's order is part of its argument. */
  requirements: PrototypeRequirement[]
  /** Read problems — a duplicate id, a PRD with no entries at all. */
  issues: string[]
}

/** `## R-001 A cart holds its line` — any heading depth, id first. */
const REQUIREMENT_HEADING_RE = /^#{1,6}\s+(R-\d{1,4})\b[\s:—–-]*(.*)$/i

/**
 * `check: selector [data-cart-total]` — an acceptance check under a requirement.
 *
 * A line the parser does not recognise as a check is reported rather than
 * ignored: `check: expression …` would otherwise look like a criterion that is
 * being verified, when nothing is looking at it at all.
 */
const CHECK_RE = /^check\s*:\s*(\S+)\s*(.*)$/i

/**
 * Read a PRD into requirements.
 *
 * Tolerant in the same way `readPrototypeConfig` is: a missing file is "no PRD
 * yet" (the honest state of a prototype that has just been created), and an
 * unreadable one must not make the prototype unusable. What it will not do is
 * drop an entry quietly — a requirement that vanished from the report is a
 * requirement nobody implements.
 */
export function parsePrototypePrd(source: string): PrototypeRequirements {
  const requirements: PrototypeRequirement[] = []
  const issues: string[] = []
  const seen = new Set<string>()

  let current: PrototypeRequirement | null = null
  let body: string[] = []

  const flush = (): void => {
    if (!current) return
    requirements.push({ ...current, body: body.join('\n').trim() })
    current = null
    body = []
  }

  for (const line of source.split('\n')) {
    const heading = REQUIREMENT_HEADING_RE.exec(line.trim())
    const isHeading = /^#{1,6}\s/.test(line.trim())

    if (heading) {
      const id = normalizeRequirementId(heading[1] ?? '')
      if (!id) continue
      flush()
      if (seen.has(id)) {
        issues.push(`${PROTOTYPE_PRD_FILENAME}: two entries share the id ${id}; a reference to it is ambiguous.`)
        continue
      }
      seen.add(id)
      current = { id, title: (heading[2] ?? '').trim(), body: '', checks: [] }
      continue
    }

    if (isHeading) {
      // Any other heading ends the current entry — a requirement's body is what
      // is under it, not the rest of the document.
      flush()
      continue
    }

    if (current) {
      const check = CHECK_RE.exec(line.trim())
      if (check) {
        const kind = (check[1] ?? '').toLowerCase()
        const target = (check[2] ?? '').trim()

        if (kind !== 'selector' && kind !== 'endpoint') {
          issues.push(
            `${PROTOTYPE_PRD_FILENAME}: "${kind}" is not a check this can run — use ` +
              `"check: selector <css>" or "check: endpoint <METHOD> <path>".`,
          )
        } else if (target.length === 0) {
          issues.push(`${PROTOTYPE_PRD_FILENAME}: the "${kind}" check under ${current.id} has no target.`)
        } else {
          current.checks.push({ kind, target })
        }
        continue
      }
      body.push(line)
    }
  }
  flush()

  if (requirements.length === 0) {
    issues.push(
      `${PROTOTYPE_PRD_FILENAME} has no "## R-001 <title>" entries, so there is nothing for a patch to refer to. ` +
        `Give every requirement a heading whose id starts with R-.`,
    )
  }

  return { requirements, issues }
}

/**
 * Read a prototype's PRD.
 *
 * A prototype with no `prd.md` is a prototype whose requirements have not been
 * written yet — not an error, and the status report says so in those words.
 */
export function readPrototypeRequirements(workspaceRootPath: string, slug: string): PrototypeRequirements {
  const path = getPrototypePrdPath(workspaceRootPath, slug)
  if (!existsSync(path)) return { requirements: [], issues: [] }

  try {
    return parsePrototypePrd(readFileSync(path, 'utf-8'))
  } catch {
    return { requirements: [], issues: [] }
  }
}
