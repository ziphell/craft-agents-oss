/**
 * Which parts of an HTML file one version changed: the block model for `.html`.
 *
 * The markdown editor answers "which blocks changed" with mdast offsets. HTML has had the same kind of answer since
 * the visual editor landed (`source-edits.ts`): parse5 knows where every element sits in the source, and an edit is a
 * patch to one span. What was missing is the *other* direction — the file changed underneath, and the frame is
 * rebuilt whole because nobody can say what moved.
 *
 * This says what moved. Element children are matched by position, so the answer is a list of the smallest elements
 * that differ: a paragraph whose text was edited, an element whose attributes changed, or the parent of a sibling
 * that was added — never "the page".
 *
 * Two deliberate choices:
 *
 * - **Structure is not matched by position when the count differs.** If `<main>` had three children and now has
 *   four, nothing below it can be paired up reliably, so the answer is `<main>` and the walk stops there. A guess
 *   at which child is which would paint the wrong element, which is worse than painting a larger true one.
 * - **Whitespace is compared as text, normalized.** A pretty-printer that re-indents a file did not change it, and
 *   saying that it did would put a highlight on the whole document for nothing.
 */

import { parse } from 'parse5'

interface P5Node {
  nodeName: string
  tagName?: string
  value?: string
  attrs?: Array<{ name: string; value: string }>
  childNodes?: P5Node[]
  sourceCodeLocation?: { startOffset: number; endOffset: number }
}

export type ElementChangeKind =
  /** The element's own text changed; its tags and children are the same. */
  | 'text'
  /** Only its attributes differ (a style, a class, an href). */
  | 'attrs'
  /** It gained, lost or reordered children. */
  | 'children'
  /** It is a different element now — another tag where this one was. */
  | 'replaced'
  /** It is new. */
  | 'added'
  /** It is gone. */
  | 'removed'

export interface ElementChange {
  /** Element-child path from the root `<html>`, the same value `source-edits.ts` and the frame use. `''` is the root. */
  path: string
  tag: string
  kind: ElementChangeKind
  /** Where the element is in the **new** source. `-1` when it is gone. */
  from: number
  /** End of the element in the new source. `-1` when it is gone. */
  to: number
}

const elementChildren = (node: P5Node | undefined): P5Node[] => (node?.childNodes ?? []).filter((n) => !!n.tagName)

const directText = (node: P5Node): string =>
  (node.childNodes ?? [])
    .filter((n) => n.nodeName === '#text')
    .map((n) => n.value ?? '')
    .join('')
    .replace(/\s+/g, ' ')
    .trim()

function attributes(node: P5Node): string {
  return (node.attrs ?? [])
    .map((attr) => `${attr.name}=${attr.value}`)
    .sort()
    .join(' ')
}

function parseRoot(source: string): P5Node | null {
  try {
    const doc = parse(source, { sourceCodeLocationInfo: true }) as unknown as P5Node
    return elementChildren(doc)[0] ?? null
  } catch {
    return null
  }
}

/** What `after` changed, as the smallest elements that can carry the news. */
export function changedElements(before: string, after: string): ElementChange[] {
  if (before === after) return []
  const beforeRoot = parseRoot(before)
  const afterRoot = parseRoot(after)
  if (!beforeRoot || !afterRoot) return []

  const changes: ElementChange[] = []

  const record = (node: P5Node, path: string, kind: ElementChangeKind) => {
    const loc = node.sourceCodeLocation
    changes.push({
      path,
      tag: (node.tagName ?? '').toLowerCase(),
      kind,
      from: loc?.startOffset ?? -1,
      to: loc?.endOffset ?? -1,
    })
  }

  const walk = (oldNode: P5Node, newNode: P5Node, path: string) => {
    if ((oldNode.tagName ?? '') !== (newNode.tagName ?? '')) {
      record(newNode, path, 'replaced')
      return
    }

    const oldKids = elementChildren(oldNode)
    const newKids = elementChildren(newNode)
    if (oldKids.length !== newKids.length) {
      record(newNode, path, 'children')
      return
    }

    if (directText(oldNode) !== directText(newNode)) record(newNode, path, 'text')
    else if (attributes(oldNode) !== attributes(newNode)) record(newNode, path, 'attrs')

    for (let index = 0; index < oldKids.length; index += 1) {
      const childPath = path ? `${path}/${index}` : String(index)
      walk(oldKids[index]!, newKids[index]!, childPath)
    }
  }

  walk(beforeRoot, afterRoot, '')
  return changes
}
