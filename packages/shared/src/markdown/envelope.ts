/**
 * The envelope: the parts of a `.md` file that are not the document.
 *
 * A `.md` file is the body the editor edits *plus* a few things that belong to the file rather than to its prose:
 *
 * - a YAML frontmatter block at the top — `SKILL.md`, and most agent-authored markdown, opens with one;
 * - the line endings (`\r\n` on anything a Windows tool touched);
 * - whether the file ended with a newline;
 * - a UTF-8 BOM, which Notepad still writes.
 *
 * None of these are content, and none of them can be represented in a rich document: the markdown parser reads
 * `---\ntitle: x\n---` as a thematic break followed by a heading, so a frontmatter block would come back as
 * `---` and `## title: x` — two nodes, where the file had one block. That is not a formatting quibble; it breaks
 * the one-to-one promise between file blocks and document nodes that every splice in this editor depends on.
 *
 * So the frontmatter is taken off before the document is built and put back verbatim when it is written. The editor
 * never sees it, and an agent that rewrites the body cannot disturb it. This is the arrangement `genoffice` uses
 * (`apps/markdown/src/renderer/markdown/docText.ts`, whose field names are kept here deliberately), and it is the
 * reason that app survives opening and saving a `SKILL.md` without churn.
 */

export interface DocEnvelope {
  /** The raw frontmatter block, both fences included, with the blank lines after it; `''` when there is none. */
  frontmatter: string
  /** The markdown body the document is built from, with `\n` line endings. */
  body: string
  /** What the file used. Restored on write, because a checkout on Windows should not flip every line. */
  eol: '\n' | '\r\n'
  /** Whether the file ended with a newline (a new document does). */
  trailingNewline: boolean
  /** Whether the file began with a UTF-8 BOM. */
  bom: boolean
}

const FENCE = '---'

/** Split a file into the envelope and the body. Never lossy: `serializeDocText(parseDocText(raw), …body)` returns `raw`. */
export function parseDocText(raw: string): DocEnvelope {
  let text = raw
  const bom = text.startsWith('\uFEFF')
  if (bom) text = text.slice(1)
  const eol: DocEnvelope['eol'] = text.includes('\r\n') ? '\r\n' : '\n'
  text = text.replace(/\r\n/g, '\n')
  const trailingNewline = text === '' || text.endsWith('\n')

  let frontmatter = ''
  let body = text
  if (text.startsWith(`${FENCE}\n`)) {
    let searchFrom = FENCE.length
    for (;;) {
      const close = text.indexOf(`\n${FENCE}`, searchFrom)
      if (close < 0) break
      const closeEnd = close + 1 + FENCE.length
      // The closing fence has to be a line of its own: end of file, or followed by a newline.
      if (closeEnd === text.length || text[closeEnd] === '\n') {
        let end = closeEnd
        while (text[end] === '\n') end++
        frontmatter = text.slice(0, end)
        body = text.slice(end)
        break
      }
      searchFrom = close + 1
    }
  }
  return { frontmatter, body, eol, trailingNewline, bom }
}

/** The YAML inside a raw frontmatter block, fences and the blank line after it removed. */
export function frontmatterInner(raw: string): string {
  if (!raw.startsWith(`${FENCE}\n`)) return ''
  const inner = raw.slice(FENCE.length + 1).replace(/\n+$/, '')
  return inner.endsWith(`\n${FENCE}`) ? inner.slice(0, -(FENCE.length + 1)) : ''
}

/** Rebuild a raw block from edited YAML; blank input removes the block altogether. */
export function buildFrontmatterRaw(inner: string): string {
  const trimmed = inner.replace(/^\s+|\s+$/g, '')
  return trimmed === '' ? '' : `${FENCE}\n${trimmed}\n${FENCE}\n\n`
}

/** The file text: the body the editor wrote, dressed back in the envelope it arrived in. */
export function serializeDocText(envelope: DocEnvelope, body: string): string {
  let text = envelope.frontmatter + body
  if (envelope.trailingNewline) {
    if (text !== '' && !text.endsWith('\n')) text += '\n'
  } else {
    text = text.replace(/\n+$/, '')
  }
  if (envelope.eol === '\r\n') text = text.replace(/\n/g, '\r\n')
  return envelope.bom ? `\uFEFF${text}` : text
}
