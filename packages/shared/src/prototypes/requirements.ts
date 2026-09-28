/**
 * Prototype requirements — the specification, and the thread back to it.
 *
 * Every other artifact this workbench derives is a fact about one file: a finding is a claim, a
 * review is an objection. None of them says *what problem was being solved* — which is the one
 * thing the person handed the work has to judge. A delivery without that is
 * something to copy rather than something to agree with, so this module is the
 * difference between a prototype tool and a requirement workbench.
 *
 * The specification is **one file or several among the prototype's own files**, not a container.
 * A requirement is a heading with a stable id — `## R-001 <title>` — in **any markdown file** of
 * the folder (`PRD.md`, `docs/features.md`, wherever the author put it), and the file it is written
 * in is carried with it: the report names it, the detail page groups by it. `PRD.md` is the
 * conventional entry — what `create` seeds — but it is not the only file requirements are read
 * from, because real work is organized into as many documents as it takes.
 *
 * The id is the entire mechanism. It is short, survives rewriting the prose
 * around it, and — the point — is **referable**: any file in the prototype may say
 * `@requirement R-001` in a comment (`coverage.ts`), a finding says it with
 * `requirements:`, and the status report can then answer the two questions nobody
 * can answer by reading files: which requirement has nothing implementing it, and
 * which marker names an id the specification does not define.
 *
 * The documents are deliberately **not** in a stored index. They are prose the agent
 * writes as files, and parsing them here is what keeps them documents people can
 * read rather than a form they have to fill in.
 *
 * What this module deliberately does **not** do any more is read acceptance out of the documents:
 * `check:` is not a concept here, so a line that says `check: …` is ordinary prose under its
 * requirement — nothing parses it, nothing reports it, and there is no kind to give it.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { markerIndex } from '../markers.ts'
import { contentFingerprint, getPrototypeDirPath, isMarkdownFile, listPrototypeFiles } from './storage.ts'
import { PROTOTYPE_PRD_FILENAME } from './types.ts'

const REQUIREMENT_MARKER = '@requirement'

/**
 * Normalize a requirement id written by hand.
 *
 * `r1`, `R-1`, `R-001` and `R-0001` are the same requirement: ids are written by
 * hand in more than one kind of file, so this tolerance is what keeps a typo in a
 * reference from silently meaning "no such requirement".
 */
export function normalizeRequirementId(value: string): string | null {
  const match = /^R-?(\d{1,4})$/i.exec(value.trim())
  if (!match) return null
  return `R-${String(Number(match[1])).padStart(3, '0')}`
}

/**
 * The requirement ids a file declares with `@requirement`.
 *
 * A declaration is `@requirement R-001`, optionally with more ids on the same
 * line (`@requirement R-001 R-002` or `…, R-002`). Everything after the marker on
 * that line is read, so the marker can be followed by a reason: writing why a
 * requirement exists next to the id it serves is the behaviour this is meant to
 * encourage, not to reject.
 *
 * Any file of the prototype may carry it — a document, a stylesheet, a script —
 * which is what makes the thread independent of any one artifact type
 * (`coverage.ts`).
 *
 * Unknown spellings are ignored rather than guessed at: a line that says
 * `@requirement TBD` is a note to self, and treating it as a reference to a
 * requirement would invent an id.
 */
export function extractRequirementIds(source: string): string[] {
  const ids: string[] = []
  const seen = new Set<string>()

  for (const line of source.split('\n')) {
    const marker = markerIndex(line, REQUIREMENT_MARKER)
    if (marker === -1) continue

    for (const match of line.slice(marker + REQUIREMENT_MARKER.length).matchAll(/R-?\d{1,4}/gi)) {
      const id = normalizeRequirementId(match[0])
      if (!id || seen.has(id)) continue
      seen.add(id)
      ids.push(id)
    }
  }

  return ids
}

/** Absolute path to the prototype's conventional entry document (`PRD.md`). */
export function getPrototypePrdPath(workspaceRootPath: string, slug: string): string {
  return join(getPrototypeDirPath(workspaceRootPath, slug), PROTOTYPE_PRD_FILENAME)
}

/** One requirement of the specification, as its document states it. */
export interface PrototypeRequirement {
  /** `R-001`. Stable, and what every reference is written against. */
  id: string
  /** The rest of the heading, or an empty string when the heading is just the id. */
  title: string
  /**
   * The prose under the heading, trimmed. An empty body is a requirement whose
   * prose has not been written yet — reported, not hidden.
   */
  body: string
  /**
   * The prototype-relative path of the markdown file whose heading defines it — `PRD.md`,
   * `docs/features.md`. Carried so the report and the page can say where a requirement is written,
   * which file no longer implies anything on its own.
   */
  file: string
}

export interface PrototypeRequirements {
  /** In reading order: file path order, and the document's own order within each file. */
  requirements: PrototypeRequirement[]
  /** Read problems — a duplicate id across files, an unreadable document. */
  issues: string[]
}

/**
 * The fingerprint of what a requirement *says* — its heading and its prose.
 *
 * A review records it (`on:`) when it is filed, and is reported **stale** when the
 * requirement has been rewritten since (`reviews.ts`). Here rather than in either
 * reader because two implementations of one fingerprint would drift, and a drift
 * would show up as an argument that looks live when it is not.
 */
export function requirementFingerprint(requirement: PrototypeRequirement): string {
  return contentFingerprint(`${requirement.title}\n\n${requirement.body}`)
}

/** `## R-001 A cart holds its line` — any heading depth, id first. */
const REQUIREMENT_HEADING_RE = /^#{1,6}\s+(R-\d{1,4})\b[\s:—–-]*(.*)$/i

/**
 * Read the requirement headings out of one markdown document.
 *
 * The document does exactly one thing here: `## R-00x <title>` opens a requirement and the prose
 * under it is that requirement's body, up to the next heading. There is no acceptance to read —
 * a `check: …` line is prose like any other (`verify` and the checks it ran are gone).
 *
 * Tolerant of ordinary prose: a heading that is not a requirement ends the current entry and is
 * otherwise ignored, so a document that merely *mentions* `R-001` in a sentence is not read as
 * defining it. What it will not do is drop an entry quietly — a requirement that vanished from the
 * report is a requirement nobody implements — so a repeated id within the document is reported
 * rather than the second one being folded silently into the first (`file` names it).
 */
export function parseRequirementDocument(source: string, file: string): PrototypeRequirements {
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
        issues.push(`${file}: two entries share the id ${id}; a reference to it is ambiguous.`)
        continue
      }
      seen.add(id)
      current = { id, file, title: (heading[2] ?? '').trim(), body: '' }
      continue
    }

    if (isHeading) {
      // Any other heading ends the current entry — a requirement's body is what
      // is under it, not the rest of the document.
      flush()
      continue
    }

    if (current) body.push(line)
  }
  flush()

  return { requirements, issues }
}

/**
 * Read a prototype's requirements — every markdown file of the folder, in path order.
 *
 * A prototype with no requirement headings anywhere is a prototype whose requirements have not
 * been written yet — not an error, and the status report says so in those words. The documents
 * that carry no `## R-00x` heading are material the specification points at, and read as nothing
 * here.
 *
 * A file that is read twice (two documents claiming one id) is reported rather than resolved: which
 * of the two a reference meant is not something this can know, and guessing would make "which
 * requirement nothing implements" depend on the guess.
 */
export function readPrototypeRequirements(
  workspaceRootPath: string,
  slug: string,
): PrototypeRequirements {
  const files = listPrototypeFiles(workspaceRootPath, slug).filter((file) => isMarkdownFile(file.name))
  const requirements: PrototypeRequirement[] = []
  const issues: string[] = []
  const definedIn = new Map<string, string>()

  for (const file of files) {
    let source: string
    try {
      source = readFileSync(file.path, 'utf-8')
    } catch {
      // An unreadable document must not make the prototype unusable. Its absence from the report is
      // a fact about the disk, and the next read states it again.
      continue
    }

    const parsed = parseRequirementDocument(source, file.name)
    issues.push(...parsed.issues)

    for (const requirement of parsed.requirements) {
      const existing = definedIn.get(requirement.id)
      if (existing) {
        issues.push(
          `${requirement.id} is defined in both ${existing} and ${requirement.file}; a reference to it is ambiguous.`,
        )
        continue
      }
      definedIn.set(requirement.id, requirement.file)
      requirements.push(requirement)
    }
  }

  return { requirements, issues }
}
