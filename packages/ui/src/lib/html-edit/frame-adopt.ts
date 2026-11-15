/**
 * An outside write, applied to the page that is already on screen.
 *
 * The frame is a derived view: it is built from the source, so the obvious way to show a new version is to build it
 * again. That is what this editor used to do, and it costs the person everything the page was holding — scroll
 * position, focus, the field they were halfway through — because a rebuilt document is a different document.
 *
 * Instead, the difference between the two versions is computed **by element** (`shared/html/element-diff.ts`) and
 * only those elements are replaced, in place, from the new source's own bytes. Everything else in the live DOM — the
 * element the caret is in, the scroll offsets, the frame's own script state — is never touched.
 *
 * Two things make it safe to try: the answer is checkable (an element that cannot be found means "do not do this"),
 * and the caller still has the rebuild as a fallback. What it will not do is *guess*: a change whose element is not
 * where the path says ends the attempt rather than landing somewhere plausible.
 *
 * The mark is the same one the markdown editor uses — `.agent-changed` for the wash, `.agent-caret` for where it
 * stopped — so a change looks the same whichever kind of document it happened in. It fades on its own.
 */

import { changedElements } from '@craft-agent/shared/html/element-diff'

export interface AdoptResult {
  /** The live DOM now shows `after`. */
  applied: boolean
  /** Why not, when it did not. */
  reason?: string
  /** How many elements were replaced. */
  replaced: number
}

/** Where the mark comes from. Injected into the frame because a frame has its own stylesheet world. */
const MARK_CSS = `
.agent-changed { background-color: color-mix(in srgb, Highlight 18%, transparent); border-radius: 2px; transition: background-color 600ms ease-out; }
.agent-caret { display: inline-block; width: 2px; height: 1.1em; margin: 0 -1px; vertical-align: text-bottom; background-color: Highlight; }
.agent-caret-label { position: absolute; transform: translateY(-120%); padding: 1px 5px; border-radius: 4px; background-color: Highlight; color: HighlightText; font-size: 10px; white-space: nowrap; pointer-events: none; }
`

/** The element a path names, walking the way `indexHtml` walked: from the root element's children down. */
function elementAt(root: Element, path: string): Element | null {
  const steps = path.split('/').filter(Boolean).map(Number)
  let current: Element = root
  for (const step of steps) {
    const next = current.children[step]
    if (!next) return null
    current = next
  }
  return current === root && steps.length > 0 ? null : current
}

function markChanged(doc: Document, elements: readonly Element[]): void {
  if (elements.length === 0) return
  if (!doc.querySelector('style[data-agent-mark]')) {
    const style = doc.createElement('style')
    style.setAttribute('data-agent-mark', '')
    style.textContent = MARK_CSS
    doc.head?.appendChild(style)
  }
  for (const element of elements) element.classList.add('agent-changed')

  const last = elements[elements.length - 1]
  if (!last) return
  const caret = doc.createElement('span')
  caret.className = 'agent-caret'
  const label = doc.createElement('span')
  label.className = 'agent-caret-label'
  label.textContent = 'Craft Agent'
  caret.appendChild(label)
  last.after(caret)

  setTimeout(() => {
    for (const element of elements) element.classList.remove('agent-changed')
    caret.remove()
  }, 8_000)
}

/**
 * Show `after` in the live document by replacing the elements `before` → `after` changed.
 *
 * Returns `applied: false` when the difference cannot be placed in the live DOM — a path the page does not have,
 * which happens as soon as the two versions disagree structurally at the top. The caller rebuilds in that case; a
 * wrong element replaced silently would be much worse than a page that reloaded.
 */
export function adoptChangedElements(frameDocument: Document, before: string, after: string): AdoptResult {
  const root = frameDocument.documentElement
  if (!root) return { applied: false, reason: 'the frame has no document', replaced: 0 }

  const changes = changedElements(before, after)
  if (changes.length === 0) return { applied: true, replaced: 0 }

  const touched: Element[] = []
  for (const change of changes) {
    const element = elementAt(root, change.path)
    if (!element) return { applied: false, reason: `no element at ${change.path}`, replaced: 0 }

    if (change.from < 0 || change.to < change.from) {
      element.remove()
      continue
    }
    // The source's own bytes for this element, not a serialization: the DOM ends up matching the file exactly.
    element.outerHTML = after.slice(change.from, change.to)
    const replaced = elementAt(root, change.path)
    if (replaced) touched.push(replaced)
  }

  markChanged(frameDocument, touched)
  return { applied: true, replaced: changes.length }
}
