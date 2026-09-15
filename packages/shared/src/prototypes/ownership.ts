/**
 * Prototype file ownership.
 *
 * Parallel lanes are made safe by **ownership**, not by locks: every artifact
 * path belongs to exactly one writer, and lanes only communicate through files
 * they read but never write (plan §3.3).
 *
 * This module makes that matrix executable, so violations are caught by tooling
 * instead of by a lost update at 2am.
 *
 * @see docs/prototype-workbench-plan.md §3.5
 */

import { readdirSync } from 'fs'
import { join } from 'path'
import { getPrototypeProjectPath } from './storage.ts'

/** Declared lanes, in the order the plan introduces them. */
export const PROTOTYPE_LANES = {
  A: 'UI / interaction (patches)',
  B: 'service contract (paths, config)',
  C: 'data (fixtures)',
  D: 'verification (read-only)',
} as const

export type PrototypeLaneId = keyof typeof PROTOTYPE_LANES

export function isPrototypeLane(value: string): value is PrototypeLaneId {
  return Object.prototype.hasOwnProperty.call(PROTOTYPE_LANES, value)
}

export type PrototypeOwner =
  | { kind: 'lane'; lane: PrototypeLaneId }
  | { kind: 'control-plane' }

export type PrototypePathClassification =
  | { owner: PrototypeOwner }
  | { violation: string }

/** `patches/{lane}-{nnn}-{name}.{css|js}` — the lane in the name is the owner. */
const PATCH_RE = /^patches\/([A-Za-z])-\d+-.+\.(css|js)$/

/**
 * Classify a prototype-relative path (always `/`-separated).
 *
 * Patch ownership is derived from the **lane encoded in the file name** rather
 * than a fixed rule, because any lane may append its own patches — that is what
 * makes patch writing contention-free in the first place.
 */
export function classifyPrototypePath(relativePath: string): PrototypePathClassification {
  // Root-level control-plane files: the base page, and the kind/target config.
  // Both are written by the control plane only, so they are not lane-owned.
  if (relativePath === 'base.html' || relativePath === 'config.json') {
    return { owner: { kind: 'control-plane' } }
  }

  const patch = PATCH_RE.exec(relativePath)
  if (patch) {
    const lane = (patch[1] ?? '').toUpperCase()
    if (!isPrototypeLane(lane)) {
      return {
        violation: `unknown lane prefix "${lane}" (known: ${Object.keys(PROTOTYPE_LANES).join(', ')})`,
      }
    }
    return { owner: { kind: 'lane', lane } }
  }
  if (relativePath.startsWith('patches/')) {
    return { violation: 'misnamed patch — expected {lane}-{nnn}-{name}.{css|js}' }
  }

  if (/^services\/[^/]+\/openapi\.ya?ml$/.test(relativePath)) {
    return { owner: { kind: 'control-plane' } }
  }
  if (/^services\/[^/]+\/fixtures\//.test(relativePath)) {
    return { owner: { kind: 'lane', lane: 'C' } }
  }
  if (/^services\/[^/]+\/paths\//.test(relativePath)) {
    return { owner: { kind: 'lane', lane: 'B' } }
  }
  if (/^services\/[^/]+\/config\.json$/.test(relativePath)) {
    return { owner: { kind: 'lane', lane: 'B' } }
  }
  if (relativePath.startsWith('services/')) {
    return { violation: 'unowned file inside a service directory' }
  }

  if (relativePath.startsWith('dist/')) {
    return { owner: { kind: 'control-plane' } }
  }

  return { violation: 'unowned path' }
}

export interface LaneWriteCheck {
  ok: boolean
  owner: PrototypeOwner | null
  reason?: string
}

/**
 * May `lane` write `relativePath`?
 *
 * Lanes must not write each other's files or control-plane outputs — a shared
 * writer is the one thing that breaks parallel work.
 */
export function canLaneWrite(relativePath: string, lane: PrototypeLaneId): LaneWriteCheck {
  const classified = classifyPrototypePath(relativePath)
  if ('violation' in classified) {
    return { ok: false, owner: null, reason: classified.violation }
  }

  const owner = classified.owner
  if (owner.kind === 'control-plane') {
    return { ok: false, owner, reason: 'owned by the control plane' }
  }
  if (owner.lane !== lane) {
    return { ok: false, owner, reason: `owned by lane ${owner.lane}` }
  }
  return { ok: true, owner }
}

export interface PrototypeOwnershipEntry {
  /** Path relative to the prototype project directory, `/`-separated. */
  path: string
  classification: PrototypePathClassification
}

export interface PrototypeOwnershipReport {
  /** Every inspected file with its classification. */
  entries: PrototypeOwnershipEntry[]
  /** Files that no declared lane or control-plane rule accepts. */
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

/** Classify every artifact file in a prototype project. */
export function resolvePrototypeOwnership(workspaceRootPath: string, slug: string): PrototypeOwnershipReport {
  const files = walkFiles(getPrototypeProjectPath(workspaceRootPath, slug)).sort()

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
