import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeHtmlToolCommand, htmlHelp } from '../html-commands'

const dir = mkdtempSync(join(tmpdir(), 'html-tool-'))
const PAGE = `<!doctype html>
<html>
  <head><title>报告</title></head>
  <body>
    <h1>标题</h1>
    <main>
      <p>第一段。</p>
      <section><span>里面</span></section>
    </main>
  </body>
</html>
`
writeFileSync(join(dir, 'page.html'), PAGE)
const run = (command: string) => executeHtmlToolCommand({ command, workspaceRootPath: dir })

describe('html_tool elements', () => {
  it('lists every element by the path the editor addresses it with', async () => {
    const out = await run('elements page.html')
    expect(out.output).toContain('1/1/0')
    expect(out.output).toContain('p')
    expect(out.output).toContain('第一段。')
    expect(out.output).toContain('element(s)')
  })

  it('quotes text only for elements that hold text and nothing else', async () => {
    const out = await run('elements page.html')
    const main = out.output.split('\n').find((line) => line.startsWith('1/1 '))
    expect(main).toContain('main')
    expect(main).not.toContain('第一段')
  })

  it('orders paths as numbers, not as strings', async () => {
    const wide = '<html><body>' + '<p>x</p>'.repeat(12) + '</body></html>'
    writeFileSync(join(dir, 'wide.html'), wide)
    const out = await run('elements wide.html')
    // `<body>` is `1` (parse5 puts an empty `<head>` first), so its children are `1/0` … `1/11` — and `1/10`
    // has to follow `1/9`, which sorting the paths as strings would not do.
    const paths = out.output.split("\n").filter((line) => /^1\/[0-9]+ /.test(line)).map((line) => line.split(" ")[0])
    expect(paths).toHaveLength(12)
    expect(paths.slice(8)).toEqual(["1/8", "1/9", "1/10", "1/11"])
  })

  it('is read only', async () => {
    const before = readFileSync(join(dir, 'page.html'), 'utf8')
    await run('elements page.html')
    expect(readFileSync(join(dir, 'page.html'), 'utf8')).toBe(before)
  })

  it('prints help, and refuses a command it does not have', async () => {
    expect((await run('')).output).toBe(htmlHelp())
    expect((await run('rewrite page.html')).output).toContain('Unknown command "rewrite"')
  })
})

describe('html_tool set', () => {
  const fresh = () => {
    const name = `set-${Math.random().toString(36).slice(2)}.html`
    writeFileSync(join(dir, name), PAGE)
    return name
  }

  it('replaces one element and leaves every other byte alone', async () => {
    const name = fresh()
    const result = await run(`set ${name} --path 1/1/0 --html "<p>第一段，改过。</p>"`)
    expect(result.output).toContain('Replaced <p> at 1/1/0')
    const after = readFileSync(join(dir, name), 'utf8')
    expect(after).toContain('<p>第一段，改过。</p>')
    expect(after).toContain('  <body>') // indentation untouched
    expect(after).toContain('<section><span>里面</span></section>')
  })

  it('refuses a path nobody printed, and names the ones it has', async () => {
    const name = fresh()
    const before = readFileSync(join(dir, name), 'utf8')
    const result = await run(`set ${name} --path 9/9 --html "<p>x</p>"`)
    expect(result.output.startsWith('Error:')).toBe(true)
    expect(result.output).toContain('No element at path 9/9')
    expect(readFileSync(join(dir, name), 'utf8')).toBe(before)
  })
})

describe('html_tool edit', () => {
  const fresh = () => {
    const name = `edit-${Math.random().toString(36).slice(2)}.html`
    writeFileSync(join(dir, name), PAGE)
    return name
  }

  it('changes one occurrence on disk when no editor is showing the page', async () => {
    const name = fresh()
    const result = await run(`edit ${name} --expect "第一段。" --text "第一段，改过。"`)
    expect(result.output).toContain('on disk')
    expect(readFileSync(join(dir, name), 'utf8')).toContain('第一段，改过。')
  })

  it('prefers the editor showing the page', async () => {
    const name = fresh()
    const seen: unknown[] = []
    const out = await executeHtmlToolCommand({
      command: `edit ${name} --expect "第一段。" --text "第一段，改过。"`,
      workspaceRootPath: dir,
      applyEdit: async (_p, edit) => {
        seen.push(edit)
        return { ok: true }
      },
    })
    expect(seen).toEqual([{ kind: 'html', expectedText: '第一段。', text: '第一段，改过。' }])
    expect(out.output).toContain('open in the editor')
    expect(readFileSync(join(dir, name), 'utf8')).toBe(PAGE) // the editor owns it
  })

  it('refuses text that is not there, or there twice', async () => {
    const name = fresh()
    expect((await run(`edit ${name} --expect "没有" --text "x"`)).output).toContain('not in the file')
    const twice = `edit-${Math.random().toString(36).slice(2)}.html`
    writeFileSync(join(dir, twice), '<html><body><p>x</p><p>x</p></body></html>')
    expect((await run(`edit ${twice} --expect "x" --text "y"`)).output).toContain('more than once')
  })
})

describe('shot — the page as a picture', () => {
  it('asks the host for the page at the size it was given, scripts run by contract', async () => {
    const asked: Array<{ path: string; width: number; height: number; outDir: string }> = []
    const answer = await executeHtmlToolCommand({
      command: 'shot page.html --width 1280 --height 800',
      workspaceRootPath: dir,
      captureWebShot: async (request) => {
        asked.push(request)
        // The host wrote a picture; its contents are not this layer's business.
        const file = join(request.outDir, 'page.png')
        writeFileSync(file, Buffer.from('89504e470d0a1a0a', 'hex'))
        return [file]
      },
    })
    expect(asked).toHaveLength(1)
    expect(asked[0]!.path).toBe(join(dir, 'page.html'))
    expect(asked[0]!.width).toBe(1280)
    expect(asked[0]!.height).toBe(800)
    // The picture rides the reply, and the sentence says what it is — the page, not its skeleton.
    expect(answer.images).toHaveLength(1)
    expect(answer.output).toContain('scripts run')
  })

  it('refuses a flag it does not take, and a size that is not a size', async () => {
    const unknown = await executeHtmlToolCommand({ command: 'shot page.html --scale 2', workspaceRootPath: dir })
    expect(unknown.output).toContain('shot does not take --scale')
    const silly = await executeHtmlToolCommand({ command: 'shot page.html --width 5', workspaceRootPath: dir })
    expect(silly.output).toContain('between 50 and 4000')
  })

  it('says which host cannot do it, rather than failing silently', async () => {
    const answer = await executeHtmlToolCommand({ command: 'shot page.html', workspaceRootPath: dir })
    expect(answer.output).toContain('no renderer')
    // And `elements` still works on that host: it reads the file itself.
    expect(answer.output).toContain('elements')
  })

  it('names shot in the help, so a caller can find it', () => {
    expect(htmlHelp()).toContain('shot <file>')
  })
})
