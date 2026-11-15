/**
 * A card's name, when nobody has typed one.
 *
 * A node is a thing on a board that outlives its current file: it can be generated again, restoring
 * a version, and the file behind it is renamed by every run. So the name belongs to the **node**
 * (`CanvasNode.title`), not to the file, and nothing here is ever read back as the truth once a
 * person has typed over it.
 *
 * These are only seeds — what a card should be called before anyone has said.
 */
import type { CanvasNode } from './document.ts'

/** The name a new card gets from the words it was described with: the first line, minus markdown. */
export function titleFromText(text: string | undefined | null): string | undefined {
  if (!text) return undefined
  const line = text
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find((value) => value.length > 0)
  if (!line) return undefined
  // `# 场景` and `- 描述` are formatting, not names.
  const cleaned = line.replace(/^#{1,6}\s*/, '').replace(/^[-*+]\s+/, '').replace(/\s+/g, ' ').trim()
  return cleaned ? cleaned.slice(0, 80) : undefined
}

/** The name a card gets from a file somebody handed us: its name without the extension. */
export function titleFromFile(fileName: string): string | undefined {
  const base = fileName.split(/[\\/]/).pop() ?? fileName
  const withoutExtension = base.replace(/\.[^.]+$/, '')
  return withoutExtension.trim() ? withoutExtension.trim().slice(0, 80) : undefined
}

/**
 * What to show on the card: what the person called it, or the least-bad stand-in.
 *
 * The stand-in is never a node id — a board of `n-mw8srn1w-thw` tells nobody anything — so a card
 * with no name and no file simply has no label until someone types one.
 */
export function displayTitle(node: CanvasNode | null | undefined): string | null {
  if (!node) return null
  const title = node.title?.trim()
  if (title) return title
  const file = node.src?.split(/[\\/]/).pop()
  if (!file) return null
  const withoutExtension = file.replace(/\.[^.]+$/, '')
  // `docs/nodes/n-mw8srn1w-thw.md` is a name only a machine can use.
  return /^n-[a-z0-9]{6,}/i.test(withoutExtension) ? null : withoutExtension
}
