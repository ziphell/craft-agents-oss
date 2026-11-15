import { describe, expect, it } from 'bun:test'
import { replaceOnce } from '../replace-once'

/**
 * The one rule both `markdown_tool edit` and `html_tool edit` stand on.
 *
 * The CRLF cases are the ones worth writing down: the *search* has to work when the caller thought in `\n` and the
 * file is stored with `\r\n`, and the *insertion* has to come out with the file's own line endings — otherwise an
 * edit that looked right produces a file with both kinds of newline in it.
 */
describe('replaceOnce', () => {
  it('replaces the one occurrence', () => {
    expect(replaceOnce('甲。乙。', '乙', '丙')).toEqual({ text: '甲。丙。' })
  })

  it('refuses text that is there twice, rather than picking one', () => {
    const outcome = replaceOnce('同一句。\n\n同一句。', '同一句。', 'x')
    expect(outcome).toEqual({ problem: 'that text appears more than once in the file' })
  })

  it('refuses text that is not there', () => {
    expect(replaceOnce('甲。', '乙。', 'x')).toEqual({ problem: 'that text is not in the file' })
  })

  it('refuses an empty needle', () => {
    expect(replaceOnce('甲。', '', 'x')).toEqual({ problem: 'there is no text to look for' })
  })

  it('finds a two-line needle in a CRLF file, and writes the replacement with CRLF', () => {
    const file = '# 标题\r\n\r\n第一段。\r\n第二段。\r\n'
    const outcome = replaceOnce(file, '第一段。\n第二段。', '第一段。\n第二段改。')
    expect(outcome).toEqual({ text: '# 标题\r\n\r\n第一段。\r\n第二段改。\r\n' })
  })

  it('leaves an LF file alone apart from the replacement', () => {
    const file = '# 标题\n\n第一段。\n第二段。\n'
    const outcome = replaceOnce(file, '第一段。\n第二段。', '第一段。\n第二段改。')
    expect(outcome).toEqual({ text: '# 标题\n\n第一段。\n第二段改。\n' })
  })

  it('still refuses an ambiguous needle in a CRLF file', () => {
    // The same two-line run twice: the retry must not turn "twice" into "the first one".
    const file = '甲。\r\n\r\n乙。\r\n\r\n甲。\r\n\r\n乙。\r\n'
    const outcome = replaceOnce(file, '甲。\n\n乙。', 'x')
    expect(outcome).toEqual({ problem: 'that text appears more than once in the file' })
  })
})
