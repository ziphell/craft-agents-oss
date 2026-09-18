/**
 * Prototype file ownership.
 *
 * Ownership exists for **one** problem: two writers working on the same prototype at the
 * same time must not overwrite each other (plan §3.4/§3.5). So it speaks only about the
 * paths where that can happen — a patch, whose writer is the prefix in its file name, and
 * the contract's own files under `services/` — plus the records only a tool may author.
 *
 * Everything else is simply the author's folder. There is no matrix to keep in step with
 * the directory: enumerating every path shape would be a second description of the folder,
 * and a second description goes stale the moment the folder changes (see
 * {@link classifyPrototypePath}).
 *
 * @see docs/prototype-workbench-plan.md §3.5
 */

import { readdirSync } from 'fs'
import { resolve, join } from 'path'
import { getPrototypeDirPath } from './storage.ts'
import {
  CONSOLIDATED_WRITER,
  PROTOTYPE_ACCEPTANCE_DIRNAME,
  PROTOTYPE_ANCHORS_DIRNAME,
  parsePrototypePatchName,
} from './types.ts'

/**
 * Who may touch which path of a prototype (§3.4/§3.5).
 *
 * Ownership is a **path → owner** function, with three kinds of owner:
 * - a **declared writer identity** (from the name for patches, from the path rule for `services/`).
 *   The old five-letter vocabulary is gone: a writer id is whatever the graph declares, and the
 *   only reserved one is the consolidator (`Z`);
 * - the **control plane**, which is the agent itself — the page documents, the page table, the
 *   prototype's own files (the brief and the material beside it, any format), `assets/`,
 *   `research/` and `dist/`;
 * - a **tool**, for the artifacts that record what actually happened (`anchors/`, `acceptance/`).
 *   The agent may not hand-write those: a record it authored is not a record of anything (§3.5).
 *
 * Two rules, and they are different rules — which is why they are two functions rather than one:
 * - **may it be written at all** (`classifyPrototypePath`): the paths with a rule of their own
 *   resolve to their owner, and a path that breaks its own rule is a violation. Everything else
 *   is the author's folder and resolves to the control plane. This is what `status`
 *   reports;
 * - **may *this* writer write it** (`canWriterWrite`): the guard, which refuses with a reason
 *   the agent can act on.
 *
 * The reason is a string rather than a boolean because the answer is always "no, because …",
 * and the agent is the reader (§3.6).
 */

/**
 * Writer ids the **path rules** assign. These are not a vocabulary to pick from: a path rule is
 * itself the declaration, so `services/{svc}/paths/*` belongs to `contract` and the fixtures to
 * `data` no matter who is running. Patches get their writer from the file name instead.
 */
export const PROTOTYPE_PATH_WRITERS = {
  contract: 'services/{svc}/paths/*, services/{svc}/config.json',
  data: 'services/{svc}/fixtures/*, services/{svc}/state.json',
} as const

export type PrototypePathWriterId = keyof typeof PROTOTYPE_PATH_WRITERS

export type PrototypeOwner =
  | { kind: 'writer'; writer: string }
  | { kind: 'control-plane' }
  /**
   * Written by a tool, from what actually happened — never by the agent. The distinction from
   * `control-plane` is the point: the agent *is* the control plane, so it may write those files,
   * while a record of a match it did not make is not something it may author.
   */
  | { kind: 'tooling'; by: string }

export type PrototypePathClassification =
  | { owner: PrototypeOwner }
  | { violation: string }

/**
 * Classify a prototype-relative path (always `/`-separated).
 *
 * **Only the paths with a rule of their own are named.** Patch ownership is derived from the
 * writer id encoded in the file name rather than a fixed rule, because any writer may append
 * its own patches — that is what makes patch writing contention-free in the first place; which
 * directory a patch sits in decides the *page* it changes, not who may write it (plan §19.4).
 *
 * Everything else falls through to the control plane, deliberately. The prototype folder is a
 * **collection of the author's files** — the pages, the page table, the brief and whatever sits
 * beside it in whatever format, `assets/`, `research/`, `reviews/`, `dist/`, and any directory
 * nobody has heard of — and listing every shape here would be a second description of that
 * folder. A second description goes stale the moment the folder changes: one did, and it made
 * the report say every prototype with a brief was violating something. What is worth reporting
 * is a file that will not do what its author meant — a patch the injector ignores, a stray file
 * inside a service directory — and both of those are named above.
 */
export function classifyPrototypePath(relativePath: string): PrototypePathClassification {
  if (relativePath.startsWith('patches/')) {
    const rest = relativePath.slice('patches/'.length)
    const segments = rest.split('/')
    // One level of nesting at most: `patches/<page>/<file>`, or `patches/<file>`.
    const file = segments.length === 1 ? segments[0]! : segments.length === 2 ? segments[1]! : ''
    const page = segments.length === 2 ? segments[0]! : null
    // Nested deeper than a page, or sitting in a hidden directory: there is no file to read a
    // writer id from, so it fails the same way a badly named one does.
    const readable = file !== '' && (page === null || (page !== '' && !page.startsWith('.')))
    const name = readable ? parsePrototypePatchName(file) : null
    if (!name) {
      return { violation: 'misnamed patch — expected {writer}-{nnn}-{name}.{css|js}, optionally under patches/<page>/' }
    }
    return { owner: { kind: 'writer', writer: name.writer } }
  }

  if (/^services\/[^/]+\/openapi\.ya?ml$/.test(relativePath)) {
    return { owner: { kind: 'control-plane' } }
  }
  if (/^services\/[^/]+\/fixtures\//.test(relativePath)) {
    return { owner: { kind: 'writer', writer: 'data' } }
  }
  // The mock's starting state is data in the same sense the fixtures are: the
  // contract writer declares what a route reads and writes, this file is what it
  // reads on the first request.
  if (/^services\/[^/]+\/state\.json$/.test(relativePath)) {
    return { owner: { kind: 'writer', writer: 'data' } }
  }
  if (/^services\/[^/]+\/paths\//.test(relativePath)) {
    return { owner: { kind: 'writer', writer: 'contract' } }
  }
  if (/^services\/[^/]+\/config\.json$/.test(relativePath)) {
    return { owner: { kind: 'writer', writer: 'contract' } }
  }
  if (relativePath.startsWith('services/')) {
    return { violation: 'unowned file inside a service directory' }
  }

  // The anchor records are the opposite kind of artifact: `apply` writes them from what
  // actually matched, and the drift check compares them against the live page. A hand-written
  // record is what would make "it stopped matching" indistinguishable from "it never matched" —
  // the one distinction they exist to draw — so this is the direction the agent may not write.
  if (relativePath.startsWith(`${PROTOTYPE_ANCHORS_DIRNAME}/`)) {
    return { owner: { kind: 'tooling', by: 'apply' } }
  }

  // Same reasoning for the acceptance record: it says what the checks answered, so one written by
  // hand would be a report of a run that never happened.
  if (relativePath.startsWith(`${PROTOTYPE_ACCEPTANCE_DIRNAME}/`)) {
    return { owner: { kind: 'tooling', by: 'verify' } }
  }

  // Everything else is the author's own folder — see the note above. No rule to state, and
  // nothing to report.
  return { owner: { kind: 'control-plane' } }
}

export interface WriterWriteCheck {
  ok: boolean
  owner: PrototypeOwner | null
  reason?: string
}

/**
 * May `writer` write `relativePath`?
 *
 * The strict reading: a writer may write its own patches and the service files its path rule
 * declares, and nothing else. Deliberately narrower than reality — everything that is neither is
 * the control plane's, and the control plane *is* the agent — so the guard that runs on a write is
 * {@link whyWriterMayNotWrite}, which drops that case and keeps the collision.
 *
 * Writer ids compare case-insensitively (the on-disk spelling is the author's), and the
 * consolidator is reserved: only the control plane writes `Z-…`, so an agent writer putting that
 * prefix in a patch name is overstepping (§3.4).
 */
export function canWriterWrite(relativePath: string, writer: string): WriterWriteCheck {
  const classified = classifyPrototypePath(relativePath)
  if ('violation' in classified) {
    return { ok: false, owner: null, reason: classified.violation }
  }

  const owner = classified.owner
  if (owner.kind === 'control-plane') {
    return { ok: false, owner, reason: 'owned by the control plane' }
  }
  if (owner.kind === 'tooling') {
    return { ok: false, owner, reason: `written by ${owner.by}, from what actually happened` }
  }
  if (owner.writer.toLowerCase() !== writer.toLowerCase()) {
    return {
      ok: false,
      owner,
      reason: `owned by writer "${owner.writer}", and this session writes as "${writer}"`,
    }
  }
  if (owner.writer.toUpperCase() === CONSOLIDATED_WRITER) {
    return { ok: false, owner, reason: `"${CONSOLIDATED_WRITER}" is reserved for a prototype's folded changes` }
  }
  return { ok: true, owner }
}

/**
 * Why `writer` may not write this prototype-relative path, or `null` when it may.
 *
 * This is the guard **as the write path applies it**, and it is deliberately narrower than
 * `canWriterWrite`. The strict function refuses control-plane paths too, since everything the
 * folder does not put a rule on belongs to the control plane by default — but *the control plane
 * is the agent itself*: it writes the pages, the page table, the brief and `dist/`, and a
 * prototype is built by writing those. Refusing them would refuse the common case, not a
 * collision. So what is enforced is the collision:
 *
 * - another writer's patch, contract file or fixture → refused, naming whose it is;
 * - a file that will not do what its author meant — a misnamed patch, a stray file inside
 *   `services/` (the injector and the contract reader ignore both, silently) → refused;
 * - anything else the author put in the folder → allowed, because it is theirs.
 *
 * The phrasing (reason-first, no boolean) is deliberate: the reader is the agent, and "no"
 * without a why is a dead end (§3.6, same shape as `whyTabIsOutOfReach`).
 */
export function whyWriterMayNotWrite(relativePath: string, writer: string): string | null {
  const check = canWriterWrite(relativePath, writer)
  if (check.ok) return null
  if (check.owner?.kind === 'control-plane') return null

  const advice =
    check.owner === null
      ? `Everything inside a prototype is structured: name patches \`${writer}-<nnn>-<name>.{css,js}\` under patches/, or put the file where its owner keeps it.`
      : check.owner.kind === 'tooling'
        ? `It is not an input to write — re-run ${check.owner.by} and let it write the record.`
        : `Write your own artifacts instead: your patches are named \`${writer}-<nnn>-<name>.{css,js}\` under patches/, and that prefix is your identity — it is what keeps concurrent writers from overwriting each other.`

  return `Writing ${relativePath} as "${writer}" is refused: ${check.reason}. ${advice}`
}

/** A path inside a prototype, as the ownership rules see it. */
export interface PrototypeArtifactPath {
  slug: string
  /** Relative to the prototype directory, `/`-separated. */
  relativePath: string
}

/**
 * Which prototype a file path belongs to, and where it sits inside it.
 *
 * Only `prototypes/<slug>/<rest>` is a prototype artifact. Anything else — another workspace
 * directory, the prototypes root itself, a slug-less file — is not, and `null` says the guard has
 * no opinion about it rather than guessing. `..` is resolved away first, so a path cannot claim to
 * be inside a prototype it climbs out of.
 */
export function resolvePrototypeArtifactPath(
  prototypesRootPath: string,
  filePath: string,
): PrototypeArtifactPath | null {
  const root = `${resolve(prototypesRootPath).replace(/\\/g, '/').replace(/\/+$/, '')}/`
  const target = resolve(filePath).replace(/\\/g, '/')
  if (!target.startsWith(root)) return null

  const rest = target.slice(root.length)
  const separator = rest.indexOf('/')
  if (separator <= 0) return null

  const slug = rest.slice(0, separator)
  const relativePath = rest.slice(separator + 1)
  if (slug.startsWith('.') || relativePath === '') return null
  return { slug, relativePath }
}

export interface PrototypeOwnershipEntry {
  /** Path relative to the prototype directory, `/`-separated. */
  path: string
  classification: PrototypePathClassification
}

export interface PrototypeOwnershipReport {
  /** Every inspected file with its classification. */
  entries: PrototypeOwnershipEntry[]
  /** Files that break a rule of their own — a misnamed patch, a stray file in a service directory. */
  violations: Array<{ path: string; reason: string }>
  inspected: number
}

function walkFiles(root: string, prefix = ''): string[] {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }

  const out: string[] = []
  for (const entry of entries) {
    // Hidden files are editor/system noise, not artifacts.
    if (entry.name.startsWith('.')) continue
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      out.push(...walkFiles(join(root, entry.name), rel))
    } else {
      out.push(rel)
    }
  }
  return out
}

/** Classify every artifact file in a prototype. */
export function resolvePrototypeOwnership(workspaceRootPath: string, slug: string): PrototypeOwnershipReport {
  const files = walkFiles(getPrototypeDirPath(workspaceRootPath, slug)).sort()

  const entries: PrototypeOwnershipEntry[] = []
  const violations: Array<{ path: string; reason: string }> = []

  for (const path of files) {
    const classification = classifyPrototypePath(path)
    entries.push({ path, classification })
    if ('violation' in classification) {
      violations.push({ path, reason: classification.violation })
    }
  }

  return { entries, violations, inspected: files.length }
}
