import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { executeMediaToolCommand } from '../media-commands.ts'
import { readMediaTask } from '../../media/index.ts'
import type { MediaChannel, MediaSettings } from '../../media/index.ts'

/** Speech unconfigured, so a test is about the command rather than a saved choice. */
const allowAll: MediaSettings = {
  version: 1,
  speech: { tts: {} },
}

/** The command, with test channels. */
const runMedia = (args: Parameters<typeof executeMediaToolCommand>[0]) =>
  executeMediaToolCommand({
    ...args,
    ...(args.channels ? { settings: args.settings ?? allowAll } : {}),
  })

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'craft-media-'))
  // A project folder, so the note has somewhere to be written. `config.json` is the only marker.
  writeFileSync(join(dir, 'config.json'), '{}')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 9, 9, 9, 9])
const b64 = Buffer.from(pngBytes).toString('base64')

const relay: MediaChannel = {
  id: 'relay',
  name: '中转',
  protocol: 'openai-image',
  baseUrl: 'https://api.test/v1',
  apiKey: 'k',
  models: ['img-1'],
  defaultModel: 'img-1',
}

/** One fake provider: records what was sent, answers with base64 bytes. */
const fakeApi = (response: Partial<{ ok: boolean; status: number; text: string }> = {}) => {
  const calls: Array<{ url: string; body?: unknown; headers?: Record<string, string> }> = []
  const fetchImpl = (async (
    url: string,
    init?: { body?: unknown; headers?: Record<string, string> },
  ) => {
    calls.push({ url, body: init?.body, headers: init?.headers })
    if (response.ok === false) {
      return {
        ok: false,
        status: response.status ?? 400,
        text: async () => response.text ?? 'bad request',
      } as unknown as Response
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: 'gen-1', data: [{ b64_json: b64 }] }),
    } as unknown as Response
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

describe('media_tool channels', () => {
  it('lists what each channel makes and which models it can reach', async () => {
    const result = await runMedia({
      command: ['channels'],
      workspaceRootPath: dir,
      channels: [relay],
    })
    expect(result.output).toContain('relay')
    expect(result.output).toContain('中转')
    expect(result.output).toContain('img-1')
    expect(result.output).not.toContain('缺密钥')
  })

  it('says a channel without a key has none', async () => {
    const result = await runMedia({
      command: ['channels'],
      workspaceRootPath: dir,
      channels: [{ ...relay, apiKey: undefined }],
    })
    expect(result.output).toContain('缺密钥')
  })

  it('points at the file to configure when nothing is set up', async () => {
    const result = await runMedia({ command: ['channels'], workspaceRootPath: dir, channels: [] })
    expect(result.output).toContain('media-channels.json')
  })

  it('does not offer the legacy chat account as an account that draws', async () => {
    const result = await runMedia({
      command: ['channels'],
      workspaceRootPath: dir,
      channels: [{ ...relay, id: 'chat', preset: 'chat' }],
    })
    expect(result.output).not.toContain('chat')
    expect(result.output).toContain('No channels')
  })

  it('prints the choices each account offers, so the agent need not know vendor fields', async () => {
    const result = await runMedia({
      command: ['channels'],
      workspaceRootPath: dir,
      channels: [
        {
          ...relay,
          options: { ratio: ['16:9', '9:16'], duration: [4, 8], voice: ['Cherry', 'Serena'] },
        },
      ],
    })
    expect(result.output).toContain('duration 4/8')
    expect(result.output).toContain('ratio 16:9/9:16')
    expect(result.output).toContain('voice Cherry/Serena')
    expect(result.output).toContain('[default img-1]')
  })

  it('names the parameters only a particular model accepts', async () => {
    const result = await runMedia({
      command: ['channels'],
      workspaceRootPath: dir,
      channels: [
        {
          ...relay,
          models: ['t2i-1', 'edit-1'],
          defaultModel: 't2i-1',
          paramSpecs: [
            { key: 'size', type: 'select', options: ['1024', '1536'], default: '1024' },
            { key: 'strength', type: 'number', min: 0, max: 1, default: 0.6, models: ['edit-1'] },
          ],
        },
      ],
    })
    expect(result.output).toContain('options: size 1024/1536 (default 1024)')
    expect(result.output).toContain('edit-1: strength 0..1 (default 0.6)')
    expect(result.output).not.toContain('t2i-1: strength')
  })
})

describe('media_tool generate', () => {
  it('lands a generated file in the project assets by default, with its source note', async () => {
    const { fetchImpl } = fakeApi()
    const result = await runMedia({
      command: ['generate', '--prompt', 'a lighthouse'],
      workspaceRootPath: dir,
      channels: [relay],
      fetchImpl,
    })
    expect(result.output).toContain(join(dir, 'assets'))
    const files = readdirSync(join(dir, 'assets'))
    expect(files.some((file) => file.endsWith('.png'))).toBe(true)
    expect(files.some((file) => file.endsWith('.gen.json'))).toBe(true)
  })

  it('lands a generated file in the conversation folder when it is in no project', async () => {
    const sessionDir = join(dir, 'sessions', 's-9')
    mkdirSync(sessionDir, { recursive: true })
    const { fetchImpl } = fakeApi()
    const result = await runMedia({
      command: ['generate', '--prompt', 'a lighthouse'],
      workspaceRootPath: dir,
      sessionId: 's-9',
      channels: [relay],
      fetchImpl,
    })
    expect(result.output).toContain(join(sessionDir, 'assets'))
    const files = readdirSync(join(sessionDir, 'assets'))
    expect(files.some((file) => file.endsWith('.png'))).toBe(true)
    expect(files.some((file) => file.endsWith('.gen.json'))).toBe(true)
    // The note says which conversation asked, so the asset can be traced back from the library.
    const noteFile = files.find((file) => file.endsWith('.gen.json'))!
    const note = JSON.parse(readFileSync(join(sessionDir, 'assets', noteFile), 'utf8'))
    expect(note.session).toBe('s-9')
  })

  it('keeps a disabled account visible, but never chooses it', async () => {
    const off: MediaChannel = { ...relay, enabled: false }
    const on: MediaChannel = { ...relay, id: 'on', name: '开启' }

    const listed = await runMedia({
      command: ['channels'],
      workspaceRootPath: dir,
      channels: [off],
    })
    expect(listed.output).toContain('已停用')

    const auto = await runMedia({
      command: ['generate', '--prompt', 'x'],
      workspaceRootPath: dir,
      channels: [off],
    })
    expect(auto.output.startsWith('Error')).toBe(true)
    expect(auto.output).toContain('disabled')

    const named = await runMedia({
      command: ['generate', '--prompt', 'x', '--channel', 'relay'],
      workspaceRootPath: dir,
      channels: [off, on],
      fetchImpl: fakeApi().fetchImpl,
    })
    expect(named.output.startsWith('Error')).toBe(true)
    expect(named.output).toContain('disabled')
  })

  it('turns named choices into provider params', async () => {
    const { calls, fetchImpl } = fakeApi()
    const result = await runMedia({
      command: [
        'generate',
        '--prompt',
        'a lighthouse',
        '--out',
        'out/made.png',
        '--ratio',
        '16:9',
        '--duration',
        '8',
      ],
      workspaceRootPath: dir,
      channels: [{ ...relay, options: { ratio: ['16:9'], duration: [8] } }],
      fetchImpl,
    })

    expect(result.output).toContain('Wrote')
    const sent = JSON.parse(String(calls[0]!.body))
    expect(sent.ratio).toBe('16:9')
    expect(sent.duration).toBe(8)
  })

  it('sends the model default the panel would show when the agent names nothing', async () => {
    const { calls, fetchImpl } = fakeApi()
    const result = await runMedia({
      command: ['generate', '--prompt', 'a lighthouse', '--out', 'out/made.png'],
      workspaceRootPath: dir,
      channels: [{ ...relay, options: { ratio: ['16:9', '9:16'] } }],
      fetchImpl,
    })

    expect(result.output).toContain('Wrote')
    const sent = JSON.parse(String(calls[0]!.body))
    expect(sent.ratio).toBe('16:9')
  })

  it('refuses a choice the account does not offer, and names the ones it does', async () => {
    const { calls, fetchImpl } = fakeApi()
    const result = await runMedia({
      command: ['generate', '--prompt', 'p', '--out', 'out.png', '--ratio', '4:3'],
      workspaceRootPath: dir,
      channels: [{ ...relay, options: { ratio: ['16:9', '9:16'] } }],
      fetchImpl,
    })

    expect(result.output).toContain('not offered')
    expect(result.output).toContain('16:9, 9:16')
    expect(calls.length).toBe(0)
  })

  it('sends the prompt, model, params and size, then writes the bytes', async () => {
    const { calls, fetchImpl } = fakeApi()

    const result = await runMedia({
      command: [
        'generate',
        '--prompt',
        'a lighthouse',
        '--out',
        'out/made.png',
        '--param',
        'size=1024x1024',
        '--param',
        'ratio=16:9',
      ],
      workspaceRootPath: dir,
      channels: [relay],
      fetchImpl,
    })

    expect(result.output).toContain('Wrote')
    expect(result.output).toContain('中转')

    const sent = JSON.parse(String(calls[0]!.body))
    expect(sent.prompt).toBe('a lighthouse')
    expect(sent.model).toBe('img-1')
    expect(sent.size).toBe('1024x1024')
    expect(sent.ratio).toBe('16:9')
    expect(calls[0]!.headers?.Authorization).toBe('Bearer k')

    expect(Array.from(readFileSync(join(dir, 'out/made.png')))).toEqual(Array.from(pngBytes))
  })

  it('leaves a note beside the result: prompt, channel and the references it was built from', async () => {
    writeFileSync(join(dir, 'ref.png'), pngBytes)
    const { fetchImpl } = fakeApi()

    await runMedia({
      command: ['generate', '--prompt', 'from a reference', '--out', 'made.png', '--input', 'ref.png'],
      workspaceRootPath: dir,
      channels: [relay],
      fetchImpl,
    })

    const note = JSON.parse(readFileSync(join(dir, 'made.gen.json'), 'utf8'))
    expect(note.file).toBe('made.png')
    expect(note.prompt).toBe('from a reference')
    expect(note.references).toEqual(['ref.png'])
    expect(note.channel).toBe('中转')
  })

  it('sends a reference image as a data URL', async () => {
    writeFileSync(join(dir, 'ref.png'), pngBytes)
    const { calls, fetchImpl } = fakeApi()

    await runMedia({
      command: ['generate', '--prompt', 'x', '--out', 'made.png', '--input', 'ref.png'],
      workspaceRootPath: dir,
      channels: [relay],
      fetchImpl,
    })

    const sent = JSON.parse(String(calls[0]!.body))
    expect(String(sent.image).startsWith('data:image/png;base64,')).toBe(true)
  })

  it('rewrites {{ref N}} for a hand-written prompt too', async () => {
    writeFileSync(join(dir, 'ref.png'), pngBytes)
    const { calls, fetchImpl } = fakeApi()

    await runMedia({
      command: ['generate', '--prompt', 'use {{ref 1}}', '--out', 'made.png', '--input', 'ref.png'],
      workspaceRootPath: dir,
      channels: [relay],
      fetchImpl,
    })

    expect(JSON.parse(String(calls[0]!.body)).prompt).toBe('use 图片1')
  })

  it('refuses a text file as a reference, and points at --prompt', async () => {
    writeFileSync(join(dir, 'brief.md'), '# a shot list')
    const { calls, fetchImpl } = fakeApi()

    const result = await runMedia({
      command: ['generate', '--prompt', 'x', '--out', 'made.png', '--input', 'brief.md'],
      workspaceRootPath: dir,
      channels: [relay],
      fetchImpl,
    })

    expect(result.output.startsWith('Error')).toBe(true)
    expect(result.output).toContain('--prompt')
    expect(calls.length).toBe(0)
  })

  it('picks the channel by id, and refuses an id it does not have', async () => {
    const { fetchImpl } = fakeApi()
    const other: MediaChannel = { ...relay, id: 'backup', name: '备用' }

    const chosen = await runMedia({
      command: ['generate', '--prompt', 'x', '--out', 'a.png', '--channel', 'backup'],
      workspaceRootPath: dir,
      channels: [relay, other],
      fetchImpl,
    })
    expect(chosen.output).toContain('备用')

    const missing = await runMedia({
      command: ['generate', '--prompt', 'x', '--out', 'b.png', '--channel', 'nope'],
      workspaceRootPath: dir,
      channels: [relay],
      fetchImpl,
    })
    expect(missing.output).toContain('nope')
    expect(missing.output.startsWith('Error')).toBe(true)
  })

  it('chooses the account that lists the model, not merely the first one', async () => {
    const { calls, fetchImpl } = fakeApi()
    const a: MediaChannel = {
      ...relay,
      id: 'a',
      name: 'A',
      baseUrl: 'https://a.test/v1',
      models: ['img-a'],
      defaultModel: 'img-a',
    }
    const b: MediaChannel = {
      ...relay,
      id: 'b',
      name: 'B',
      baseUrl: 'https://b.test/v1',
      models: ['img-b'],
      defaultModel: 'img-b',
    }

    const result = await runMedia({
      command: ['generate', '--prompt', 'x', '--out', 'a.png', '--model', 'img-b'],
      workspaceRootPath: dir,
      channels: [a, b],
      fetchImpl,
    })

    expect(result.output).toContain('B')
    expect(calls[0]!.url).toBe('https://b.test/v1/images/generations')
  })

  it('skips an account without a key when another can run', async () => {
    const broken: MediaChannel = { ...relay, id: 'broken', name: 'Broken', apiKey: undefined }
    const ready: MediaChannel = { ...relay, id: 'ready', name: 'Ready' }

    const result = await runMedia({
      command: ['generate', '--prompt', 'x', '--out', 'a.png'],
      workspaceRootPath: dir,
      channels: [broken, ready],
      fetchImpl: fakeApi().fetchImpl,
    })

    expect(result.output).toContain('Ready')
    expect(result.output).toContain('Wrote')
  })

  it('validates a named choice against the typed specs too', async () => {
    const { calls, fetchImpl } = fakeApi()
    const result = await runMedia({
      command: ['generate', '--prompt', 'p', '--out', 'x.png', '--ratio', '4:3'],
      workspaceRootPath: dir,
      channels: [
        {
          ...relay,
          paramSpecs: [
            { key: 'ratio', type: 'select', options: ['16:9', '9:16'], default: '16:9' },
          ],
        },
      ],
      fetchImpl,
    })

    expect(result.output).toContain('not offered')
    expect(result.output).toContain('16:9, 9:16')
    expect(calls.length).toBe(0)
  })

  it('names what is missing instead of guessing', async () => {
    const noPrompt = await runMedia({
      command: ['generate', '--out', 'x.png'],
      workspaceRootPath: dir,
      channels: [relay],
    })
    expect(noPrompt.output).toContain('--prompt')
  })

  it('passes a provider refusal through with its cause', async () => {
    const { fetchImpl } = fakeApi({ ok: false, status: 400, text: 'prompt was rejected' })

    const result = await runMedia({
      command: ['generate', '--prompt', 'x', '--out', 'x.png'],
      workspaceRootPath: dir,
      channels: [relay],
      fetchImpl,
    })

    expect(result.output).toContain('HTTP 400')
    expect(result.output).toContain('prompt was rejected')
  })

  it('lists unfinished tasks under the content root, so a lost path can be found again', async () => {
    const asyncChannel: MediaChannel = {
      ...relay,
      id: 'async',
      name: '异步',
      kind: 'video',
      pollPath: '/tasks/{taskId}',
      submitPath: '/tasks',
    }
    const fetchImpl = (async (url: string) => {
      if (url === 'https://api.test/v1/tasks') {
        return new Response(JSON.stringify({ task_id: 'p-2' }), {
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected ${url}`)
    }) as unknown as typeof fetch

    await runMedia({
      command: ['generate', '--prompt', 'x', '--out', 'out.mp4', '--channel', 'async', '--kind', 'video'],
      workspaceRootPath: dir,
      channels: [asyncChannel],
      fetchImpl,
    })

    const listed = await runMedia({
      command: ['tasks'],
      workspaceRootPath: dir,
      channels: [asyncChannel],
    })
    expect(listed.output).toContain(join(dir, 'out.mp4'))
    expect(listed.output).toContain('async')

    const otherKind = await runMedia({
      command: ['tasks', '--kind', 'image'],
      workspaceRootPath: dir,
      channels: [asyncChannel],
    })
    expect(otherKind.output).toContain('No media task')

    const badStatus = await runMedia({
      command: ['tasks', '--status', 'gone'],
      workspaceRootPath: dir,
      channels: [asyncChannel],
    })
    expect(badStatus.output.startsWith('Error')).toBe(true)
    expect(badStatus.output).toContain('--status')
  })

  it('returns as soon as an async channel has the job, and leaves a task file behind', async () => {
    const asyncChannel: MediaChannel = {
      ...relay,
      id: 'async',
      name: '异步',
      kind: 'video',
      pollPath: '/tasks/{taskId}',
      submitPath: '/tasks',
    }
    const fetchImpl = (async (url: string) => {
      if (url === 'https://api.test/v1/tasks') {
        return new Response(JSON.stringify({ task_id: 'p-1' }), {
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected ${url}`)
    }) as unknown as typeof fetch

    const result = await runMedia({
      command: ['generate', '--prompt', 'x', '--out', 'out.mp4', '--channel', 'async', '--kind', 'video'],
      workspaceRootPath: dir,
      channels: [asyncChannel],
      fetchImpl,
    })

    expect(result.output).toContain('Submitted')
    expect(existsSync(join(dir, 'out.mp4'))).toBe(false)
    expect(readMediaTask(join(dir, 'out.mp4'))?.providerTaskId).toBe('p-1')
  })
})

describe('media_tool models', () => {
  it('needs an account, because channels already lists the choices', async () => {
    const result = await runMedia({
      command: ['models'],
      workspaceRootPath: dir,
      channels: [relay],
    })
    expect(result.output.startsWith('Error')).toBe(true)
    expect(result.output).toContain('--channel')
    expect(result.output).toContain('channels')
  })

  it('names a disabled account instead of saying no model exists', async () => {
    const result = await runMedia({
      command: ['models', '--channel', 'relay'],
      workspaceRootPath: dir,
      channels: [{ ...relay, enabled: false }],
    })
    expect(result.output.startsWith('Error')).toBe(true)
    expect(result.output).toContain('disabled')
  })

  it('describes the models of the named account', async () => {
    const result = await runMedia({
      command: ['models', '--channel', 'relay'],
      workspaceRootPath: dir,
      channels: [relay],
    })
    expect(result.output).toContain('img-1')
  })
})

describe('media_tool music', () => {
  it('composes through a sound channel and names the file by its bytes', async () => {
    const bytes = new Uint8Array([9, 8, 7])
    const fetchImpl = (async (url: string) =>
      String(url).includes('/music_generation')
        ? new Response(
            JSON.stringify({
              data: { audio: 'https://cdn.example/song.mp3' },
              base_resp: { status_code: 0 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        : new Response(bytes, { status: 200, headers: { 'Content-Type': 'audio/mpeg' } })) as unknown as typeof fetch
    const music: MediaChannel = {
      id: 'mm-music',
      name: 'MiniMax 音乐',
      protocol: 'openai-image',
      baseUrl: 'https://api.test/v1',
      apiKey: 'k',
      kind: 'music',
      models: ['music-1.5'],
      defaultModel: 'music-1.5',
      submitPath: '/music_generation',
      bodyShape: 'minimax-music',
      resultPath: 'data.audio',
    }
    const result = await runMedia({
      command: [
        'generate',
        '--prompt',
        '独立民谣，忧郁，独自漫步',
        '--kind',
        'music',
        '--out',
        'song.mp3',
        '--param',
        'lyrics=[verse]\n街灯微亮',
      ],
      workspaceRootPath: dir,
      channels: [music],
      fetchImpl,
    })
    expect(result.output).toContain('Wrote')
    expect(readFileSync(join(dir, 'song.mp3'))).toEqual(Buffer.from(bytes))
  })

  it('refuses a subtitle file as lyrics', async () => {
    writeFileSync(join(dir, 'song.srt'), '1\n00:00:00,000 --> 00:00:01,200\n街灯微亮\n')
    const music: MediaChannel = {
      ...relay,
      id: 'mm-music',
      name: 'MiniMax 音乐',
      kind: 'music',
      models: ['music-1.5'],
      defaultModel: 'music-1.5',
      submitPath: '/music_generation',
      bodyShape: 'minimax-music',
      resultPath: 'data.audio',
    }
    const result = await runMedia({
      command: [
        'generate',
        '--prompt',
        '独立民谣',
        '--kind',
        'music',
        '--out',
        'song.mp3',
        '--lyrics',
        '@song.srt',
      ],
      workspaceRootPath: dir,
      channels: [music],
    })
    expect(result.output.startsWith('Error')).toBe(true)
    expect(result.output).toContain('subtitle')
  })
  it('takes the words from --lyrics @file and keeps the prompt as the style', async () => {
    writeFileSync(join(dir, 'song.txt'), '[verse]\n街灯微亮')
    const calls: Array<{ body?: unknown }> = []
    const bytes = new Uint8Array([1, 2, 3])
    const fetchImpl = (async (url: string, init?: { body?: unknown }) => {
      calls.push({ body: init?.body })
      return String(url).includes('/music_generation')
        ? new Response(
            JSON.stringify({
              data: { audio: 'https://cdn.example/song.mp3' },
              base_resp: { status_code: 0 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        : new Response(bytes, { status: 200, headers: { 'Content-Type': 'audio/mpeg' } })
    }) as unknown as typeof fetch
    const music: MediaChannel = {
      id: 'mm-music',
      name: 'MiniMax 音乐',
      protocol: 'openai-image',
      baseUrl: 'https://api.test/v1',
      apiKey: 'k',
      kind: 'music',
      models: ['music-1.5'],
      defaultModel: 'music-1.5',
      submitPath: '/music_generation',
      bodyShape: 'minimax-music',
      resultPath: 'data.audio',
    }

    const result = await runMedia({
      command: [
        'generate',
        '--prompt',
        '独立民谣，忧郁',
        '--kind',
        'music',
        '--out',
        'song.mp3',
        '--lyrics',
        '@song.txt',
      ],
      workspaceRootPath: dir,
      channels: [music],
      fetchImpl,
    })

    expect(result.output).toContain('Wrote')
    const sent = JSON.parse(String(calls[0]!.body))
    expect(sent.prompt).toBe('独立民谣，忧郁')
    expect(sent.lyrics).toBe('[verse]\n街灯微亮')
  })
})

describe('media_tool speech synthesis', () => {
  const openaiSpeech: MediaChannel = {
    id: 'speech',
    name: 'OpenAI 语音',
    protocol: 'openai-image',
    baseUrl: 'https://speech.test/v1',
    apiKey: 'k',
    kind: 'tts',
    models: ['tts-1'],
    defaultModel: 'tts-1',
    submitPath: '/audio/speech',
    bodyShape: 'openai-speech',
    responseShape: 'binary',
  }

  /** Speech is available because an account that can speak is present. */
  const speechOnly: MediaSettings = {
    ...allowAll,
  }

  it('speaks through the account the speech choice names', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const fetchImpl = (async () =>
      new Response(bytes, { status: 200, headers: { 'Content-Type': 'audio/mpeg' } })) as unknown as typeof fetch
    const result = await executeMediaToolCommand({
      command: ['generate', '--prompt', '你好', '--kind', 'tts', '--out', 'a.mp3'],
      workspaceRootPath: dir,
      channels: [openaiSpeech],
      settings: {
        ...speechOnly,
        speech: { tts: { channelId: 'speech', model: 'tts-1' } },
      },
      fetchImpl,
    })
    expect(result.output).toContain('Wrote')
    expect(result.output).toContain('OpenAI 语音')
    expect(readFileSync(join(dir, 'a.mp3'))).toEqual(Buffer.from(bytes))
  })

  it('refuses a subtitle file as the words to speak', async () => {
    writeFileSync(
      join(dir, 'script.srt'),
      '1\n00:00:00,000 --> 00:00:01,200\n第一句\n\n2\n00:00:01,200 --> 00:00:02,400\n第二句\n',
    )
    const calls: Array<{ body?: unknown }> = []
    const fetchImpl = (async (_url: string, init?: { body?: unknown }) => {
      calls.push({ body: init?.body })
      return new Response(new Uint8Array([1]), {
        status: 200,
        headers: { 'Content-Type': 'audio/mpeg' },
      })
    }) as unknown as typeof fetch

    const result = await executeMediaToolCommand({
      command: ['generate', '--prompt', '@script.srt', '--kind', 'tts', '--out', 'a.mp3'],
      workspaceRootPath: dir,
      channels: [openaiSpeech],
      settings: {
        ...speechOnly,
        speech: { tts: { channelId: 'speech', model: 'tts-1' } },
      },
      fetchImpl,
    })

    expect(result.output.startsWith('Error')).toBe(true)
    expect(result.output).toContain('subtitle')
    expect(calls.length).toBe(0)
  })

  it('refuses synthesis when no account can speak, naming the setting', async () => {
    const result = await executeMediaToolCommand({
      command: ['generate', '--prompt', '你好', '--kind', 'tts', '--out', 'a.mp3'],
      workspaceRootPath: dir,
      channels: [relay],
      settings: speechOnly,
    })
    expect(result.output).toContain('语音合成还没有可用的云端账号')
    expect(existsSync(join(dir, 'a.mp3'))).toBe(false)
  })
})

describe('media_tool text products', () => {
  it('no longer answers a reading verb, and points at its own commands only', async () => {
    const result = await runMedia({
      command: ['describe', '--image', 'shot.png'],
      workspaceRootPath: dir,
      channels: [relay],
    })

    expect(result.output).toContain('Unknown command "describe"')
    // The way out is its own --help; naming other doors is a hand-kept map that goes stale.
    expect(result.output).toContain('--help')
    expect(result.output).not.toContain('call_llm')
  })

  it('has no transcribe command left, and points nowhere else for one', async () => {
    writeFileSync(join(dir, 'voice.mp3'), new Uint8Array([1, 2, 3]))
    const result = await runMedia({
      command: ['transcribe', '--in', 'voice.mp3'],
      workspaceRootPath: dir,
      channels: [relay],
    })

    expect(result.output).toContain('Unknown command "transcribe"')
    expect(result.output).not.toContain('asr-tool')
  })
})
