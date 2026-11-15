import { describe, expect, it } from 'bun:test'
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { executeMarkdownToolCommand, markdownHelp } from '../markdown-commands'

const dir = mkdtempSync(join(tmpdir(), 'md-tool-'))
const file = join(dir, 'SKILL.md')
writeFileSync(
  file,
  '---\nname: daily\ndescription: 日报\n---\n\n# 日报\n\n第一段。\n\n- 甲\n- 乙\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n',
)

const run = (command: string) => executeMarkdownToolCommand({ command, workspaceRootPath: dir })

describe('markdown_tool blocks', () => {
  it('numbers the body’s blocks from zero, and leaves the frontmatter out of the count', async () => {
    const result = await run('blocks SKILL.md')
    expect(result.output.startsWith('Error:')).toBe(false)
    expect(result.output).toContain('#0  heading    # 日报')
    expect(result.output).toContain('#1  paragraph  第一段。')
    expect(result.output).toContain('#2  list       - 甲')
    expect(result.output).toContain('#3  table      | a | b |')
    expect(result.output).toContain('4 block(s)')
    expect(result.output).toContain('frontmatter is not a block')
  })

  it('is read only: the file is unchanged afterwards', async () => {
    const before = (await import('node:fs')).readFileSync(file, 'utf8')
    await run('blocks SKILL.md')
    expect((await import('node:fs')).readFileSync(file, 'utf8')).toBe(before)
  })
})

describe('markdown_tool frontmatter', () => {
  it('prints the YAML without its fences', async () => {
    const result = await run('frontmatter SKILL.md')
    expect(result.output).toBe('---\nname: daily\ndescription: 日报\n---')
  })

  it('says so when there is none, rather than printing nothing', async () => {
    writeFileSync(join(dir, 'plain.md'), '# 标题\n\n正文。\n')
    expect((await run('frontmatter plain.md')).output).toContain('has no frontmatter')
  })
})

describe('the command line itself', () => {
  it('prints help for nothing at all', async () => {
    expect((await run('')).output).toBe(markdownHelp())
  })

  it('refuses a command it does not have, by name', async () => {
    const result = await run('rewrite SKILL.md')
    expect(result.output.startsWith('Error:')).toBe(true)
    expect(result.output).toContain('Unknown command "rewrite"')
  })

  it('says which file it could not read', async () => {
    const result = await run('blocks missing.md')
    expect(result.output.startsWith('Error:')).toBe(true)
    expect(result.output).toContain('missing.md')
  })
})

describe('markdown_tool set', () => {
  const fresh = () => {
    const target = join(dir, `set-${Math.random().toString(36).slice(2)}.md`)
    writeFileSync(target, '---\nname: x\n---\n\n# 标题\n\n第一段。\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n')
    return basename(target)
  }

  it('replaces one block and keeps every other byte — the table keeps its own alignment', async () => {
    const name = fresh()
    const result = await run(`set ${name} --block 1 --text "第一段，改过。"`)
    expect(result.output).toContain('Replaced block #1')
    const after = readFileSync(join(dir, name), 'utf8')
    expect(after).toBe('---\nname: x\n---\n\n# 标题\n\n第一段，改过。\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n')
  })

  it('refuses text that would split the block in two, and writes nothing', async () => {
    const name = fresh()
    const before = readFileSync(join(dir, name), 'utf8')
    const result = await run(`set ${name} --block 1 --text "甲\n\n乙"`)
    expect(result.output.startsWith('Error:')).toBe(true)
    expect(result.output).toContain('go from 3 block(s) to 4')
    expect(readFileSync(join(dir, name), 'utf8')).toBe(before)
  })

  it('refuses a block number nobody printed', async () => {
    const name = fresh()
    expect((await run(`set ${name} --block 9 --text "x"`)).output).toContain('There is no block #9')
  })
})

describe('markdown_tool frontmatter writes', () => {
  const fresh = () => {
    const target = join(dir, `fm-${Math.random().toString(36).slice(2)}.md`)
    writeFileSync(target, '---\nname: x\n---\n\n# 标题\n\n正文。\n')
    return basename(target)
  }

  it('replaces the YAML and leaves the body alone', async () => {
    const name = fresh()
    await run(`frontmatter ${name} --set "name: y\ndescription: 新"`)
    expect(readFileSync(join(dir, name), 'utf8')).toBe('---\nname: y\ndescription: 新\n---\n\n# 标题\n\n正文。\n')
  })

  it('removes it entirely', async () => {
    const name = fresh()
    await run(`frontmatter ${name} --remove`)
    expect(readFileSync(join(dir, name), 'utf8')).toBe('# 标题\n\n正文。\n')
  })
})

describe('markdown_tool edit', () => {
  const write = (name: string, body: string) => {
    writeFileSync(join(dir, name), body)
    return name
  }

  it('changes one occurrence on disk when no editor is showing the file', async () => {
    const name = write('plain-edit.md', '# 标题\n\n甲段。\n\n乙段。\n')
    const result = await run(`edit ${name} --expect "乙段。" --text "乙段，改过。"`)
    expect(result.output).toContain('on disk')
    expect(readFileSync(join(dir, name), 'utf8')).toBe('# 标题\n\n甲段。\n\n乙段，改过。\n')
  })

  it('prefers the editor: an open document takes the change instead of the disk', async () => {
    const name = write('open-edit.md', '# 标题\n\n甲段。\n')
    const seen: unknown[] = []
    const out = await executeMarkdownToolCommand({
      command: `edit ${name} --expect "甲段。" --text "甲段，改过。"`,
      workspaceRootPath: dir,
      applyEdit: async (_path, edit) => {
        seen.push(edit)
        return { ok: true }
      },
    })
    expect(seen).toEqual([{ kind: 'markdown', expectedText: '甲段。', text: '甲段，改过。' }])
    expect(out.output).toContain('open document')
    expect(readFileSync(join(dir, name), 'utf8')).toBe('# 标题\n\n甲段。\n') // untouched: the editor owns it
  })

  it('passes an editor refusal through, and writes nothing', async () => {
    const name = write('refuse-edit.md', '# 标题\n\n甲段。\n')
    const out = await executeMarkdownToolCommand({
      command: `edit ${name} --expect "甲段。" --text "x"`,
      workspaceRootPath: dir,
      applyEdit: async () => ({ ok: false, message: 'that text appears more than once in the document' }),
    })
    expect(out.output.startsWith('Error:')).toBe(true)
    expect(out.output).toContain('more than once')
    expect(readFileSync(join(dir, name), 'utf8')).toBe('# 标题\n\n甲段。\n')
  })

  it('falls back to the file when no editor answers', async () => {
    const name = write('fallback-edit.md', '# 标题\n\n甲段。\n')
    const out = await executeMarkdownToolCommand({
      command: `edit ${name} --expect "甲段。" --text "甲段改。"`,
      workspaceRootPath: dir,
      applyEdit: async () => null, // nothing is showing it
    })
    expect(out.output).toContain('no editor is showing it')
    expect(readFileSync(join(dir, name), 'utf8')).toBe('# 标题\n\n甲段改。\n')
  })

  it('refuses text that is not there, and text that is there twice', async () => {
    const once = write('miss-edit.md', '# 标题\n\n甲段。\n')
    expect((await run(`edit ${once} --expect "没有这句" --text "x"`)).output).toContain('not in the file')
    const twice = write('twice-edit.md', '同一句。\n\n同一句。\n')
    expect((await run(`edit ${twice} --expect "同一句。" --text "x"`)).output).toContain('more than once')
  })

  it('keeps a CRLF file in CRLF', async () => {
    const name = write('crlf.md', '# 标题\r\n\r\n甲段。\r\n')
    await run(`edit ${name} --expect "甲段。" --text "甲段改。"`)
    expect(readFileSync(join(dir, name), 'utf8')).toBe('# 标题\r\n\r\n甲段改。\r\n')
  })
})

describe('shot — the document as a reader sees it', () => {
  it('asks for the size it was given, and answers with the picture', async () => {
    const asked: Array<{ path: string; width: number; height: number }> = []
    const answer = await executeMarkdownToolCommand({
      command: 'shot doc.md --width 900 --height 1400',
      workspaceRootPath: dir,
      captureMarkdownShot: async (request) => {
        asked.push({ path: request.path, width: request.width, height: request.height })
        const file = join(request.outDir, 'doc.png')
        writeFileSync(file, Buffer.from('89504e470d0a1a0a', 'hex'))
        return [file]
      },
    })
    expect(asked).toHaveLength(1)
    expect(asked[0]).toEqual({ path: join(dir, 'doc.md'), width: 900, height: 1400 })
    expect(answer.images).toHaveLength(1)
    expect(answer.output).toContain('as the reader draws it')
  })

  it('defaults to the card, and refuses a flag it does not take', async () => {
    const asked: Array<{ width: number; height: number }> = []
    await executeMarkdownToolCommand({
      command: 'shot doc.md',
      workspaceRootPath: dir,
      captureMarkdownShot: async (request) => {
        asked.push({ width: request.width, height: request.height })
        return []
      },
    })
    expect(asked[0]).toEqual({ width: 800, height: 900 })
    const unknown = await executeMarkdownToolCommand({ command: 'shot doc.md --page 2', workspaceRootPath: dir })
    expect(unknown.output).toContain('shot does not take --page')
  })

  it('says which host cannot draw it', async () => {
    const answer = await executeMarkdownToolCommand({ command: 'shot doc.md', workspaceRootPath: dir })
    expect(answer.output).toContain('no renderer')
    expect(answer.output).toContain('blocks')
  })
})
