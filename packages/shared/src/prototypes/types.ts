/**
 * Prototype workbench artifact types.
 *
 * A prototype project lives at `{workspaceRootPath}/prototypes/{slug}/` and is
 * made of ordinary files (`base.html` + `patches/`) so it stays git-diffable and
 * editable by the agent, the control plane, or an external editor.
 *
 * @see docs/prototype-workbench-plan.md §4
 */

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
 * Derived index of a prototype project's patches.
 *
 * Deliberately never hand-written: it is recomputed from disk on demand, so it
 * cannot drift and no writer has to coordinate on a shared single file.
 */
export interface PrototypeArtifacts {
  slug: string
  /** Absolute path to the project directory. */
  dir: string
  /** Ordered patches, ready to replay. */
  patches: PrototypePatch[]
}
