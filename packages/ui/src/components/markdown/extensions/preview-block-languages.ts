/**
 * The fence languages the app draws as a block of its own — a diagram, a page, a table, a diff —
 * and nothing else.
 *
 * Its own module because two readers have to agree and neither should own the answer:
 * `PreviewBlock`, which draws these fences, and `tiptapCodeBlock`, which is the fallback for "a
 * fence nobody else claims" and therefore has to skip them. Keeping the list next to the
 * components would drag every one of those components — pdf.js among them — into the code
 * block's imports. Keeping it as a bare list also makes the components checked against it
 * (`Record<PreviewBlockLanguage, …>` below in `PreviewBlock`), so a language cannot be added
 * without something that draws it.
 *
 * `markdown-preview` is deliberately absent: see `PreviewBlock`.
 */
export const PREVIEW_BLOCK_LANGUAGES = [
  'drawio-preview',
  'html-preview',
  'pdf-preview',
  'image-preview',
  'datatable',
  'spreadsheet',
  'diff',
  'json',
] as const

export type PreviewBlockLanguage = (typeof PREVIEW_BLOCK_LANGUAGES)[number]

export function isPreviewBlockLanguage(lang: string): lang is PreviewBlockLanguage {
  return (PREVIEW_BLOCK_LANGUAGES as readonly string[]).includes(lang)
}
