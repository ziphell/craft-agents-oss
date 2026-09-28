/**
 * Targeted edits to an HTML file's own source, located with parse5.
 *
 * The visual editor shows a document inside a sandboxed iframe, and the iframe
 * can only say *which DOM element* changed — as a path of element-child indices.
 * To write that change back into the raw file without reformatting it, the source
 * is parsed with parse5 (`sourceCodeLocationInfo`) and the path is translated
 * into character offsets, so only that one span is patched.
 *
 * This works because the browser and parse5 implement the same WHATWG HTML
 * parsing algorithm, so the element tree (ignoring text and comment nodes) is
 * identical on both sides: a path of element-child indices maps 1:1.
 *
 * The source is the authority. The iframe's DOM is the surface a person edits,
 * and everything here exists to keep the file's own shape while it changes.
 */

import { parse } from 'parse5'

/** Minimal structural view over parse5's default tree adapter. */
interface P5Child {
  nodeName: string
  tagName?: string
  childNodes?: P5Child[]
  sourceCodeLocation?: {
    startOffset: number
    endOffset: number
    startTag?: { startOffset: number; endOffset: number }
    endTag?: { startOffset: number; endOffset: number }
    attrs?: Record<string, { startOffset: number; endOffset: number }>
  }
}

/** Where a single element lives inside the raw source. */
export interface HtmlElementInfo {
  /** Element-index path from the root `<html>`, e.g. `"1/0/2"` — the same value the frame computes. */
  path: string
  /** Lowercased tag name. */
  tag: string
  /** Offsets of the whole element (start tag through end tag). */
  start: number
  end: number
  /** Offset right after the start tag's `>`, i.e. the start of the inner region. */
  innerStart: number
  /** Offset of the end tag's `<`; -1 when the element has no explicit end tag. */
  innerEnd: number
  /**
   * True when the element has an explicit end tag and holds text nodes only (or
   * none) — i.e. safe to replace its whole inner region with one text value
   * without touching child markup.
   */
  editableText: boolean
  /** Exact source spans of the element's attributes (lowercased name → span). */
  attrs: Record<string, { start: number; end: number }>
}

const elementChildren = (node: P5Child | undefined): P5Child[] =>
  ((node?.childNodes ?? []) as P5Child[]).filter((child) => !!child.tagName)

/**
 * Parse `source` and index every element by its element-only child path.
 * The root `<html>` element itself is not indexed — paths start below it.
 */
export function indexHtml(source: string): Map<string, HtmlElementInfo> {
  const map = new Map<string, HtmlElementInfo>()
  let doc: P5Child
  try {
    doc = parse(source, { sourceCodeLocationInfo: true }) as unknown as P5Child
  } catch (error) {
    console.error('[htmlEdit] parse failed', error)
    return map
  }

  const root = elementChildren(doc)[0]
  if (!root) return map

  const walk = (parent: P5Child, prefix: string) => {
    elementChildren(parent).forEach((child, index) => {
      const path = prefix ? `${prefix}/${index}` : String(index)
      const loc = child.sourceCodeLocation
      if (loc) {
        const attrs: HtmlElementInfo['attrs'] = {}
        if (loc.attrs) {
          for (const [name, span] of Object.entries(loc.attrs)) {
            attrs[name.toLowerCase()] = { start: span.startOffset, end: span.endOffset }
          }
        }
        map.set(path, {
          path,
          tag: (child.tagName ?? '').toLowerCase(),
          start: loc.startOffset,
          end: loc.endOffset,
          innerStart: loc.startTag ? loc.startTag.endOffset : loc.startOffset,
          innerEnd: loc.endTag ? loc.endTag.startOffset : -1,
          editableText:
            !!loc.endTag &&
            elementChildren(child).length === 0 &&
            !(child.childNodes ?? []).some((node) => node.nodeName === '#comment'),
          attrs,
        })
      }
      walk(child, path)
    })
  }

  walk(root, '')
  return map
}

/** Escape a text value so it is safe inside element content. */
export function escapeHtmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Escape a value for use inside a double-quoted attribute. */
export function escapeAttrValue(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

/**
 * Replace the inner text of a text-only element (`info.editableText`).
 *
 * Whitespace around the original inner region — the indentation between the tags
 * and the text — is kept, so a pretty-printed file keeps its shape. Returns null
 * when the element is not editable or its offsets are unusable.
 */
export function patchInnerText(source: string, info: HtmlElementInfo, text: string): string | null {
  if (
    !info.editableText ||
    info.innerEnd < info.innerStart ||
    info.innerStart < 0 ||
    info.innerEnd > source.length
  ) {
    return null
  }

  const inner = source.slice(info.innerStart, info.innerEnd)
  const lead = (inner.match(/^\s*/) ?? [''])[0]
  let rest = inner.slice(lead.length)
  let trail = ''
  if (rest.length > 0 && rest.trim().length > 0) {
    trail = rest.match(/\s*$/)?.[0] ?? ''
    rest = rest.slice(0, rest.length - trail.length)
  }

  return source.slice(0, info.innerStart) + lead + escapeHtmlText(text) + trail + source.slice(info.innerEnd)
}

/**
 * Set the element's `style` attribute to `styleValue`, or remove it when the
 * value is null/empty. Only the start tag is touched, so the rest of the file
 * keeps its formatting.
 *
 * `styleValue` is treated as the authoritative serialized attribute — it normally
 * comes from `element.getAttribute('style')` after a CSSOM edit inside the frame.
 * Returns null when the offsets cannot be used.
 */
export function patchStyleAttr(
  source: string,
  info: HtmlElementInfo,
  styleValue: string | null,
): string | null {
  const current = info.attrs['style']

  if (!styleValue) {
    if (!current) return source
    if (!source.slice(current.start, current.end).trim()) return source
    // Swallow one preceding whitespace char so removing the attribute does not
    // leave a double space inside the start tag.
    const before = current.start > info.start ? source[current.start - 1] : undefined
    const at = before !== undefined && /\s/.test(before) ? current.start - 1 : current.start
    return source.slice(0, at) + source.slice(current.end)
  }

  const attrText = `style="${escapeAttrValue(styleValue)}"`
  if (current) {
    return source.slice(0, current.start) + attrText + source.slice(current.end)
  }

  // No style attribute yet — insert it just before the start tag's `>`.
  const insertAt = info.innerStart - 1
  if (insertAt < 0 || insertAt >= source.length || source[insertAt] !== '>') return null
  return source.slice(0, insertAt) + ' ' + attrText + source.slice(insertAt)
}

/**
 * Replace an element's whole range (start tag through end tag) with arbitrary
 * `html`. Used when a whole element is handed over to the conversation and comes
 * back rewritten.
 */
export function patchElementHtml(source: string, info: HtmlElementInfo, html: string): string | null {
  if (info.start < 0 || info.end > source.length || info.end <= info.start) return null
  return source.slice(0, info.start) + html + source.slice(info.end)
}

/**
 * Delete an element from the source. When it sits alone on its line — only
 * indentation before it, only whitespace after it — the whole line goes, so the
 * file stays tidy; otherwise just the element's own range is dropped.
 */
export function removeElementFromSource(source: string, info: HtmlElementInfo): string | null {
  if (info.start < 0 || info.end > source.length || info.end <= info.start) return null

  let delStart = info.start
  let delEnd = info.end

  const lineStart = source.lastIndexOf('\n', info.start - 1) + 1
  if (/^[ \t]*$/.test(source.slice(lineStart, info.start))) {
    delStart = lineStart
    const nextNewline = source.indexOf('\n', info.end)
    if (nextNewline !== -1 && /^[ \t]*$/.test(source.slice(info.end, nextNewline))) {
      delEnd = nextNewline + 1
    }
  }

  return source.slice(0, delStart) + source.slice(delEnd)
}
