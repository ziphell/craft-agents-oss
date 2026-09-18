/**
 * Patches written by a person editing a page in the browser window.
 *
 * Boxing elements and bolding them, or replacing a line of text by hand, produces
 * the same artifact the agent produces: a patch file under `patches/`. That is
 * deliberate. A patch is what survives a reload, what every window showing the
 * prototype follows, what `status` reports and what a delivery carries — an edit
 * that lived only in the DOM would be a second kind of change with none of that.
 *
 * Two decisions live here because nothing else can make them:
 *
 * - **The writer id is `ui`.** A patch name claims a writer (`A-001-…` → `A`), and
 *   that is what ownership is derived from, so a person's edits need an identity
 *   of their own: they never collide with an agent's `cart-003-…`, and the rule
 *   "two writers must not overwrite each other" keeps holding. `Z` is not
 *   available — that is the folded layer's, and the write guard refuses it.
 * - **The order number is `max(existing) + 1`.** Replay order is the declared
 *   number (`storage.byReplayOrder`), and the writer id is **not** a sort key: a
 *   person's edit is a modification of what is already on the page, so it has to
 *   be numbered after it — otherwise an existing patch would simply win on the
 *   next replay and the edit would look like it did nothing.
 *
 * Every patch declares what it is aimed at (`@target`), for the same reason the
 * agent declares it: the selector is the part that can go stale, and the anchor
 * record plus the drift report are what make that visible. The selectors come
 * from the page itself (the window's own `buildStableSelector`), so they are the
 * ones the picker and the agent already use.
 *
 * @see docs/prototype-workbench-plan.md §21 (the change layer), §12.7 (the window's own gestures)
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPrototypePagePatchesPath, getPrototypePatchesPath, scanPrototypePatches } from './storage.ts'
import type { PrototypePatchKind } from './types.ts'

/** The writer identity a person's own edits are published under. */
export const UI_WRITER = 'ui'

/**
 * One edit, as the window reports it.
 *
 * Styles carry every element that was boxed — a bold applied to four elements is
 * one gesture and one patch — while a text edit is about the one element it was
 * typed into.
 */
export type PrototypeEdit =
  | {
      kind: 'style'
      /** One selector per element the person boxed, in the order they boxed them. */
      targets: string[]
      /** CSS declarations, e.g. `{ 'font-weight': '700' }`. */
      declarations: Record<string, string>
    }
  | {
      kind: 'text'
      /** The element whose text was replaced. */
      selector: string
      /** The element's new text, replacing all of it. */
      text: string
    }

export interface WrittenEditPatch {
  /** Where the edits went, as patches are named everywhere else: `patches/…`. */
  files: string[]
  /** The replay order they took — after everything that was there when they were made. */
  order: number
}

/**
 * Write one session's edits as a patch of `slug`, scoped to `page` (null = the whole flow).
 *
 * **One save, one change layer entry.** A person styles four elements, retypes a line
 * and presses save: that is one moment of intent, so it is one patch file — not four.
 * It is also what makes the editing itself cheap to take back: until save, nothing is
 * written anywhere, so undo is a draft operation rather than a history of files.
 *
 * Two files when the session did both kinds of edit (styles are CSS, a retyped line is
 * a script) — the same number for both, and replay order breaks the tie by name, so the
 * styles land before the script. `Z`'s numbering convention is not needed here: nothing
 * is folded, and these are ordinary patches that a fold can later collapse like any other.
 *
 * Nothing is applied here: writing the files is what makes the change travel, the same
 * way it does when the agent writes one — the watcher replays them into every window
 * showing the prototype (a page of ours reloads, a live page is re-patched).
 */
export function writePrototypeEdits(
  workspaceRootPath: string,
  slug: string,
  page: string | null,
  edits: PrototypeEdit[],
): WrittenEditPatch {
  if (edits.length === 0) throw new Error('Refusing to write a patch with no edits in it.')

  const styles = edits.filter((edit): edit is Extract<PrototypeEdit, { kind: 'style' }> => edit.kind === 'style')
  const texts = edits.filter((edit): edit is Extract<PrototypeEdit, { kind: 'text' }> => edit.kind === 'text')
  for (const edit of styles) for (const target of edit.targets) assertSelector(target)
  for (const edit of texts) assertSelector(edit.selector)

  const order = nextOrder(workspaceRootPath, slug)
  const dir = page
    ? getPrototypePagePatchesPath(workspaceRootPath, slug, page)
    : getPrototypePatchesPath(workspaceRootPath, slug)
  mkdirSync(dir, { recursive: true })

  const files: string[] = []
  const write = (name: string, kind: PrototypePatchKind, text: string): void => {
    const fileName = `${UI_WRITER}-${String(order).padStart(3, '0')}-${name}.${kind}`
    writeFileSync(join(dir, fileName), text, 'utf-8')
    files.push(page ? `patches/${page}/${fileName}` : `patches/${fileName}`)
  }

  if (styles.length > 0) write(styleName(styles), 'css', styleSource(styles))
  if (texts.length > 0) write('text', 'js', textSource(texts))

  return { files, order }
}

/** What the stylesheet is called, from what it does — readable in a listing. */
function styleName(styles: Array<Extract<PrototypeEdit, { kind: 'style' }>>): string {
  const properties = new Set(styles.flatMap((edit) => Object.keys(edit.declarations)))
  if (properties.size === 1 && properties.has('font-weight')) return 'bold'
  if (properties.size === 1 && properties.has('font-style')) return 'italic'
  return 'edits'
}

/**
 * One past the highest number already declared by this prototype.
 *
 * Over every patch of the prototype rather than the page's own directory: order
 * is one sequence across the prototype (`byReplayOrder` sorts the whole set), so
 * taking the maximum of the scope being written into would still let a patch of
 * another page sort after this one.
 */
function nextOrder(workspaceRootPath: string, slug: string): number {
  return scanPrototypePatches(workspaceRootPath, slug).reduce((highest, patch) => Math.max(highest, patch.order), 0) + 1
}

/** The values, once each, in the order they were given. */
function dedupe(values: string[]): string[] {
  return [...new Set(values)]
}

/**
 * The stylesheet: a header naming every element the session touched, then each
 * edit's rules in the order they were made.
 *
 * Later rules winning is what makes a session that bolded then un-bolded the same
 * element land on the value it ended with — the same thing that happens live.
 *
 * The markers go one per line inside a comment, which is the shape `fold.ts`
 * writes and what `patch-header.ts` reads (it strips a line's comment
 * terminator, so the `@target` lines have to come before the comment closes).
 */
function styleSource(styles: Array<Extract<PrototypeEdit, { kind: 'style' }>>): string {
  const declarations = styles.flatMap((edit) => Object.entries(edit.declarations))
  for (const [property, value] of declarations) assertDeclaration(property, value)

  const rules = styles.flatMap((edit) =>
    edit.targets.map((target) =>
      [`${target} {`, ...Object.entries(edit.declarations).map(([property, value]) => `  ${property}: ${value};`), `}`].join('\n'),
    ),
  )

  const header = [
    `/* Set from the browser window: ${styles.length === 1 ? styleName(styles) : `${styles.length} style edits`}.`,
    ...dedupe(styles.flatMap((edit) => edit.targets)).map((target) => `   @target ${target}`),
    `   (the markers above are read by the workbench — keep them) */`,
  ].join('\n')

  return `${header}\n\n${rules.join('\n\n')}\n`
}

/**
 * The script: one assignment per retyped element, in the order they were retyped.
 *
 * `textContent` and not `innerText`: the element's whole text, whatever it was, in
 * one assignment — and the same read on every engine. The locals are numbered
 * rather than named after their selectors: two selectors can differ only in
 * characters a name cannot carry, and a duplicate `const` would be a syntax error
 * in a file that runs on every load.
 */
function textSource(texts: Array<Extract<PrototypeEdit, { kind: 'text' }>>): string {
  const header = [
    `// Set from the browser window: ${texts.length === 1 ? 'the text of one element' : `${texts.length} elements' text`}.`,
    ...dedupe(texts.map((edit) => edit.selector)).map((target) => `// @target ${target}`),
  ].join('\n')

  const assignments = texts.map((edit, index) =>
    [
      `const el${index} = document.querySelector(${JSON.stringify(edit.selector)});`,
      `if (el${index}) el${index}.textContent = ${JSON.stringify(edit.text)};`,
    ].join('\n'),
  )

  return `${header}\n\n${assignments.join('\n\n')}\n`
}

/**
 * A selector this patch may be built from.
 *
 * The value travels from a page into a file that is later replayed into that page,
 * so the two characters that would end the rule (or the comment it sits in) early
 * are refused here rather than producing a patch that fails to parse.
 */
function assertSelector(selector: string): void {
  if (selector.trim().length === 0) throw new Error('An edit needs a selector: nothing was selected.')
  if (/[;{}\n]/.test(selector)) throw new Error(`Refusing to write a patch for an unusable selector: ${selector}`)
}

/** Same boundary as `assertSelector`, for the declarations the window computed. */
function assertDeclaration(property: string, value: string): void {
  if (!/^[a-z-]+$/.test(property)) throw new Error(`Refusing to write a patch setting "${property}"`)
  if (/[;{}\n]/.test(value)) throw new Error(`Refusing to write a patch setting "${property}" to "${value}"`)
}
