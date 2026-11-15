import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractArtifacts, outFlags, splitCommand } from '../extract'
import { formatOfPath, normalizeArtifactPath, placeOfPath, titleOfPath } from '../paths'
import { createCreationsCache, refreshCreations } from '../scan'

describe('splitCommand', () => {
  it('keeps a quoted path as one argument', () => {
    expect(splitCommand('create --from a.csv --out "C:\\My Docs\\a b.xlsx"')).toEqual([
      'create',
      '--from',
      'a.csv',
      '--out',
      'C:\\My Docs\\a b.xlsx',
    ])
  })

  it('accepts an argv array and ignores a non-string', () => {
    expect(splitCommand(['convert', 'a.md', '--to', 'pdf'])).toEqual(['convert', 'a.md', '--to', 'pdf'])
    expect(splitCommand(undefined)).toEqual([])
  })
})

describe('outFlags', () => {
  it('reads both --out forms and stops at a flag', () => {
    expect(outFlags(['apply', 'a.docx', '--out', 'b.docx'])).toEqual(['b.docx'])
    expect(outFlags(['render', 'a.docx', '--out=x.png'])).toEqual(['x.png'])
    expect(outFlags(['render', 'a.docx', '--out', '--page', '2'])).toEqual([])
  })
})

describe('extractArtifacts', () => {
  it('takes Write as a created file and Edit as a modified one', () => {
    // A `Write` creates a file but does not *name an output* — that distinction is the filter
    // that keeps a checkout's `package.json` out of the library.
    expect(extractArtifacts('Write', { file_path: 'C:\\a\\b.md', content: 'x' })).toEqual([
      { raw: 'C:\\a\\b.md', role: 'created', explicit: false, tool: 'Write' },
    ])
    expect(extractArtifacts('Edit', { file_path: 'C:\\a\\b.md' })[0]).toMatchObject({
      role: 'modified',
      explicit: false,
    })
  })

  it('reads only --out from a create, never its --from source', () => {
    const hits = extractArtifacts('docx_tool', {
      command: 'create --type xlsx --from t.csv --out workbooks/w.xlsx --header',
    })
    expect(hits.map((hit) => hit.raw)).toEqual(['workbooks/w.xlsx'])
    expect(hits[0]).toMatchObject({ role: 'created', explicit: true })
  })

  it('takes the document itself when the verb edits it in place', () => {
    const hits = extractArtifacts('docx_tool', { command: 'apply report.docx --ops ops.json' })
    expect(hits).toEqual([{ raw: 'report.docx', role: 'modified', explicit: false, tool: 'docx_tool' }])
  })

  it('does not call the input of a conversion modified', () => {
    const hits = extractArtifacts('docx_tool', { command: 'convert notes.md --to docx --out notes.docx' })
    expect(hits).toEqual([{ raw: 'notes.docx', role: 'created', explicit: true, tool: 'docx_tool' }])
  })

  it('reads --to as the output of a drawio export', () => {
    const hits = extractArtifacts('drawio_tool', { command: 'export flows/a.drawio --to out/a.png --format png' })
    expect(hits.map((hit) => hit.raw)).toEqual(['out/a.png'])
  })

  it('reads the pdf a browser print wrote', () => {
    expect(extractArtifacts('browser_tool', { command: 'pdf --out C:\\tmp\\page.pdf --landscape' })[0]).toMatchObject({
      raw: 'C:\\tmp\\page.pdf',
      explicit: true,
    })
  })

  it('resolves transform_data output against the session data folder', () => {
    expect(extractArtifacts('transform_data', { outputFile: 'rows.json' })[0]?.raw).toBe('data/rows.json')
  })

  it('reads the file a media generate writes, and ignores a task it only watches', () => {
    expect(
      extractArtifacts('media_tool', {
        command: ['generate', '--prompt', 'x', '--out', 'assets/a.png'],
      }),
    ).toEqual([{ raw: 'assets/a.png', role: 'created', explicit: true, tool: 'media_tool' }])

    expect(
      extractArtifacts('media_tool', { command: 'transcribe --in a.mp3 --out a.md' }),
    ).toEqual([])

    // `task`/`cancel` name the artifact they wait for; naming it is not producing it.
    expect(extractArtifacts('media_tool', { command: 'task --out assets/a.png' })).toEqual([])
  })

  it('says nothing about a tool it does not know', () => {
    expect(extractArtifacts('Bash', { command: 'echo hi > out.md' })).toEqual([])
    expect(extractArtifacts('Write', { content: 'no path here' })).toEqual([])
  })
})

describe('paths', () => {
  const ctx = {
    workspaceRootPath: 'C:\\ws',
    sessionDir: 'C:\\ws\\sessions\\s1',
    cwd: 'C:\\ws\\projects\\p1',
  }

  it('substitutes the session placeholder older prompts left behind', () => {
    expect(normalizeArtifactPath('{{SESSION_PATH}}\\plans\\a.md', ctx)).toBe('C:\\ws\\sessions\\s1\\plans\\a.md')
  })

  it('expands ~ to the home directory, not to the workspace', () => {
    expect(normalizeArtifactPath('~/notes/a.md', ctx)).toBe(join(homedir(), 'notes\\a.md').replace(/\//g, '\\'))
  })

  it('resolves a relative path against the session cwd', () => {
    expect(normalizeArtifactPath('reports/a.pdf', ctx)).toBe('C:\\ws\\projects\\p1\\reports\\a.pdf')
  })

  it('drops the quotes a command line may carry', () => {
    expect(normalizeArtifactPath('"C:\\ws\\a b.md"', ctx)).toBe('C:\\ws\\a b.md')
  })

  it('classifies by extension and by place', () => {
    expect(formatOfPath('a.MD')).toBe('md')
    expect(formatOfPath('a.docx')).toBe('docx')
    expect(formatOfPath('a.png')).toBe('image')
    expect(formatOfPath('a.mp4')).toBe('video')
    expect(formatOfPath('a.mp3')).toBe('audio')
    expect(formatOfPath('a.zip')).toBeNull()
    expect(formatOfPath('noext')).toBeNull()

    expect(placeOfPath('C:\\ws\\sessions\\s1\\data\\a.md', 'C:\\ws')).toEqual({ place: 'session', projectSlug: null })
    expect(placeOfPath('C:\\ws\\projects\\p1\\a.md', 'C:\\ws')).toEqual({ place: 'project', projectSlug: 'p1' })
    expect(placeOfPath('C:\\ws\\sources\\x\\a.md', 'C:\\ws')).toEqual({ place: 'source', projectSlug: null })
    expect(placeOfPath('C:\\elsewhere\\a.md', 'C:\\ws')).toEqual({ place: 'external', projectSlug: null })
  })

  it('uses the file name as the title', () => {
    expect(titleOfPath('C:\\ws\\a\\b c.md')).toBe('b c.md')
  })
})

describe('refreshCreations', () => {
  /** A workspace with one session that wrote a document and one that edited a source file. */
  function buildWorkspace(): string {
    const root = mkdtempSync(join(tmpdir(), 'creations-'))
    const sessionDir = join(root, 'sessions', 's1')
    mkdirSync(join(sessionDir, 'data'), { recursive: true })
    mkdirSync(join(root, 'sources', 'api'), { recursive: true })
    mkdirSync(join(root, 'projects', 'p1'), { recursive: true })

    writeFileSync(join(sessionDir, 'data', 'report.md'), '# report\n', 'utf8')
    writeFileSync(join(sessionDir, 'data', 'rows.json'), '{}\n', 'utf8')
    // A picture is not a work for now: the library answers "what did this turn write", and a
    // gallery has its own questions (see `WORK_FORMATS`).
    writeFileSync(join(sessionDir, 'data', 'screenshot.png'), 'not really a png', 'utf8')
    writeFileSync(join(root, 'sources', 'api', 'guide.md'), '# guide\n', 'utf8')
    writeFileSync(join(root, 'projects', 'p1', 'deck.html'), '<html></html>', 'utf8')
    // The agent's own scratchpad for that project, which is not a deliverable.
    writeFileSync(join(root, 'projects', 'p1', 'MEMORY.md'), '# memory\n', 'utf8')
    // A skill definition, which is machinery however it is named.
    mkdirSync(join(root, 'projects', 'p1', '.agents', 'skills', 'x'), { recursive: true })
    writeFileSync(join(root, 'projects', 'p1', '.agents', 'skills', 'x', 'SKILL.md'), '# skill\n', 'utf8')

    const lines = [
      JSON.stringify({ id: 's1', name: '报告会话', workingDirectory: root }),
      JSON.stringify({
        id: 'm1',
        type: 'tool',
        timestamp: 1000,
        toolName: 'Write',
        toolInput: { file_path: join(sessionDir, 'data', 'report.md') },
      }),
      JSON.stringify({
        id: 'm2',
        type: 'tool',
        timestamp: 1001,
        toolName: 'Edit',
        toolInput: { file_path: join(root, 'sources', 'api', 'guide.md') },
      }),
      JSON.stringify({
        id: 'm3',
        type: 'tool',
        timestamp: 1002,
        toolName: 'Write',
        toolInput: { file_path: join(root, 'projects', 'p1', 'deck.html') },
      }),
      JSON.stringify({
        id: 'm4',
        type: 'tool',
        timestamp: 1003,
        toolName: 'Write',
        toolInput: { file_path: join(root, 'projects', 'p1', 'MEMORY.md') },
      }),
      JSON.stringify({
        id: 'm5',
        type: 'tool',
        timestamp: 1004,
        toolName: 'Write',
        toolInput: { file_path: join(root, 'projects', 'p1', '.agents', 'skills', 'x', 'SKILL.md') },
      }),
      JSON.stringify({
        id: 'm6',
        type: 'tool',
        timestamp: 1005,
        toolName: 'Write',
        toolInput: { file_path: join(sessionDir, 'data', 'rows.json') },
      }),
      JSON.stringify({
        id: 'm7',
        type: 'tool',
        timestamp: 1006,
        toolName: 'Write',
        toolInput: { file_path: join(sessionDir, 'data', 'screenshot.png') },
      }),
    ]
    writeFileSync(join(sessionDir, 'session.jsonl'), lines.join('\n') + '\n', 'utf8')
    return root
  }

  it('shows session and project documents, hides a source edit, and keeps provenance', async () => {
    const root = buildWorkspace()
    try {
      const snapshot = await refreshCreations(root, createCreationsCache())
      // `MEMORY.md` (the project's own memory), the skill file, the `.json` and the `.png` are all
      // absent: a work is a document, not the agent's scratchpad, its data, or its pictures.
      const titles = snapshot.creations.map((creation) => creation.title).sort()
      expect(titles).toEqual(['deck.html', 'report.md'])

      const report = snapshot.creations.find((creation) => creation.title === 'report.md')!
      expect(report.place).toBe('session')
      expect(report.exists).toBe(true)
      expect(report.last).toMatchObject({
        sessionId: 's1',
        sessionName: '报告会话',
        messageId: 'm1',
        tool: 'Write',
        role: 'created',
      })

      const deck = snapshot.creations.find((creation) => creation.title === 'deck.html')!
      expect(deck.projectSlug).toBe('p1')
      expect(snapshot.stats.hidden).toBeGreaterThan(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('re-parses only the session that changed', async () => {
    const root = buildWorkspace()
    try {
      const cache = createCreationsCache()
      const first = await refreshCreations(root, cache)
      expect(first.stats.parsed).toBe(1)

      const second = await refreshCreations(root, cache)
      expect(second.stats.parsed).toBe(0)
      expect(second.creations.length).toBe(first.creations.length)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps a deleted file out by default and shows it, greyed, when asked', async () => {
    const root = buildWorkspace()
    try {
      rmSync(join(root, 'sessions', 's1', 'data', 'report.md'))
      const cache = createCreationsCache()

      const withoutMissing = await refreshCreations(root, cache)
      expect(withoutMissing.creations.map((creation) => creation.title)).not.toContain('report.md')

      const withMissing = await refreshCreations(root, cache, { includeMissing: true })
      const gone = withMissing.creations.find((creation) => creation.title === 'report.md')!
      expect(gone.exists).toBe(false)
      expect(gone.bytes).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('shows the source-tree edits too when the caller asks for them', async () => {
    const root = buildWorkspace()
    try {
      // `includeSources` lifts the *place* filter, never the format or bookkeeping ones.
      const snapshot = await refreshCreations(root, createCreationsCache(), { includeSources: true })
      expect(snapshot.creations.map((creation) => creation.title).sort()).toEqual([
        'deck.html',
        'guide.md',
        'report.md',
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('finds a document on disk that no tool ever named, and says which session folder it was in', async () => {
    const root = mkdtempSync(join(tmpdir(), 'creations-disk-'))
    try {
      const sessionDir = join(root, 'sessions', 's9')
      mkdirSync(join(sessionDir, 'data'), { recursive: true })
      mkdirSync(join(root, 'projects', 'p9'), { recursive: true })
      // Made by a command line, so no tool call names it.
      writeFileSync(join(sessionDir, 'data', 'report.docx'), 'x', 'utf8')
      writeFileSync(join(root, 'projects', 'p9', 'book.xlsx'), 'x', 'utf8')
      // Text is the transcript's job: a markdown file nobody wrote is a copy, not a work.
      writeFileSync(join(sessionDir, 'data', 'scraped.md'), 'x', 'utf8')
      writeFileSync(
        join(sessionDir, 'session.jsonl'),
        JSON.stringify({ id: 's9', name: '测试会话', workingDirectory: root }) + '\n',
        'utf8',
      )

      const snapshot = await refreshCreations(root, createCreationsCache())
      const titles = snapshot.creations.map((creation) => creation.title).sort()
      expect(titles).toEqual(['book.xlsx', 'report.docx'])

      const docx = snapshot.creations.find((creation) => creation.title === 'report.docx')!
      expect(docx.last).toMatchObject({ tool: 'disk', sessionId: 's9', sessionName: '测试会话', messageId: '' })

      const xlsx = snapshot.creations.find((creation) => creation.title === 'book.xlsx')!
      expect(xlsx.place).toBe('project')
      expect(xlsx.projectSlug).toBe('p9')
      expect(xlsx.last.sessionId).toBe('')
      expect(snapshot.stats.discovered).toBe(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('leaves a document the transcript named with its real provenance', async () => {
    const root = mkdtempSync(join(tmpdir(), 'creations-provenance-'))
    try {
      const sessionDir = join(root, 'sessions', 's1')
      mkdirSync(join(sessionDir, 'data'), { recursive: true })
      const file = join(sessionDir, 'data', 'created.docx')
      writeFileSync(file, 'x', 'utf8')
      writeFileSync(
        join(sessionDir, 'session.jsonl'),
        [
          JSON.stringify({ id: 's1', name: '写入者', workingDirectory: root }),
          JSON.stringify({
            id: 'm1',
            type: 'tool',
            timestamp: 1000,
            toolName: 'Write',
            toolInput: { file_path: file },
          }),
        ].join('\n') + '\n',
        'utf8',
      )

      const snapshot = await refreshCreations(root, createCreationsCache())
      const creation = snapshot.creations.find((item) => item.title === 'created.docx')!
      // The turn that wrote it beats "it is in that folder" — that is what the index is for.
      expect(creation.last).toMatchObject({ tool: 'Write', messageId: 'm1' })
      expect(snapshot.stats.discovered).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('shows generated media a tool named or a note proves, and leaves a dropped-in file out', async () => {
    const root = mkdtempSync(join(tmpdir(), 'creations-media-'))
    try {
      const sessionDir = join(root, 'sessions', 's1')
      const projectDir = join(root, 'projects', 'p1')
      mkdirSync(join(sessionDir, 'assets'), { recursive: true })
      mkdirSync(join(projectDir, 'assets'), { recursive: true })
      writeFileSync(
        join(projectDir, 'config.json'),
        JSON.stringify({ id: 'p1', slug: 'p1' }),
        'utf8',
      )

      // Named by the tool that made it: `media_tool generate --out`.
      writeFileSync(join(sessionDir, 'assets', 'named.png'), 'png', 'utf8')
      // Made by a panel that has no transcript: the note beside it is the proof.
      writeFileSync(join(sessionDir, 'assets', 'noted.png'), 'png', 'utf8')
      writeFileSync(
        join(sessionDir, 'assets', 'noted.gen.json'),
        JSON.stringify({ file: 'assets/noted.png', prompt: 'a cat', references: [], at: 2000 }),
        'utf8',
      )
      // A picture a person dropped in: no note, so nothing claims it was made.
      writeFileSync(join(sessionDir, 'assets', 'dropped.png'), 'png', 'utf8')
      // A clip from the project's canvas.
      writeFileSync(join(projectDir, 'assets', 'clip.mp4'), 'mp4', 'utf8')
      writeFileSync(
        join(projectDir, 'assets', 'clip.gen.json'),
        JSON.stringify({ file: 'assets/clip.mp4', prompt: 'a wave', references: [], at: 2001 }),
        'utf8',
      )

      writeFileSync(
        join(sessionDir, 'session.jsonl'),
        [
          JSON.stringify({ id: 's1', name: '媒体会话', workingDirectory: root }),
          JSON.stringify({
            id: 'm1',
            type: 'tool',
            timestamp: 1000,
            toolName: 'media_tool',
            toolInput: {
              command: ['generate', '--prompt', 'x', '--out', join(sessionDir, 'assets', 'named.png')],
            },
          }),
        ].join('\n') + '\n',
        'utf8',
      )

      const snapshot = await refreshCreations(root, createCreationsCache())
      const titles = snapshot.creations.map((creation) => creation.title).sort()
      expect(titles).toEqual(['clip.mp4', 'named.png', 'noted.png'])

      const named = snapshot.creations.find((creation) => creation.title === 'named.png')!
      expect(named.format).toBe('image')
      expect(named.last).toMatchObject({
        sessionId: 's1',
        sessionName: '媒体会话',
        messageId: 'm1',
        tool: 'media_tool',
        role: 'created',
      })

      const noted = snapshot.creations.find((creation) => creation.title === 'noted.png')!
      expect(noted.format).toBe('image')
      expect(noted.last).toMatchObject({ sessionId: 's1', tool: 'media' })

      const clip = snapshot.creations.find((creation) => creation.title === 'clip.mp4')!
      expect(clip.format).toBe('video')
      expect(clip.place).toBe('project')
      expect(clip.projectSlug).toBe('p1')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('survives a workspace with no sessions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'creations-empty-'))
    try {
      const snapshot = await refreshCreations(root, createCreationsCache())
      expect(snapshot.creations).toEqual([])
      expect(snapshot.stats.sessions).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
