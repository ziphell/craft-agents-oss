/**
 * What an agent's edit looks like while it is happening.
 *
 * ## It disappears, and that is the point (2026-11-02)
 *
 * The first version had **no notion of disappearing**: `view.update` re-armed the 8 s timer whenever the decoration
 * set's *identity* changed, and `DecorationSet.map` returns a new set on every doc-changing transaction — so a person
 * typing restarted the clock on every keystroke, and the caret (mapped forward each time) travelled along with their
 * own text. Reported as "I get an agent caret while I am the one typing", which is exactly what it did. Measured: five
 * keystrokes after an agent edit and it was still on screen.
 *
 * So the marks carry a **deadline**: the plugin state holds an `expiresAt` set by the agent's own transaction, the
 * timer is aimed at that time (never at "eight seconds from now"), and nothing a person does moves it. Held by
 * `__tests__/tiptap-roundtrip.test.ts` — "is due at a time, and a person typing does not push that time forward", and
 * "vanishes when the deadline passes, and does not come back when somebody types" (a fake clock advances the eight
 * seconds instead of waiting for them).
 *
 * Two things, both display-only:
 *
 * - a wash over the text the agent wrote, so "what changed" is answerable at a glance rather than by memory;
 * - a caret where it stopped, with a label — the same thing a shared document does for a collaborator, and for the
 *   same reason: a change that appears by itself needs to say whose it was.
 *
 * Both fade out after `FADE_MS`. They are decorations, not marks: nothing here reaches the document, so nothing here
 * can be saved, undone, or picked up on the way to the file.
 *
 * The ranges come from the transaction, via the technique GenOffice uses for the same job
 * (`apps/markdown/src/renderer/editor/aiHighlight.ts`): each step says where it wrote, and mapping that range
 * through the steps after it turns "where it was written" into "where it is now". A change that landed on a node
 * boundary has no text of its own to paint, so it widens to the blocks it sits between.
 */

import { Extension } from '@tiptap/core'
import type { Editor } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { Transaction } from '@tiptap/pm/state'
import { AddMarkStep, RemoveMarkStep } from '@tiptap/pm/transform'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { EditorView } from '@tiptap/pm/view'

/** The metadata every agent transaction carries; the landing sets it in `markdown-land.ts`. */
export const AGENT_EDIT_META = 'agentEdit'
const CLEAR_META = 'agentPresenceClear'
const FADE_MS = 8_000

interface Range {
  from: number
  to: number
}

/**
 * The ranges a transaction rewrote, in its own document's coordinates.
 *
 * Mapping matters here: a landing can replace several blocks in one transaction, and step 3's range is meaningless
 * until steps 4…n have been applied to it.
 */
export function changedRanges(tr: Transaction): Range[] {
  const ranges: Range[] = []
  const push = (from: number, to: number) => {
    if (to <= from) return
    let inline = false
    tr.doc.nodesBetween(from, to, (node) => {
      if (node.isInline) inline = true
      return !inline
    })
    if (inline) {
      ranges.push({ from, to })
      return
    }
    // No inline content to paint: paint the top-level blocks the range sits between, so a structural edit shows.
    const fromIndex = tr.doc.resolve(from).index(0)
    const toIndex = tr.doc.resolve(Math.max(from, to - 1)).index(0)
    let start = 0
    for (let index = 0; index < fromIndex; index += 1) start += tr.doc.child(index).nodeSize
    let end = start
    for (let index = fromIndex; index <= toIndex; index += 1) end += tr.doc.child(index).nodeSize
    if (end > start) ranges.push({ from: start, to: end })
  }

  tr.steps.forEach((step, index) => {
    const rest = tr.mapping.slice(index + 1)
    if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) {
      // A mark step does not move positions, so its own range is already the answer.
      push(rest.map(step.from, 1), rest.map(step.to, -1))
      return
    }
    step.getMap().forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      push(rest.map(newStart, 1), rest.map(newEnd, -1))
    })
  })
  return ranges
}

/** Remove the wash and the caret now, rather than waiting for the fade. */
export function clearAgentPresence(editor: Editor): void {
  editor.view.dispatch(editor.state.tr.setMeta(CLEAR_META, true))
}

function agentCaret(): HTMLElement {
  const caret = document.createElement('span')
  caret.className = 'agent-caret'
  caret.setAttribute('aria-hidden', 'true')
  const label = document.createElement('span')
  label.className = 'agent-caret-label'
  label.textContent = 'Craft Agent'
  caret.appendChild(label)
  return caret
}

/**
 * The decorations, and **when they are due to go**.
 *
 * The deadline is the whole design. It is set once, by the agent's own transaction, and nothing a person does moves it:
 * typing, selecting, or another landing all leave it where it is. That is what "disappears" means — a mark due at a
 * time, not a mark due "eight seconds after whatever happened last".
 *
 * The previous version keyed the clock off the decoration set's **identity** in `view.update`. `DecorationSet.map`
 * returns a new set on every transaction that changes the document, so every keystroke restarted the clock — and the
 * caret, mapped forward each time, followed the person's own typing and never went away (measured: five keystrokes
 * after an agent edit, caret still there, sitting after text the person had typed).
 */
interface PresenceState {
  set: DecorationSet
  /** When the marks are due to vanish, in `Date.now()` terms; `null` when there are none. */
  expiresAt: number | null
}

const EMPTY: PresenceState = { set: DecorationSet.empty, expiresAt: null }

const key = new PluginKey<PresenceState>('agentPresence')

/** When the marks on screen are due to go — so a test can check the clock instead of waiting for it. */
export function agentPresenceExpiry(editor: Editor): number | null {
  return key.getState(editor.state)?.expiresAt ?? null
}

export const AgentPresence = Extension.create({
  name: 'agentPresence',

  addProseMirrorPlugins() {
    return [
      new Plugin<PresenceState>({
        key,
        state: {
          init: () => EMPTY,
          apply(tr, previous) {
            if (tr.getMeta(CLEAR_META)) return EMPTY
            // The marks travel with the text they sit on — that part was always right, and typing does not own them.
            let set = previous.set.map(tr.mapping, tr.doc)
            const isAgentEdit = tr.getMeta(AGENT_EDIT_META) !== undefined && tr.docChanged
            if (!isAgentEdit) return { set, expiresAt: previous.expiresAt }

            const ranges = changedRanges(tr)
            const limit = tr.doc.content.size
            for (const range of ranges) {
              const from = Math.max(0, Math.min(range.from, limit))
              const to = Math.max(from, Math.min(range.to, limit))
              if (to > from) set = set.add(tr.doc, [Decoration.inline(from, to, { class: 'agent-changed' })])
            }
            // One caret, at the end of the last thing written — where the agent left off.
            const last = ranges[ranges.length - 1]
            if (last) {
              const at = Math.max(0, Math.min(last.to, limit))
              set = set.add(tr.doc, [Decoration.widget(at, () => agentCaret(), { side: 1, key: 'agent-caret' })])
            }
            return { set, expiresAt: Date.now() + FADE_MS }
          },
        },
        props: {
          decorations(state) {
            return key.getState(state)?.set ?? DecorationSet.empty
          },
        },
        view(view: EditorView) {
          let timer: ReturnType<typeof setTimeout> | null = null
          /** Aim the timer at the deadline in the state — never at "eight seconds from now". */
          const arm = () => {
            if (timer) {
              clearTimeout(timer)
              timer = null
            }
            const expiresAt = key.getState(view.state)?.expiresAt ?? null
            if (expiresAt === null) return
            timer = setTimeout(
              () => {
                timer = null
                if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(CLEAR_META, true))
              },
              Math.max(0, expiresAt - Date.now()),
            )
          }
          return {
            update: () => arm(),
            destroy: () => {
              if (timer) clearTimeout(timer)
            },
          }
        },
      }),
    ]
  },
})
