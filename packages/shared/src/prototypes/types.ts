/**
 * Prototype workbench artifact types.
 *
 * A prototype lives at `{workspaceRootPath}/prototypes/{slug}/` and is
 * made of ordinary files (`base.html` + `patches/`) so it stays git-diffable and
 * editable by the agent, the control plane, or an external editor.
 *
 * **This module imports nothing, on purpose.** It is the one part of the
 * prototypes family that a *renderer* can take a value from: the adjacent modules
 * reach `workspaces/storage.ts` → `config/storage.ts`, which lazy-imports the
 * agent runtime (`../agent/session-scoped-tools.ts`) and through it the Claude
 * Agent SDK — a node-only dependency that cannot be bundled for the browser. A
 * barrel import from the panel dragged all of that into the renderer build; a
 * plain constant from here cannot.
 *
 * @see docs/prototype-workbench-plan.md §4
 */

/** Which kind of prototype this is. Fixed at creation (plan §13.2). */
export type PrototypeKind = 'overlay' | 'scratch'

/**
 * What a prototype is when the caller does not say — both the kind
 * {@link createPrototype} falls back to, and what a missing or unreadable
 * `config.json` is assumed to mean.
 *
 * `scratch` is the default because it is the only kind that can never be
 * stillborn: it owns its document, so every state has a way forward (write
 * `base.html`, or import another prototype's page). An `overlay` without an
 * address has no page to open, no page to export against, and — since the kind
 * cannot be changed afterwards — no way out at all. Something with no way out
 * must be asked for, never assumed.
 */
export const DEFAULT_PROTOTYPE_KIND: PrototypeKind = 'scratch'

/** Patch kinds supported by the replay engine. */
export type PrototypePatchKind = 'css' | 'js'

/** One patch file plus the metadata derived from its name. */
export interface PrototypePatch {
  /** File name relative to the patches directory, e.g. `A-001-btn.css`. */
  file: string
  /** Kind inferred from the file extension. */
  kind: PrototypePatchKind
  /** Lane prefix parsed from the name (`A-001-…` → `A`), or null. */
  lane: string | null
  /** Replay order parsed from the name. */
  order: number
  /** File contents. */
  source: string
  /** Init-script key used when registering this patch with the browser. */
  key: string
}

/**
 * Derived index of a prototype's patches.
 *
 * Deliberately never hand-written: it is recomputed from disk on demand, so it
 * cannot drift and no writer has to coordinate on a shared single file.
 */
export interface PrototypeArtifacts {
  slug: string
  /** Absolute path to the prototype's directory. */
  dir: string
  /** Ordered patches, ready to replay. */
  patches: PrototypePatch[]
}
