import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { executeAsrToolCommand } from '../asr-commands.ts'
import type { AsrConfig } from '../../media/index.ts'

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'craft-asr-'))
  // A project folder, so `assets/` has a content root to live under.
  writeFileSync(join(dir, 'config.json'), '{}')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const asrConfig = (mode: 'local' | 'cloud', cloud: AsrConfig['cloud'] = {}): AsrConfig => ({
  version: 1,
  mode,
  local: {},
  cloud,
})

describe('asr_tool', () => {
  it('cloud transcription sends the recording in one request and writes an SRT', async () => {
    mkdirSync(join(dir, 'assets'), { recursive: true })
    const recording = join(dir, 'assets', 'a.wav')
    writeFileSync(recording, 'not-really-wav')

    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      return new Response(
        JSON.stringify({
          result: {
            text: 'hello world',
            utterances: [{ start_time: 0, end_time: 1200, text: 'hello world' }],
          },
          audio_info: { duration: 1200 },
        }),
        { status: 200, headers: { 'X-Api-Status-Code': '20000000' } },
      )
    }) as unknown as typeof fetch

    const out = join(dir, 'assets', 'a.srt')
    const result = await executeAsrToolCommand({
      command: ['transcribe', recording, '--out', out],
      workspaceRootPath: dir,
      config: asrConfig('cloud', { provider: 'doubao' }),
      cloudKey: 'k',
      fetchImpl,
    })

    expect(result.output).toContain('Wrote')
    expect(calls).toBe(1)
    const srt = readFileSync(out, 'utf8')
    expect(srt).toContain('00:00:00,000 --> 00:00:01,200')
    expect(srt).toContain('hello world')
  })

  it('refuses an output name it cannot write, before spending a request', async () => {
    const recording = join(dir, 'a.wav')
    writeFileSync(recording, 'not-really-wav')
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      return new Response('', { status: 200 })
    }) as unknown as typeof fetch

    const out = join(dir, 'a.docx')
    const result = await executeAsrToolCommand({
      command: ['transcribe', recording, '--out', out],
      workspaceRootPath: dir,
      config: asrConfig('cloud', { provider: 'doubao' }),
      cloudKey: 'k',
      fetchImpl,
    })

    expect(result.output).toContain('.txt')
    expect(result.output).toContain('.srt')
    expect(calls).toBe(0)
    expect(existsSync(out)).toBe(false)

    const asked = await executeAsrToolCommand({
      command: ['transcribe', recording, '--out', join(dir, 'a.srt'), '--format', 'xml'],
      workspaceRootPath: dir,
      config: asrConfig('cloud', { provider: 'doubao' }),
      cloudKey: 'k',
      fetchImpl,
    })
    expect(asked.output).toContain('--format')
    expect(calls).toBe(0)
  })

  it('an OpenAI-compatible server needs no key and uses the address and model it was given', async () => {
    mkdirSync(join(dir, 'assets'), { recursive: true })
    const recording = join(dir, 'assets', 'crisp.wav')
    writeFileSync(recording, 'not-really-wav')

    let seenUrl = ''
    let seenAuth: string | null = 'unset'
    let seenModel = ''
    let seenLanguage = ''
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seenUrl = String(url)
      seenAuth = new Headers(init?.headers).get('Authorization')
      const form = init?.body as FormData
      seenModel = String(form.get('model') ?? '')
      seenLanguage = String(form.get('language') ?? '')
      return new Response(
        JSON.stringify({
          text: 'hello world',
          duration: 1.2,
          segments: [{ start: 0, end: 1.2, text: 'hello world' }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }) as unknown as typeof fetch

    const out = join(dir, 'assets', 'crisp.srt')
    const result = await executeAsrToolCommand({
      command: ['transcribe', recording, '--out', out],
      workspaceRootPath: dir,
      config: asrConfig('cloud', {
        provider: 'openai',
        baseUrl: 'http://127.0.0.1:9000',
        model: 'large-v3',
        language: 'zh',
      }),
      cloudKey: null,
      fetchImpl,
    })

    expect(seenUrl).toBe('http://127.0.0.1:9000/v1/audio/transcriptions')
    expect(seenAuth).toBeNull()
    expect(seenModel).toBe('large-v3')
    // No --language flag: the language saved in Settings is the one sent.
    expect(seenLanguage).toBe('zh')
    expect(result.output).toContain('Wrote')
    expect(readFileSync(out, 'utf8')).toContain('00:00:00,000 --> 00:00:01,200')
  })

  it('answers with the JSON envelope when --format json is asked for', async () => {
    mkdirSync(join(dir, 'assets'), { recursive: true })
    const recording = join(dir, 'assets', 'c2.wav')
    writeFileSync(recording, 'not-really-wav')
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ result: { text: 'hello world' }, audio_info: { duration: 1200 } }), {
        status: 200,
        headers: { 'X-Api-Status-Code': '20000000' },
      })) as unknown as typeof fetch

    const result = await executeAsrToolCommand({
      command: ['transcribe', recording, '--format', 'json'],
      workspaceRootPath: dir,
      config: asrConfig('cloud', { provider: 'doubao' }),
      cloudKey: 'k',
      fetchImpl,
    })

    const payload = JSON.parse(result.output) as {
      ok: boolean
      text: string
      utterances: unknown[]
      durationMs?: number
      channel?: string
    }
    expect(payload).toMatchObject({
      ok: true,
      text: 'hello world',
      utterances: [],
      channel: '火山豆包（录音文件极速版）',
    })
    expect(payload.durationMs).toBe(1200)
  })

  it('answers with the SRT body when --format srt is asked for, without a file', async () => {
    mkdirSync(join(dir, 'assets'), { recursive: true })
    const recording = join(dir, 'assets', 'c3.wav')
    writeFileSync(recording, 'not-really-wav')
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          result: {
            text: 'hello world',
            utterances: [{ start_time: 0, end_time: 1200, text: 'hello world' }],
          },
          audio_info: { duration: 1200 },
        }),
        { status: 200, headers: { 'X-Api-Status-Code': '20000000' } },
      )) as unknown as typeof fetch

    const result = await executeAsrToolCommand({
      command: ['transcribe', recording, '--format', 'srt'],
      workspaceRootPath: dir,
      config: asrConfig('cloud', { provider: 'doubao' }),
      cloudKey: 'k',
      fetchImpl,
    })

    expect(result.output).toContain('00:00:00,000 --> 00:00:01,200')
    expect(result.output).toContain('hello world')
  })

  it('refuses to transcribe in the cloud without a key', async () => {
    mkdirSync(join(dir, 'assets'), { recursive: true })
    const recording = join(dir, 'assets', 'e.wav')
    writeFileSync(recording, 'not-really-wav')
    const result = await executeAsrToolCommand({
      command: ['transcribe', recording],
      workspaceRootPath: dir,
      config: asrConfig('cloud', { provider: 'doubao' }),
      cloudKey: null,
    })
    expect(result.output).toContain('还没有密钥')
  })

  it('cloud transcription refuses a container the service cannot read', async () => {
    mkdirSync(join(dir, 'assets'), { recursive: true })
    const recording = join(dir, 'assets', 'b.m4a')
    writeFileSync(recording, 'not-really-audio')
    const result = await executeAsrToolCommand({
      command: ['transcribe', recording],
      workspaceRootPath: dir,
      config: asrConfig('cloud', { provider: 'doubao' }),
      cloudKey: 'k',
    })
    expect(result.output).toContain('wav / mp3 / ogg')
  })
})
