/**
 * Artifacts — the files a person and an agent co-edit.
 *
 * An artifact is a **file on disk, found by scanning the workspace**: nothing
 * here keeps a list, a config or a sidecar. The two records that already exist —
 * the filesystem, and what the conversations wrote — are each turned into the
 * one question asked of them, by a pure function (`deriveArtifactEntries` for the
 * library, `deriveArtifactLinks` for the link back to the origin conversations).
 * Both are pure so the rule has exactly one home: the UI, the scan and any
 * thumbnail step read the same answer rather than each deciding for itself.
 */

/**
 * The kinds of file the library shows.
 *
 * Drawio is the first; another kind is added by widening `KIND_BY_EXTENSION` and
 * giving it an editor — never by changing this shape.
 */
export type ArtifactKind = 'drawio'

/** One file as the disk reports it — the input to `deriveArtifactEntries`. */
export interface ArtifactFileRef {
  /** Workspace-relative path, POSIX separators. */
  path: string
  /** Last modification time, epoch ms. */
  mtimeMs: number
}

/** One artifact as the library shows it. Everything is derived; nothing is stored. */
export interface ArtifactEntry {
  /** Workspace-relative path, POSIX separators — the artifact's identity. */
  path: string
  kind: ArtifactKind
  /** Display title: the file's own name, without the extension. */
  title: string
  mtimeMs: number
}

/** One conversation's write to one path — the input to `deriveArtifactLinks`. */
export interface ArtifactWriteEvent {
  sessionId: string
  /** Workspace-relative path, POSIX separators. */
  path: string
  /** When the write happened, epoch ms. */
  at: number
}

/** A conversation that touched an artifact, and when it last did. */
export interface ArtifactOrigin {
  sessionId: string
  at: number
}

/**
 * One artifact's preview: the file, drawn small.
 *
 * The SVG is carried as the engine drew it — the mark-up, not a path to a picture
 * — because there is no picture on disk: a preview is derived on demand and the only
 * thing the host keeps is an in-memory cache (`artifacts-thumbnails.ts`).
 */
export interface ArtifactThumbnail {
  /** A complete `<svg>` document, as drawio's own renderer produced it. */
  svg: string
}
