/**
 * What a work can be exported **as** — one table, read by the handler that validates a request and
 * by the menu that offers it, so the two cannot disagree.
 *
 * The list is short on purpose. It holds the formats a person actually hands on:
 *
 * - **pdf** — fixed layout, what you send someone to read;
 * - **docx** — the only target they can edit afterwards;
 * - **md** — the source form of a Word file, for going back to plain text;
 * - **html** — one self-contained page: every local picture and stylesheet inlined into a copy
 *   that can be double-clicked on a machine that has nothing else. This is what a page is *sent*
 *   as, which is why it replaces the zip below rather than sitting beside it.
 *
 * What is deliberately absent, and why:
 *
 * - **`zip`** — a work is a file, not a folder; there is nothing to bundle. The self-contained page
 *   above is how html travels, and it is a copy rather than an archive.
 * - **per-page `png`** — pagination belongs to slides, and the library already draws a poster of
 *   every work. "Export png" would be a second way to see the same picture.
 * - **`mp4`** — a motion timeline is another product's subject, and the recording pipeline is the
 *   most fragile thing in the stack. A page that moves is delivered as a page.
 * - **`xlsx`** — a document is not a table. Extracting tables is `sheets from`, a different action
 *   with a different intent (see `docs/convert-tools.md`).
 */

export type CreationExportTarget = 'pdf' | 'docx' | 'md' | 'html'

/** Every target, in the order a menu should offer them. */
const TARGETS: CreationExportTarget[] = ['pdf', 'docx', 'md', 'html']

/** Sources whose structure is *prose* — they can become a document, and print as a page. */
const TEXT_SOURCES = new Set(['md', 'markdown', 'mdx', 'html', 'htm'])

/** Word documents: printable, and their text can come back out. */
const WORD_SOURCES = new Set(['docx', 'doc', 'odt'])

/** Formats the office editors print, and nothing else. */
const PRINT_ONLY_SOURCES = new Set(['xlsx', 'xls', 'xlsm', 'ods', 'pptx', 'ppt', 'odp'])

/** The extension of a path, lowercased, without the dot. */
export function extensionOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

/**
 * The targets a source format can be exported to, in menu order.
 *
 * A pdf answers nothing: it is where documents go, not where they come from. That is an empty list,
 * not an error — a menu with nothing to offer simply shows nothing.
 */
export function exportTargetsFor(path: string): CreationExportTarget[] {
  const extension = extensionOf(path)
  if (TEXT_SOURCES.has(extension)) return ['pdf', 'docx', 'html']
  if (WORD_SOURCES.has(extension)) return ['pdf', 'md']
  if (PRINT_ONLY_SOURCES.has(extension)) return ['pdf']
  return []
}

/** Whether this pair is one the exporter can perform. */
export function canExportTo(path: string, target: string): target is CreationExportTarget {
  return exportTargetsFor(path).includes(target as CreationExportTarget)
}

/** Where a menu or a dialog should suggest putting the result: beside the source, same name. */
export function defaultExportName(path: string, target: CreationExportTarget): string {
  const base = path.split(/[\\/]/).pop() ?? 'export'
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  return `${stem}.${target}`
}

/** Every target, for a caller that wants to describe the vocabulary (tests, docs). */
export const ALL_CREATION_EXPORT_TARGETS: readonly CreationExportTarget[] = TARGETS
