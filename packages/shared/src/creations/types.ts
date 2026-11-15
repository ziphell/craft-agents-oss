/**
 * Creations — the works an agent produced, **derived rather than registered**.
 *
 * A creation is not stored anywhere. It is the intersection of two things that already exist:
 *
 * - **the transcript** — every tool call is persisted with its full arguments, so "which file did
 *   this turn write" is a fact already on disk (`sessions/<id>/session.jsonl`);
 * - **the filesystem** — whether that file is still there, how big it is, when it changed.
 *
 * So the index below is a *cache*, not a source of truth: throw it away and it rebuilds itself.
 *
 * The consequence worth remembering: **provenance is retroactive.** A registry only knows about
 * files written after it shipped; a transcript scan knows about everything that ever ran.
 */

/**
 * Bumped when a field changes meaning **or when the filter does**, so a cache built under the old
 * rules is discarded rather than reused: a session already parsed would otherwise keep contributing
 * hits the new rules would never have taken.
 */
/**
 * Version 5 added `projectSlugs` — a field the index now has to earn, since a cached session's
 * entries are what the projects are folded out of. A cache built before it would answer every
 * work with "in no project", which is the one wrong answer this dimension must not give.
 *
 * Version 6 admits **generated media** (a picture, clip or recording a tool named as its output,
 * or one with a `.gen.json` note beside it). A session cached under version 5 has already dropped
 * those calls, so it must be parsed again rather than trusted.
 *
 * Version 7 keeps **cuts** out of the library: a `.reel` belongs to its project's panel, not to
 * "what this turn produced", so any cached entry that took one is discarded.
 */
export const CREATIONS_INDEX_VERSION = 7

/** What kind of document a creation is. Drives the badge and which host opens it. */
export type CreationFormat =
  | 'md'
  | 'html'
  | 'drawio'
  | 'docx'
  | 'xlsx'
  | 'pptx'
  | 'pdf'
  | 'image'
  | 'video'
  | 'audio'
  | 'csv'
  | 'json'
  | 'text'

/**
 * Where the file lives, which is also **how much it is worth showing**.
 *
 * - `session` — the session's own folder (`data/`, `plans/`, `downloads/`): the agent's output.
 * - `project` — a project's folder: documents that belong to the work, not to one conversation.
 * - `source` — inside the workspace's machinery (sources, skills, tweaks) or a code
 *   checkout: files an agent *edited*, almost never something it *made* for a person.
 * - `external` — outside the workspace entirely (a repo elsewhere, a temp dir).
 */
export type CreationPlace = 'session' | 'project' | 'source' | 'external'

/** One tool call that touched the file. Oldest first; the last one is the most recent. */
export interface CreationOrigin {
  sessionId: string
  /** The session's own title, so a card can say "加号按钮命令整合" instead of a slug. */
  sessionName: string | null
  /** The message to jump to when the origin is clicked. */
  messageId: string
  turnId: string | null
  at: number
  /** The tool that named the path — `Write`, `office_tool`, `drawio_tool`, … */
  tool: string
  /** `created` when the tool produced the file, `modified` when it changed one that existed. */
  role: 'created' | 'modified'
}

/** A document an agent produced, as the library shows it. */
export interface Creation {
  /** The normalized absolute path — the file is its own identity. */
  id: string
  path: string
  /** The file name, which is what a person recognises. */
  title: string
  format: CreationFormat
  place: CreationPlace
  /** The project folder the file sits in, when it sits in one (a slug, not an id). */
  projectSlug: string | null
  /**
   * The projects this work belongs to, by slug — the answer the library's project filter asks.
   *
   * Two existing facts, folded together, never a binding of its own: the project whose **folder**
   * holds the file, and the projects whose **conversations** wrote it (an origin's `sessionId` →
   * that session's `projectId`). A work can be in two projects, and one that sits in no project
   * folder but came out of a project's conversation is listed under it — which is the common case,
   * because an agent writes into `sessions/<id>/`, not into the project root.
   *
   * Empty when neither fact holds: a work made in a conversation that belongs to no project.
   */
  projectSlugs: string[]
  /** Size in bytes; `0` when the file is gone. */
  bytes: number
  mtimeMs: number
  /** False once the file has been deleted or moved — the card stays, greyed. */
  exists: boolean
  /** Newest last. Never empty: a creation exists because something named it. */
  origins: CreationOrigin[]
  /** The newest origin, unwrapped for sorting and for the card's one-line provenance. */
  last: CreationOrigin
  /** True when the newest touch came from a tool that names an output (`--out`, `export --to`). */
  explicit: boolean
}

/** What one scan saw, for the empty state and for tests. */
export interface CreationsScanStats {
  sessions: number
  /** Session files parsed this run; the rest came from the cache unchanged. */
  parsed: number
  toolRecords: number
  /** Paths found in transcripts, before filtering. */
  hits: number
  /** Distinct files worth showing. */
  shown: number
  /** Distinct files filtered out (source trees, machinery, gone). */
  hidden: number
  /** Files found on disk that no tool call named — attributed by the folder they sit in. */
  discovered: number
}

export interface CreationsSnapshot {
  generatedAt: number
  workspaceRootPath: string
  stats: CreationsScanStats
  creations: Creation[]
}

/** Options a caller can pass through the RPC. */
export interface CreationsQuery {
  /** Include files that no longer exist (deleted, moved, renamed). Default false. */
  includeMissing?: boolean
  /**
   * Also show `source`-placed files — the ones an agent edited inside a code checkout or the
   * workspace's own machinery. Off by default: on, the library becomes a second file browser.
   */
  includeSources?: boolean
}
