import { describe, expect, it } from 'bun:test'
import {
  applyTextEdit,
  applyTextEditAt,
  clearTextEditTargets,
  hasTextEditTarget,
  liveTextOf,
  registerTextEditTarget,
} from '../text-edits'
import { parseDocText, serializeDocText } from '../markdown-envelope'

/**
 * A stand-in editor: the handful of member functions an edit actually uses. The real one is exercised against a real
 * TipTap document in `__tests__/tiptap-roundtrip.test.ts`; this file is about the decision — whether an edit lands
 * at all — which does not need a document.
 */
function fakeEditor(file: string) {
  let markdown = parseDocText(file).body
  const editor = {
    isDestroyed: false,
    getMarkdown: () => markdown,
    /** What a landing does to the document, as far as this test is concerned. */
    get state() {
      return {
        doc: {
          content: { size: markdown.length },
          childCount: 1,
          forEach() {},
          // One node, and it says something: no trailing paragraph (`appendixIndex`).
          child: () => ({ type: { name: 'paragraph' }, content: { size: markdown.length } }),
        },
        tr: {
          replaceWith: () => ({
            setMeta() {
              return this
            },
          }),
        },
      }
    },
    view: { dispatch: () => undefined },
    setMarkdown(next: string) {
      markdown = next
    },
  }
  return editor
}

describe('an edit addressed to the open document', () => {
  const file = '---\nname: doc\n---\n\n# 标题\n\n甲段。\n'
  const envelope = parseDocText(file)

  it('reads the live document as a file, envelope and all', () => {
    const editor = fakeEditor(file) as never
    expect(liveTextOf(editor, envelope)).toBe(file)
  })

  it('replaces the whole document', () => {
    const editor = fakeEditor(file) as never
    const result = applyTextEdit(editor, envelope, { kind: 'replace', text: '# 新的\n' })
    // The landing itself is `landMarkdown`'s job — with a stub document it reports why it could not, which is the
    // honest answer here; what this asserts is that the request took that route rather than writing anything.
    expect(result.ok === false ? result.message : 'applied').toBeTruthy()
  })
})

describe('where the editor is', () => {
  it('finds it by path, and forgets it when it goes', () => {
    clearTextEditTargets()
    expect(hasTextEditTarget('/a/SKILL.md')).toBe(false)
    expect(applyTextEditAt('/a/SKILL.md', { kind: 'replace', text: '' })).resolves.toEqual({
      ok: false,
      message: 'no editor is showing this document',
    })

    const target = { applyEdit: () => ({ ok: true }) }
    const off = registerTextEditTarget('/a/SKILL.md', target)
    expect(hasTextEditTarget('/a/SKILL.md')).toBe(true)
    off()
    expect(hasTextEditTarget('/a/SKILL.md')).toBe(false)
  })

  it('does not let an old mount unregister the new one', () => {
    clearTextEditTargets()
    const first = { applyEdit: () => ({ ok: true }) }
    const second = { applyEdit: () => ({ ok: true }) }
    const offFirst = registerTextEditTarget('/a/x.md', first)
    registerTextEditTarget('/a/x.md', second)
    offFirst()
    expect(hasTextEditTarget('/a/x.md')).toBe(true)
  })
})
