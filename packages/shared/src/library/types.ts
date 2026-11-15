/**
 * The asset library: which files a project has, and what people and agents say about them.
 *
 * Two facts live in two places on purpose:
 *
 * - **Which assets exist** is read from the folder, every time. Nothing in this file lists them.
 * - **What they mean** — tags, a note — is a small index beside the project's assets. An entry
 *   never asserts that its file exists.
 *
 * That split is what makes the library safe to hand to a second writer. A person can drop a file
 * in, rename one, or delete one with Explorer open; the next read shows the new file untagged and
 * simply forgets the missing one instead of reporting damage. Only the meaning is stored, and only
 * meaning can go stale.
 */

import type { GenerationRecord } from '../provenance/types.ts'

export type AssetKind = 'text' | 'image' | 'video' | 'audio' | 'other'

/**
 * What the asset is right now.
 *
 * A path is the asset's identity; the file is only the current state of that path:
 *
 * - `pending` — a generation task is queued or running;
 * - `ready` — the file is on disk;
 * - `failed` — the task ended without an artifact;
 * - `missing` — a record exists (a generation note, a task, or a board layout), but no file.
 */
export type AssetStatus = 'pending' | 'ready' | 'failed' | 'missing'

/**
 * Where a card sits on the asset board, in canvas pixels.
 *
 * Stored beside the asset's tags and note, in the same index entry, because the board is a view of
 * the library rather than a second document. Absent size means "size from the media".
 */
export interface AssetLayout {
  x: number
  y: number
  w?: number
  h?: number
  z?: number
  /** Last move, epoch ms. */
  at?: number
  /**
   * Taken off the board.
   *
   * The file stays an asset and keeps its place, so the card can be put back where it was; the
   * canvas simply does not draw it. Without this flag "no layout" can only mean "not placed yet",
   * which is why removing a card used to make it reappear on the automatic shelf.
   */
  hidden?: boolean
}

/** A task that may produce an asset at `path`; the library reads it without owning it. */
export interface AssetTaskInfo {
  /** Project-relative path the task will write. */
  path: string
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'submission_unknown'
  updatedAt: number
  /**
   * Whether stopping it is real. A queued task can always be dropped; once submitted, only a
   * provider that declared a cancel endpoint can be stopped — the others keep working.
   */
  cancellable?: boolean
}

/** Who touched an entry last. The library is written by people and by agents, so this is shown. */
export type AssetAuthor = 'human' | 'agent'

export interface LibraryEntry {
  /** Free-form. A `dimension:value` tag (`角色:小美`) is how a facet is expressed. */
  tags: string[]
  note?: string
  by?: AssetAuthor
  at?: number
  /** The card's place on the board. An entry with only a layout is still a board record. */
  layout?: AssetLayout
}

export interface LibraryDoc {
  schemaVersion: 1
  /**
   * Keyed by a project-relative path with `/` (`assets/photo.png`).
   *
   * The same shape `data.src` uses on a canvas, so both can point at one file without a second
   * spelling for it.
   */
  entries: Record<string, LibraryEntry>
}

/** What the folder says about a file. Read from disk; never persisted in the index. */
export interface AssetFileInfo {
  /** Project-relative path with `/`. */
  path: string
  sizeBytes: number
  modifiedAt: number
}

/**
 * An asset record: a path, what it is now, and what people said about it.
 *
 * `sizeBytes` and `modifiedAt` are 0 when the file is not present; `status` is the honest answer
 * to "is there a file?" — the record does not disappear just because the file did.
 */
export interface LibraryAsset extends AssetFileInfo {
  name: string
  kind: AssetKind
  status: AssetStatus
  /** For a pending/failed card: whether the provider can actually be stopped. */
  cancellable?: boolean
  tags: string[]
  note: string
  /**
   * What made this file, read from the note beside it. An upload or a hand-made file has none —
   * the library does not invent a source it cannot prove.
   */
  source?: GenerationRecord
  /** The card's place on the board, when one has been written. */
  layout?: AssetLayout
}

export interface TagFacet {
  /** The part before the first `:`. Empty for a plain tag. */
  dimension: string
  values: string[]
}

/**
 * The library index, beside the files it describes: `<contentRoot>/assets/.index.json`.
 *
 * A dotfile inside `assets/` for two reasons — `scanAssets` skips dot entries, so the index is
 * never listed as an asset, and a person browsing the folder does not see it. The filesystem's
 * own atomic-write temp names are dot-prefixed too, so a write never flashes as an asset.
 */
export const LIBRARY_FILE_NAME = '.index.json'
export const LIBRARY_SCHEMA_VERSION = 1

export const emptyLibraryDoc = (): LibraryDoc => ({
  schemaVersion: LIBRARY_SCHEMA_VERSION,
  entries: {},
})
