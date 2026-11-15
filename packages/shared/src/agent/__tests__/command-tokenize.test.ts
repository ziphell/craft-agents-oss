import { describe, it, expect } from 'bun:test'
import { tokenizeCommand } from '../command-cli.ts'

/**
 * The command line is shared by every pane door, and it is typed on Windows as often as not.
 *
 * `--out "C:\temp\notes.txt"` read as escapes is a tab and a newline — the path is gone before any
 * code sees it, and the failure surfaces at the filesystem ("no such file or directory") pointing at
 * a string nobody typed. A Windows path is therefore taken literally; text arguments still decode.
 */
describe('tokenizeCommand > paths and escapes', () => {
  it('keeps a Windows path path-shaped', () => {
    const [, , path] = tokenizeCommand('screenshot --out "C:\\temp\\notes\\shot.png"')
    expect(path).toBe('C:\\temp\\notes\\shot.png')
  })

  it('keeps backslashes in an unquoted Windows path', () => {
    const [, , path] = tokenizeCommand('upload @e1 C:\\Users\\Ryan\\a.txt')
    expect(path).toBe('C:\\Users\\Ryan\\a.txt')
  })

  it('keeps a UNC path path-shaped', () => {
    const [, , path] = tokenizeCommand('screenshot --out "\\\\server\\share\\shot.png"')
    expect(path).toBe('\\\\server\\share\\shot.png')
  })

  it('still decodes escapes in text, which is what they are for', () => {
    const [, text] = tokenizeCommand('paste Name\\tAge\\nAlice\\t30')
    expect(text).toBe('Name\tAge\nAlice\t30')
  })

  it('still honours quotes around text', () => {
    expect(tokenizeCommand('type "hello world"')).toEqual(['type', 'hello world'])
  })
})
