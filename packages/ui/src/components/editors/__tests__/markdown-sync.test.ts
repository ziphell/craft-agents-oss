import { describe, expect, it } from 'bun:test'
import { syncVerdict } from '../markdown-sync'

/**
 * The bug this guards, measured 2026-11-02: a paragraph was bolded by hand, in a document whose file also holds a
 * table, and the paragraph came back washed with the "Craft Agent" caret on it — the editor landing its own save back
 * onto itself, because the guard compared the document's serialization with the file's body and a padded table makes
 * those two never equal.
 */
describe('what a new `content` prop means', () => {
  const file = '# 标题\n\n甲段。\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n'
  /** What the document serializes to: the table padded, an extra blank line before it. */
  const serialized = '# 标题\n\n甲段。\n\n\n| a   | b   |\n| --- | --- |\n| 1   | 2   |'

  it('is nothing when the prop did not move', () => {
    expect(syncVerdict({ content: file, previous: file, emitted: null, editorMarkdown: serialized, body: file })).toBe(
      'nothing',
    )
  })

  it('is an echo when it is this editor’s own save — whatever the serializer would say', () => {
    // The person bolded a paragraph: the editor saved, the pane put the same text back into `content`.
    const bolded = file.replace('甲段。', '**甲段。**')
    expect(
      syncVerdict({ content: bolded, previous: file, emitted: bolded, editorMarkdown: serialized, body: bolded }),
    ).toBe('echo')
  })

  it('is an echo when the document already says this — a frontmatter edit, or line endings', () => {
    expect(syncVerdict({ content: file, previous: 'x', emitted: null, editorMarkdown: file, body: file })).toBe('echo')
  })

  it('is a landing when somebody else wrote the body', () => {
    const fromDisk = file.replace('甲段。', '甲段，外面改的。')
    expect(
      syncVerdict({ content: fromDisk, previous: file, emitted: null, editorMarkdown: serialized, body: fromDisk }),
    ).toBe('land')
  })

  it('is a landing even when this editor saved something different a moment ago', () => {
    // Provenance is a comparison of texts, not a flag: the file moved on and the editor did not write this.
    const fromDisk = file.replace('甲段。', '甲段，别人改的。')
    const mine = file.replace('甲段。', '**甲段。**')
    expect(
      syncVerdict({ content: fromDisk, previous: file, emitted: mine, editorMarkdown: serialized, body: fromDisk }),
    ).toBe('land')
  })
})
