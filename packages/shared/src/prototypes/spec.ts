/**
 * Prototype specs — the specification, one file per spec.
 *
 * The one thing the person handed the work has to judge is *what problem was being solved*. A
 * delivery without that is something to copy rather than something to agree with, so this module is
 * the difference between a prototype tool and a spec workbench.
 *
 * A spec is **a file**, named `<name>.spec.md` — one file, one spec — and the file's name is its
 * identity. There is no id: the file *is* the name a spec is referred to by, so nothing has to stay
 * in sync with anything, and the file travels wherever the folder does. The file's **first markdown
 * heading** is its title (its own file name when it has none), and the rest of the file is the
 * spec's prose. `spec.md` is the conventional entry — what `create` seeds — but it is an **index**,
 * not a spec: its name does not end in `.spec.md`, so it states nothing on its own.
 *
 * What is *not* a spec is everything else: a research report, `notes.md`, a `README.md`, an image, a
 * script, a CSV. Being markdown is **not** the test any more — the name is — so a document that
 * merely mentions a spec in a sentence is material like any other.
 *
 * The documents are deliberately **not** in a stored index. They are prose the agent writes as
 * files, and parsing them here is what keeps them documents people can read rather than a form they
 * have to fill in.
 *
 * What this module deliberately does **not** do any more is read acceptance out of the documents:
 * `check:` is not a concept here, so a line that says `check: …` is ordinary prose under its spec —
 * nothing parses it, nothing reports it, and there is no kind to give it.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { getPrototypeDirPath, listPrototypeFiles } from './storage.ts'
import { PROTOTYPE_ENTRY_FILENAME, isSpecFile } from './types.ts'

/** Absolute path to the prototype's conventional entry document (`spec.md`). */
export function getPrototypeEntryPath(workspaceRootPath: string, slug: string): string {
  return join(getPrototypeDirPath(workspaceRootPath, slug), PROTOTYPE_ENTRY_FILENAME)
}

/** One spec of the specification, as its own document states it. */
export interface PrototypeSpec {
  /**
   * The `.spec.md` file's prototype-relative path — `cart-total.spec.md`, `docs/checkout.spec.md`.
   * This is the spec's identity: there is no id, and every reference to a spec is this path.
   */
  file: string
  /** The document's first heading, or its own file name when it has none. */
  title: string
  /**
   * The document minus its title line, trimmed. An empty body is a spec whose prose has not been
   * written yet — reported, not hidden.
   */
  body: string
}

export interface PrototypeSpecs {
  /** In reading order: file path order. One entry per `.spec.md` file. */
  specs: PrototypeSpec[]
  /**
   * Read problems. One thing can be said here: a `*.spec.md` that could not be read. That must be
   * said rather than skipped — a spec that vanishes from the report is a spec nobody implements,
   * and its file being unreadable is exactly how one would vanish. There is no cross-file collision
   * to report, now that a spec *is* a file rather than an id.
   */
  issues: string[]
}

/** The first markdown heading line — `# Title`, any depth. */
const HEADING_RE = /^#{1,6}\s+(.*)$/

/**
 * Read the one spec a `*.spec.md` document states.
 *
 * The document does exactly two things here: its **first heading** is the spec's title (its own
 * file name when it has no heading at all — the name *is* the spec's identity, so it is shown as it
 * stands rather than dressed up as a title), and everything else — the file minus that one title
 * line — is the spec's prose, trimmed. A `check: …` line is prose like any other.
 */
export function parseSpecDocument(source: string, file: string): PrototypeSpec {
  const lines = source.split('\n')
  const headingIndex = lines.findIndex((line) => HEADING_RE.test(line.trim()))

  if (headingIndex === -1) {
    return { file, title: file, body: source.trim() }
  }

  const heading = HEADING_RE.exec(lines[headingIndex]!.trim())
  const title = (heading?.[1] ?? '').trim()
  const body = [...lines.slice(0, headingIndex), ...lines.slice(headingIndex + 1)].join('\n').trim()

  return { file, title: title || file, body }
}

/**
 * Read a prototype's specs — every `*.spec.md` file of the folder, in path order.
 *
 * One file is one spec, so there is nothing to open and close within a document and no id to
 * collide: the files that end in `.spec.md` are the specs, and everything else in the folder is
 * material the specification points at. A prototype with no `*.spec.md` file is a prototype whose
 * specs have not been written yet — not an error, and the status report says so.
 */
export function readPrototypeSpecs(
  workspaceRootPath: string,
  slug: string,
): PrototypeSpecs {
  const files = listPrototypeFiles(workspaceRootPath, slug).filter((file) => isSpecFile(file.name))
  const specs: PrototypeSpec[] = []
  const issues: string[] = []

  for (const file of files) {
    let source: string
    try {
      source = readFileSync(file.path, 'utf-8')
    } catch {
      // A document that cannot be read is said out loud, not passed over: it *is* a spec, and
      // dropping it quietly would leave the report claiming less work than the folder holds.
      issues.push(`${file.name}: this document could not be read.`)
      continue
    }

    specs.push(parseSpecDocument(source, file.name))
  }

  return { specs, issues }
}
