/**
 * Changes to the index.
 *
 * Every function returns a new document and never mutates the one it was given. Tags are the main
 * event: a file whose tags and note are both empty has no entry at all, so an unannotated library
 * is an empty file rather than a ledger of empty objects.
 *
 * There is no `rev` here. A tag is a word about a file, and the two writers — a person typing in
 * the panel and an agent calling the tool — change one entry at a time; the last write to one
 * entry wins, and nobody else's entry is touched. A revision counter would only make a person
 * re-read the whole library to add one tag.
 */

import { normalizeTags } from './merge.ts'
import type { AssetAuthor, AssetLayout, LibraryDoc, LibraryEntry } from './types.ts'

function setEntry(doc: LibraryDoc, path: string, entry: LibraryEntry): LibraryDoc {
  const entries = { ...doc.entries }
  // A layout is a board record even when nobody has tagged or noted the asset.
  if (entry.tags.length === 0 && !entry.note?.trim() && !entry.layout) delete entries[path]
  else entries[path] = entry
  return { ...doc, entries }
}

export function withTags(
  doc: LibraryDoc,
  path: string,
  tags: readonly string[],
  author: AssetAuthor,
  at = Date.now(),
): LibraryDoc {
  const previous = doc.entries[path]
  return setEntry(doc, path, {
    ...previous,
    tags: normalizeTags(tags),
    by: author,
    at,
  })
}

export function withNote(
  doc: LibraryDoc,
  path: string,
  note: string,
  author: AssetAuthor,
  at = Date.now(),
): LibraryDoc {
  const previous = doc.entries[path]
  return setEntry(doc, path, {
    ...previous,
    tags: previous?.tags ?? [],
    note: note.trim() || undefined,
    by: author,
    at,
  })
}

/**
 * Put a card somewhere on the board, or clear its place with `null`.
 *
 * The layout lives in the same entry as the tags and note, so the board and the panel write one
 * record rather than a second document that has to be kept in step.
 */
export function withLayout(
  doc: LibraryDoc,
  path: string,
  layout: AssetLayout | null,
  author: AssetAuthor,
  at = Date.now(),
): LibraryDoc {
  const previous = doc.entries[path]
  const next: LibraryEntry = {
    ...previous,
    tags: previous?.tags ?? [],
    by: author,
    at,
  }
  if (layout) next.layout = { ...layout, at: layout.at ?? at }
  else delete next.layout
  return setEntry(doc, path, next)
}

/** Forget what was said about a file. The file itself is never touched. */
export function withoutEntry(doc: LibraryDoc, path: string): LibraryDoc {
  if (!(path in doc.entries)) return doc
  const entries = { ...doc.entries }
  delete entries[path]
  return { ...doc, entries }
}
