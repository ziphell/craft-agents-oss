/**
 * Prototype research — what was learned, and from where.
 *
 * Competitive work used to leave nothing behind: a window was opened, something
 * was noticed, and the noticing lived in the conversation. The next session then
 * either repeated it or, worse, contradicted it. This module is the missing
 * product of that work — a **finding**: one claim, its source, and the evidence
 * for it.
 *
 * A finding is one file under `research/`, named after its id, and it is
 * deliberately shaped like the PRD (a heading with an id, then labelled lines) so
 * that the two read the same way and refer to each other:
 *
 * ```md
 * # F-001 The total stays pinned while the list scrolls
 *
 * claim: The cart keeps the total visible at all times, so the decision is never off screen.
 * source: https://shop.example.com/cart
 * captured: 2026-09-15
 * evidence: shots/cart-top.png, shots/cart-scrolled.png
 * requirements: R-003
 *
 * The pinned bar is `position: sticky` on the summary row…
 * ```
 *
 * Three properties are what make this a workbench rather than a notes folder:
 *
 * - **`source`** — where it was seen. A claim about someone else's product that
 *   cannot be re-checked is a rumour.
 * - **`evidence`** — files under `research/`, checked against the disk. A
 *   screenshot that is not there is reported, because a broken citation is how a
 *   finding becomes unfalsifiable.
 * - **`requirements`** — which requirement it argues for. This is the edge from
 *   evidence to decision, and the reason `research/` is worth its own directory.
 *
 * Nothing here is packaged for delivery: `research/` is how the reader got to the
 * requirements, not part of what they receive (that is `export.ts`, which ships
 * `assets/` and not this — plan §20.2).
 */

import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { normalizeRequirementId } from './requirements.ts'
import { getPrototypeResearchPath } from './storage.ts'
import { PROTOTYPE_RESEARCH_DIRNAME } from './types.ts'

// The directory name and its path builder live with the other paths; re-exported
// here so a caller reading findings never needs a second import.
export { PROTOTYPE_RESEARCH_DIRNAME, getPrototypeResearchPath }

/** One finding: what was learned about something else. */
export interface PrototypeFinding {
  /** `F-001`. What other files refer to it by. */
  id: string
  title: string
  /** The one sentence being claimed. Null when the file has no `claim:` line. */
  claim: string | null
  /** Where it was observed — usually someone else's live page. */
  source: string | null
  /** When, as written by the author (`captured:`). Not parsed into a date: we do not own the format. */
  captured: string | null
  /** Paths relative to `research/`, as written. Checked against the disk (see `issues`). */
  evidence: string[]
  /** Requirement ids this finding argues for. */
  requirements: string[]
  /** The prose under the labelled lines. */
  body: string
  /** Path relative to the prototype directory, e.g. `research/F-001-sticky-total.md`. */
  file: string
}

export interface PrototypeFindings {
  findings: PrototypeFinding[]
  /** Read problems — a duplicate id, a claim-less finding, evidence that is not there. */
  issues: string[]
}

/** `# F-001 The total stays pinned` — the file's own id, at the top. */
const FINDING_HEADING_RE = /^#\s+(F-\d{1,4})\b[\s:—–-]*(.*)$/i
/** `claim: …`, `evidence: a.png, b.png` — one labelled line. */
const LABEL_RE = /^([A-Za-z][A-Za-z-]*)\s*:\s*(.*)$/

function splitList(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

/**
 * Parse one finding file.
 *
 * Returns null when the file is not a finding at all (no `# F-xxx` heading) —
 * a plain note in `research/` is a legitimate thing to keep and is ignored rather
 * than reported as broken.
 */
export function parsePrototypeFinding(source: string, file: string): PrototypeFinding | null {
  const lines = source.split('\n')
  let heading: RegExpExecArray | null = null

  for (const line of lines) {
    heading = FINDING_HEADING_RE.exec(line.trim())
    if (heading) break
  }
  if (!heading) return null

  const id = `F-${String(Number(heading[1]!.slice(2))).padStart(3, '0')}`
  const title = (heading[2] ?? '').trim()

  const labels = new Map<string, string>()
  const body: string[] = []
  let inBody = false

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('#')) continue

    const label = inBody ? null : LABEL_RE.exec(trimmed)
    if (label && !trimmed.startsWith('#')) {
      labels.set(label[1]!.toLowerCase(), (label[2] ?? '').trim())
      continue
    }

    if (trimmed === '' && !inBody && labels.size > 0) {
      inBody = true
      continue
    }
    if (inBody || trimmed !== '') body.push(line)
  }

  const requirements = splitList(labels.get('requirements') ?? '')
    .map((entry) => normalizeRequirementId(entry))
    .filter((entry): entry is string => entry !== null)

  return {
    id,
    title,
    claim: labels.get('claim') ?? null,
    source: labels.get('source') ?? null,
    captured: labels.get('captured') ?? null,
    evidence: splitList(labels.get('evidence') ?? ''),
    requirements,
    body: body.join('\n').trim(),
    file,
  }
}

/**
 * Read a prototype's findings.
 *
 * Every `*.md` directly under `research/` is read; a file with no `# F-xxx`
 * heading is a note and is skipped. Evidence paths are resolved against
 * `research/` and a missing one is reported — the citation is the part of a
 * finding that has to be true.
 */
export function readPrototypeFindings(workspaceRootPath: string, slug: string): PrototypeFindings {
  const dir = getPrototypeResearchPath(workspaceRootPath, slug)
  if (!existsSync(dir)) return { findings: [], issues: [] }

  let entries: string[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return { findings: [], issues: [] }
  }

  const findings: PrototypeFinding[] = []
  const issues: string[] = []
  const seen = new Set<string>()

  for (const name of entries) {
    let source: string
    try {
      source = readFileSync(join(dir, name), 'utf-8')
    } catch {
      continue
    }

    const finding = parsePrototypeFinding(source, `${PROTOTYPE_RESEARCH_DIRNAME}/${name}`)
    if (!finding) continue

    if (seen.has(finding.id)) {
      issues.push(`${finding.file}: id ${finding.id} is already used by another finding.`)
      continue
    }
    seen.add(finding.id)

    if (!finding.claim) {
      issues.push(
        `${finding.file}: no "claim:" line — a finding without a claim is a bookmark, not something ` +
          `a requirement can be argued from.`,
      )
    }
    for (const evidence of finding.evidence) {
      if (!existsSync(join(dir, evidence))) {
        issues.push(`${finding.file}: evidence "${evidence}" is not in ${PROTOTYPE_RESEARCH_DIRNAME}/.`)
      }
    }

    findings.push(finding)
  }

  return { findings, issues }
}
