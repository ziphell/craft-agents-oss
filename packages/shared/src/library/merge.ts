/**
 * Merging the folder with the index.
 *
 * Everything here is a pure function of what the disk said and what the index said. That is the
 * whole point of the split: the list of assets can be rebuilt at any moment from the folder alone,
 * and a lost or unreadable index costs tags, never files.
 */

import { generationOf } from '../provenance/graph.ts'
import type { GenerationRecord } from '../provenance/types.ts'
import type {
  AssetFileInfo,
  AssetKind,
  AssetStatus,
  AssetTaskInfo,
  LibraryAsset,
  LibraryDoc,
  TagFacet,
} from './types.ts'

/** Extensions decide a kind. A kind that is not listed is `other`, never a reason to hide a file. */
const KIND_BY_EXTENSION: ReadonlyArray<readonly [AssetKind, ReadonlySet<string>]> = [
  // Subtitles are text: a transcript written as .srt should be readable on the board, not a
  // generic file icon. JSON stays `other` — it is data, and a Markdown view of it helps nobody.
  ['text', new Set(['md', 'mdx', 'txt', 'srt', 'vtt'])],
  ['image', new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp'])],
  ['video', new Set(['mp4', 'webm', 'mov', 'm4v', 'mkv'])],
  ['audio', new Set(['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus'])],
]

const extensionOf = (path: string): string => {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export function kindOfPath(path: string): AssetKind {
  const extension = extensionOf(path)
  for (const [kind, extensions] of KIND_BY_EXTENSION) {
    if (extensions.has(extension)) return kind
  }
  return 'other'
}

/**
 * One tag, as it is stored.
 *
 * Trimming and dropping the empty string are the only repairs made: a tag is the author's word,
 * and `#角色` and `角色` are the same word typed twice. Anything else — case, punctuation,
 * Chinese/English — is kept exactly as written.
 */
export function normalizeTag(tag: string): string | null {
  const cleaned = tag.trim().replace(/^#+/, '').replace(/\s+/g, ' ')
  if (!cleaned) return null
  return cleaned.slice(0, 64)
}

/** Tags in the author's order, without repeats. */
export function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of tags) {
    const tag = normalizeTag(raw)
    if (!tag || seen.has(tag)) continue
    seen.add(tag)
    result.push(tag)
  }
  return result
}

/** The dimension of a tag: everything before the first `:`, or `''` for a plain tag. */
export function dimensionOf(tag: string): string {
  const at = tag.indexOf(':')
  return at > 0 ? tag.slice(0, at) : ''
}

/**
 * The files on disk, annotated by the index.
 *
 * Order is newest first, then by path: a library opens on what was just made. An index entry with
 * no file is not an error and is not returned — the index does not get to assert existence.
 */
export function mergeLibrary(
  files: readonly AssetFileInfo[],
  doc: LibraryDoc,
  records: readonly GenerationRecord[] = [],
): LibraryAsset[] {
  return [...files]
    .sort((a, b) => b.modifiedAt - a.modifiedAt || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((file) => {
      const entry = doc.entries[file.path]
      const source = generationOf(records, file.path)
      return {
        ...file,
        name: file.path.slice(file.path.lastIndexOf('/') + 1),
        kind: kindOfPath(file.path),
        status: 'ready' as const,
        tags: entry?.tags ?? [],
        note: entry?.note ?? '',
        ...(entry?.layout ? { layout: entry.layout } : {}),
        ...(source ? { source } : {}),
      }
    })
}

export interface AssetRegistryInput {
  /** Files on disk, as `scanAssets` found them. */
  files: readonly AssetFileInfo[]
  /** The index: tags, notes, layouts, and board records for paths without files. */
  doc: LibraryDoc
  /** Generation notes, including ones whose artifact is gone. */
  records?: readonly GenerationRecord[]
  /** Generation tasks, including pending and failed ones. */
  tasks?: readonly AssetTaskInfo[]
}

/**
 * The asset registry: a path is an asset when **any** of its records says so.
 *
 * A file is one state of a path, not the proof that the path is an asset. A path qualifies when it
 * has a file, a generation note, a task, or a board layout; its `status` then says which of those
 * is true right now. Index entries with only tags or a note stay dormant (the old "the index never
 * asserts existence" rule), which is why a deleted file does not resurrect its tags.
 *
 * Status precedence: an active task is `pending`; a file is `ready`; a terminal task without a
 * file is `failed`; everything else with a record is `missing`.
 */
export function mergeRegistry({ files, doc, records = [], tasks = [] }: AssetRegistryInput): LibraryAsset[] {
  const filesByPath = new Map(files.map((file) => [file.path, file]))
  const recordsByPath = new Map(records.map((record) => [record.file, record]))
  const tasksByPath = new Map(tasks.map((task) => [task.path, task]))

  const paths = new Set<string>()
  for (const file of files) paths.add(file.path)
  for (const record of records) paths.add(record.file)
  for (const task of tasks) paths.add(task.path)
  for (const [path, entry] of Object.entries(doc.entries)) {
    if (entry.layout) paths.add(path)
  }

  const statusOf = (file: AssetFileInfo | undefined, task: AssetTaskInfo | undefined): AssetStatus => {
    if (task?.status === 'queued' || task?.status === 'running' || task?.status === 'submission_unknown') {
      return 'pending'
    }
    if (file) return 'ready'
    if (task?.status === 'failed' || task?.status === 'cancelled') return 'failed'
    return 'missing'
  }

  return [...paths]
    .map((path) => {
      const file = filesByPath.get(path)
      const record = recordsByPath.get(path)
      const task = tasksByPath.get(path)
      const entry = doc.entries[path]
      const modifiedAt = file?.modifiedAt ?? task?.updatedAt ?? record?.at ?? entry?.at ?? 0
      return {
        path,
        sizeBytes: file?.sizeBytes ?? 0,
        modifiedAt,
        name: path.slice(path.lastIndexOf('/') + 1),
        kind: kindOfPath(path),
        status: statusOf(file, task),
        ...(task?.cancellable !== undefined ? { cancellable: task.cancellable } : {}),
        tags: entry?.tags ?? [],
        note: entry?.note ?? '',
        ...(entry?.layout ? { layout: entry.layout } : {}),
        ...(record ? { source: record } : {}),
      }
    })
    .sort((a, b) => b.modifiedAt - a.modifiedAt || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/**
 * The facets a person can filter by, built from the tags that actually exist.
 *
 * No taxonomy is declared anywhere: a library with `角色:小美` and `场景:办公室` gets two facets
 * because two dimensions were written, and a library with none gets none. Adding a dimension is a
 * tagging decision, not a code change.
 */
export function tagFacets(assets: readonly LibraryAsset[]): TagFacet[] {
  const byDimension = new Map<string, Set<string>>()
  for (const asset of assets) {
    for (const tag of asset.tags) {
      const dimension = dimensionOf(tag)
      const values = byDimension.get(dimension) ?? new Set<string>()
      values.add(dimension ? tag.slice(dimension.length + 1) : tag)
      byDimension.set(dimension, values)
    }
  }

  return [...byDimension.entries()]
    .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a < b ? -1 : 1))
    .map(([dimension, values]) => ({ dimension, values: [...values].sort() }))
}
