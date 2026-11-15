/**
 * The index as a file.
 *
 * Parsing is lenient about what it can simply ignore and strict about what it cannot: an entry that
 * is not an object, or a tag list that is not a list of strings, is dropped with a message. It is
 * not silently repaired and it is not written back — a caller that changes the library writes a
 * fresh document, so a damaged file stays damaged until somebody deliberately replaces it.
 *
 * A missing file is not an error: an empty library is the normal first state.
 */

import {
  emptyLibraryDoc,
  LIBRARY_SCHEMA_VERSION,
  type AssetLayout,
  type LibraryDoc,
  type LibraryEntry,
} from './types.ts'

export type LibraryFileReadResult =
  | { ok: true; doc: LibraryDoc }
  | { ok: false; doc: LibraryDoc; message: string }

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

/** A layout is only read when its two anchors are usable; bad numbers drop the whole layout. */
function readLayout(value: unknown): AssetLayout | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (!isFiniteNumber(record.x) || !isFiniteNumber(record.y)) return undefined
  const layout: AssetLayout = { x: record.x, y: record.y }
  if (isFiniteNumber(record.w)) layout.w = record.w
  if (isFiniteNumber(record.h)) layout.h = record.h
  if (isFiniteNumber(record.z)) layout.z = record.z
  if (isFiniteNumber(record.at)) layout.at = record.at
  if (record.hidden === true) layout.hidden = true
  return layout
}

function readEntry(value: unknown): LibraryEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const tags = Array.isArray(record.tags)
    ? record.tags.filter((tag): tag is string => typeof tag === 'string')
    : []
  const entry: LibraryEntry = { tags }
  if (typeof record.note === 'string') entry.note = record.note
  if (record.by === 'human' || record.by === 'agent') entry.by = record.by
  if (typeof record.at === 'number' && Number.isFinite(record.at)) entry.at = record.at
  const layout = readLayout(record.layout)
  if (layout) entry.layout = layout
  return entry
}

export function readLibraryFile(text: string): LibraryFileReadResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return {
      ok: false,
      doc: emptyLibraryDoc(),
      message: `Not valid JSON: ${(error as Error).message}`,
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, doc: emptyLibraryDoc(), message: 'A library index must be an object.' }
  }

  const record = parsed as Record<string, unknown>
  if (record.schemaVersion !== LIBRARY_SCHEMA_VERSION) {
    return {
      ok: false,
      doc: emptyLibraryDoc(),
      message: `Expected schemaVersion ${LIBRARY_SCHEMA_VERSION}.`,
    }
  }
  if (!record.entries || typeof record.entries !== 'object' || Array.isArray(record.entries)) {
    return { ok: false, doc: emptyLibraryDoc(), message: 'Expected an `entries` object.' }
  }

  const doc: LibraryDoc = { schemaVersion: LIBRARY_SCHEMA_VERSION, entries: {} }
  const problems: string[] = []
  for (const [path, value] of Object.entries(record.entries as Record<string, unknown>)) {
    const entry = readEntry(value)
    if (!entry) {
      problems.push(path)
      continue
    }
    doc.entries[path] = entry
  }

  return problems.length === 0
    ? { ok: true, doc }
    : { ok: false, doc, message: `Ignored entries that are not objects: ${problems.join(', ')}` }
}

/** Two spaces and a trailing newline: a tag change should be a diff a person can read. */
export function writeLibraryFile(doc: LibraryDoc): string {
  return `${JSON.stringify(doc, null, 2)}\n`
}
