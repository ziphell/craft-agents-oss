/**
 * Prototype file ownership.
 *
 * Parallel writers are made safe by **ownership**, not by locks: every artifact
 * path belongs to exactly one writer, and writers only communicate through files
 * they read but never write (plan §3.4/§3.5).
 *
 * This module makes that matrix executable, so violations are caught by tooling
 * instead of by a lost update at 2am.
 *
 * @see docs/prototype-workbench-plan.md §3.5
 */

import { readdirSync } from 'fs'
import { resolve, join } from 'path'
import { getPrototypeDirPath } from './storage.ts'
import { PROTOTYPE_PRD_FILENAME } from './requirements.ts'
import {
  CONSOLIDATED_WRITER,
  PROTOTYPE_ACCEPTANCE_DIRNAME,
  PROTOTYPE_ANCHORS_DIRNAME,
  PROTOTYPE_RESEARCH_DIRNAME,
  PROTOTYPE_REVIEWS_DIRNAME,
  parsePrototypePatchName,
} from './types.ts'

/**
 * Who may touch which path of a prototype (§3.4/§3.5).
 *
 * Ownership is a **path → owner** function, with three kinds of owner:
 * - a **declared writer identity** (from the name for patches, from the path rule for `services/`).
 *   The old five-letter vocabulary is gone: a writer id is whatever the graph declares, and the
 *   only reserved one is the consolidator (`Z`);
 * - the **control plane**, which is the agent itself — the page documents, the page table, the PRD,
 *   `assets/`, `research/` and `dist/`;
 * - a **tool**, for the artifacts that record what actually happened (`anchors/`). The agent may
 *   not hand-write those: a record it authored is not a record of anything (§3.5).
 *
 * Two rules, and they are different rules — which is why they are two functions rather than one:
 * - **may it be written at all** (`classifyPrototypePath`): every path has exactly one owner,
 *   and anything nobody owns is a violation. This is what `prototype-status` reports;
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

/** A page document of ours: a top-level `.html` (the page table names them; `_layout.html` is one of ours too). */
const PAGE_DOCUMENT_RE = /^[^/]+\.html?$/i

/**
 * Classify a prototype-relative path (always `/`-separated).
 *
 * Patch ownership is derived from the **writer id encoded in the file name** rather than a fixed
 * rule, because any writer may append its own patches — that is what makes patch writing
 * contention-free in the first place. Which directory a patch sits in decides the *page* it
 * changes, not who may write it (plan §19.4).
 */
export function classifyPrototypePath(relativePath: string): PrototypePathClassification {
  // Root-level control-plane files: the page table, and the documents the pages
  // are. Both are written by the control plane (the agent, on the human's behalf)
  // and read by the writers, so they are not writer-owned.
  if (relativePath === 'config.json' || PAGE_DOCUMENT_RE.test(relativePath)) {
    return { owner: { kind: 'control-plane' } }
  }

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

  if (relativePath.startsWith('dist/')) {
    return { owner: { kind: 'control-plane' } }
  }

  // The requirement set is the input the work is measured against, and `assets/` is the source of
  // the pages we own (a page's own css/js, and what a commit folded into). Both are the control
  // plane's, like the page documents themselves.
  if (relativePath === PROTOTYPE_PRD_FILENAME || relativePath.startsWith('assets/')) {
    return { owner: { kind: 'control-plane' } }
  }

  // Findings, frames and videos are ordinary files the agent writes: a finding *cites* its frames
  // rather than deriving a decision from them, so nothing breaks if one is written by hand.
  if (relativePath.startsWith(`${PROTOTYPE_RESEARCH_DIRNAME}/`)) {
    return { owner: { kind: 'control-plane' } }
  }

  // A dispute is the agent's own argument — it arrives the way a finding does, as a file in a
  // directory whose shape is the interface (`reviews.ts`).
  if (relativePath.startsWith(`${PROTOTYPE_REVIEWS_DIRNAME}/`)) {
    return { owner: { kind: 'control-plane' } }
  }

  // The anchor records are the opposite kind of artifact: `prototype-apply` writes them from what
  // actually matched, and the drift check compares them against the live page. A hand-written
  // record is what would make "it stopped matching" indistinguishable from "it never matched" —
  // the one distinction they exist to draw — so this is the direction the agent may not write.
  if (relativePath.startsWith(`${PROTOTYPE_ANCHORS_DIRNAME}/`)) {
    return { owner: { kind: 'tooling', by: 'prototype-apply' } }
  }

  // Same reasoning for the acceptance record: it says what the checks answered, so one written by
  // hand would be a report of a run that never happened.
  if (relativePath.startsWith(`${PROTOTYPE_ACCEPTANCE_DIRNAME}/`)) {
    return { owner: { kind: 'tooling', by: 'prototype-verify' } }
  }

  return { violation: 'unowned path' }
}

export interface WriterWriteCheck {
  ok: boolean
  owner: PrototypeOwner | null
  reason?: string
}

/**
 * May `writer` write `relativePath`?
 *
 * Writers must not write each other's files or control-plane outputs — a shared writer is the one
 * thing that breaks parallel work. Writer ids compare case-insensitively (the on-disk spelling is
 * the author's), and the consolidator is reserved: only the control plane writes `Z-…`, so an
 * agent writer putting that prefix in a patch name is overstepping (§3.4).
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
    return { ok: false, owner, reason: `"${CONSOLIDATED_WRITER}" is reserved for prototype-commit's folds` }
  }
  return { ok: true, owner }
}

/**
 * Why `writer` may not write this prototype-relative path, or `null` when it may.
 *
 * This is the guard **as the write path applies it**, and it is deliberately narrower than
 * `canWriterWrite`. The strict function refuses control-plane paths too, because every path has
 * exactly one owner — but *the control plane is the agent itself*: it writes the page documents,
 * the page table and `dist/`, and a prototype is built by writing those. Refusing them would
 * refuse the common case, not a collision. So what is enforced is the collision:
 *
 * - another writer's patch, contract file or fixture → refused, naming whose it is;
 * - a path no rule owns (a misnamed patch, a stray file in `services/`) → refused, because an
 *   artifact nobody owns is one the injector silently ignores;
 * - a control-plane path → allowed.
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
  /** Files that no writer or control-plane rule accepts. */
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
