import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { advanceMediaTask, cancelOrDetachMediaTask, createMediaTask } from '../task-runner.ts'
import { readMediaTask, taskPathFor, writeMediaTask } from '../tasks.ts'
import type { MediaChannel } from '../channels.ts'
import type { MediaTask } from '../tasks.ts'

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'craft-runner-'))
  // A project folder: the note only exists inside one.
  writeFileSync(join(dir, 'config.json'), '{}')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const mp4 = Uint8Array.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70])

const channel: MediaChannel = {
  id: 'relay',
  name: '中转',
  protocol: 'openai-image',
  baseUrl: 'https://api.test',
  apiKey: 'k',
  kind: 'video',
  models: ['vid-1'],
  defaultModel: 'vid-1',
  submitPath: '/v1/tasks',
  pollPath: '/v1/tasks/{taskId}',
  taskIdPath: 'task_id',
  statusPath: 'status',
  resultPath: 'output.url',
  pollMs: 1000,
}

const outPath = (): string => join(dir, 'canvas', 'assets', 'clip.mp4')

/** A provider that answers with a task id, then reports whatever `statuses` says, in order. */
const fakeProvider = (options: { statuses?: string[] } = {}) => {
  const statuses = [...(options.statuses ?? ['running', 'succeeded'])]
  const calls: Array<{ url: string; body?: unknown }> = []
  const fetchImpl = (async (url: string, init?: { body?: unknown }) => {
    calls.push({ url, body: init?.body })
    if (url === 'https://api.test/v1/tasks') {
      return new Response(JSON.stringify({ task_id: 'p-9' }), {
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url.includes('/v1/tasks/')) {
      const status = statuses.shift() ?? 'succeeded'
      const body =
        status === 'succeeded'
          ? { status, output: { url: 'https://cdn.test/made.mp4' } }
          : status === 'failed'
            ? { status, message: '内容审核不通过' }
            : { status }
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
    }
    return new Response(mp4, { headers: { 'content-type': 'video/mp4' } })
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

const newTask = (overrides: Partial<MediaTask> = {}): MediaTask => ({
  ...createMediaTask({
    outPath: outPath(),
    channelId: channel.id,
    kind: 'video',
    prompt: 'a wave at dusk',
    now: 1000,
  }),
  ...overrides,
})

describe('one step at a time', () => {
  test('the first step submits and remembers the provider id', async () => {
    const { calls, fetchImpl } = fakeProvider()
    const task = newTask()

    const step = await advanceMediaTask(task, { channels: [channel], fetch: fetchImpl, now: () => 1000 })

    expect(step.task.status).toBe('running')
    expect(step.task.providerTaskId).toBe('p-9')
    expect(step.task.nextPollAt).toBe(2000)
    expect(step.artifact).toBeUndefined()

    // The body is built from the task, never stored.
    const submitted = JSON.parse(String(calls[0]!.body))
    expect(submitted.content[0].text).toBe('a wave at dusk')

    // And the step is on disk: a process that dies here loses nothing.
    expect(readMediaTask(outPath())?.providerTaskId).toBe('p-9')
  })

  test('a channel that wants an upload puts the reference behind an id', async () => {
    const reference = join(dir, 'frame.png')
    writeFileSync(reference, Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]))
    const calls: Array<{ url: string; body?: unknown }> = []
    const fetchImpl = (async (url: string, init?: { body?: unknown }) => {
      calls.push({ url, body: init?.body })
      if (url === 'https://api.test/v1/files/upload') {
        return new Response(
          JSON.stringify({ file: { file_id: 'f-1' }, base_resp: { status_code: 0 } }),
          { headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(JSON.stringify({ task_id: 'p-1' }), {
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const uploading: MediaChannel = {
      ...channel,
      upload: { path: '/v1/files/upload', purpose: 'video_generation_input', refPrefix: 'mm_file://' },
    }
    const step = await advanceMediaTask(newTask({ references: [reference] }), {
      channels: [uploading],
      fetch: fetchImpl,
      now: () => 1000,
    })

    expect(step.task.status).toBe('running')
    const submitted = calls.find((call) => call.url === 'https://api.test/v1/tasks')
    const body = JSON.parse(String(submitted?.body))
    expect(body.content[1].image_url.url).toBe('mm_file://f-1')
  })

  test('the next steps only ask — the task is never submitted twice', async () => {
    const { calls, fetchImpl } = fakeProvider({ statuses: ['running', 'succeeded'] })
    let task = newTask()

    task = (await advanceMediaTask(task, { channels: [channel], fetch: fetchImpl, now: () => 1000 })).task
    task = (await advanceMediaTask(task, { channels: [channel], fetch: fetchImpl, now: () => 2000 })).task

    expect(task.status).toBe('running')
    expect(task.attempts).toBe(1)
    expect(task.nextPollAt).toBe(3000)
    expect(calls.filter((call) => call.url === 'https://api.test/v1/tasks')).toHaveLength(1)
  })

  test('the last step writes the artifact, the note, and closes the task', async () => {
    const { fetchImpl } = fakeProvider({ statuses: ['succeeded'] })
    const task = newTask({ providerTaskId: 'p-9', status: 'running' })
    // A task that was already submitted: the runner must not create a new one.
    writeMediaTask(task)

    const step = await advanceMediaTask(task, { channels: [channel], fetch: fetchImpl, now: () => 5000 })

    expect(step.task.status).toBe('succeeded')
    expect(step.artifact?.path).toBe(outPath())
    expect(Array.from(readFileSync(outPath()))).toEqual(Array.from(mp4))
    expect(existsSync(taskPathFor(outPath()))).toBe(false)

    const note = JSON.parse(readFileSync(join(dir, 'canvas', 'assets', 'clip.gen.json'), 'utf8'))
    expect(note.file).toBe('canvas/assets/clip.mp4')
    expect(note.prompt).toBe('a wave at dusk')
    expect(note.channel).toBe('中转')
    expect(note.model).toBe('vid-1')
  })

  test('a task with a provider id is never submitted again, even when asked twice', async () => {
    const { calls, fetchImpl } = fakeProvider({ statuses: ['running'] })
    const task = newTask({ providerTaskId: 'p-9', status: 'running' })

    await advanceMediaTask(task, { channels: [channel], fetch: fetchImpl, now: () => 1000 })

    expect(calls.some((call) => call.url === 'https://api.test/v1/tasks')).toBe(false)
  })
})

describe('what ends a task', () => {
  test('the provider saying failed ends it, with its reason, and keeps the record', async () => {
    const { fetchImpl } = fakeProvider({ statuses: ['failed'] })
    const task = newTask({ providerTaskId: 'p-9', status: 'running' })

    const step = await advanceMediaTask(task, { channels: [channel], fetch: fetchImpl, now: () => 1000 })

    expect(step.task.status).toBe('failed')
    expect(step.task.error).toContain('内容审核不通过')
    expect(readMediaTask(outPath())?.status).toBe('failed')
  })

  test('a lost submit answer is submission_unknown, and is never submitted again', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls++
      throw new Error('socket hang up')
    }) as unknown as typeof fetch

    const step = await advanceMediaTask(newTask(), {
      channels: [channel],
      fetch: fetchImpl,
      now: () => 1000,
    })

    expect(step.task.status).toBe('submission_unknown')
    expect(step.task.error).toContain('socket hang up')
    expect(step.task.providerTaskId).toBeUndefined()
    expect(readMediaTask(outPath())?.status).toBe('submission_unknown')

    // Asking again would pay twice: with no provider id there is nothing to poll, so the next step
    // must not send another submit.
    const again = await advanceMediaTask(step.task, {
      channels: [channel],
      fetch: fetchImpl,
      now: () => 2000,
    })
    expect(again.task.status).toBe('submission_unknown')
    expect(calls).toBe(1)
  })

  test('a parameter the channel does not offer fails before the provider is called', async () => {
    const limited = { ...channel, options: { duration: [5] } }
    const { calls, fetchImpl } = fakeProvider()
    const step = await advanceMediaTask(newTask({ params: { duration: 9 } }), {
      channels: [limited],
      fetch: fetchImpl,
      now: () => 1000,
    })

    expect(step.task.status).toBe('failed')
    expect(step.task.error).toContain('不支持')
    expect(calls).toHaveLength(0)
  })

  test('a request the capability refuses is stopped before a task file is written', () => {
    const limited = { ...channel, options: { duration: [5] } }
    expect(() =>
      createMediaTask({
        outPath: outPath(),
        channelId: channel.id,
        kind: 'video',
        prompt: 'a wave at dusk',
        params: { duration: 9 },
        channel: limited,
      }),
    ).toThrow('不支持')
    expect(existsSync(taskPathFor(outPath()))).toBe(false)
  })

  test('a refused submit ends the task with the provider’s answer', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { message: 'bad size' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch

    const step = await advanceMediaTask(newTask(), {
      channels: [channel],
      fetch: fetchImpl,
      now: () => 1000,
    })

    expect(step.task.status).toBe('failed')
    expect(step.task.error).toContain('bad size')
  })

  test('a poll that cannot reach the provider keeps the task alive and asks later', async () => {
    const fetchImpl = (async (url: string) => {
      if (url === 'https://api.test/v1/tasks') {
        return new Response(JSON.stringify({ task_id: 'p-9' }), { headers: { 'content-type': 'application/json' } })
      }
      throw new Error('offline')
    }) as unknown as typeof fetch

    const task = newTask({ providerTaskId: 'p-9', status: 'running' })
    const step = await advanceMediaTask(task, { channels: [channel], fetch: fetchImpl, now: () => 1000 })

    expect(step.task.status).toBe('running')
    expect(step.task.attempts).toBe(1)
    expect(step.task.nextPollAt).toBe(2000)
    expect(step.task.error).toContain('offline')
  })

  test('a channel that is gone ends the task with a sentence', async () => {
    const step = await advanceMediaTask(newTask(), { channels: [], now: () => 1000 })
    expect(step.task.status).toBe('failed')
    expect(step.task.error).toContain('relay')
  })

  test('the deadline ends a task the provider never answered', async () => {
    const { fetchImpl } = fakeProvider({ statuses: ['running'] })
    const task = newTask({ providerTaskId: 'p-9', status: 'running' })

    const step = await advanceMediaTask(task, {
      channels: [channel],
      fetch: fetchImpl,
      now: () => task.expiresAt + 1,
    })

    expect(step.task.status).toBe('failed')
    expect(step.task.error).toContain('分钟没有结果')
  })

  test('a finished task is returned untouched', async () => {
    const { calls, fetchImpl } = fakeProvider()
    const task = newTask({ status: 'succeeded' })

    await advanceMediaTask(task, { channels: [channel], fetch: fetchImpl, now: () => 1000 })

    expect(calls).toHaveLength(0)
  })
})

describe('stopping the waiting, not the provider', () => {
  test('a channel with no cancel endpoint keeps running, in the background', async () => {
    const task = newTask({ providerTaskId: 'p-9', status: 'running', nextPollAt: 5000 })
    writeMediaTask(task)

    const result = await cancelOrDetachMediaTask(task, { channels: [channel], now: () => 1200 })

    expect(result.detached).toBe(true)
    expect(result.task.status).toBe('running')
    expect(result.task.detached).toBe(true)
    // Still pollable: the driver's next pass will ask about it and the file will land.
    expect(result.task.nextPollAt).toBe(5000)
    expect(readMediaTask(outPath())?.detached).toBe(true)
  })

  test('a channel that can cancel is asked, and the task ends', async () => {
    const cancellable: MediaChannel = { ...channel, cancelPath: '/v1/tasks/{taskId}/cancel' }
    const calls: string[] = []
    const fetchImpl = (async (url: string) => {
      calls.push(url)
      return new Response('{}', { headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    const task = newTask({ providerTaskId: 'p-9', status: 'running' })
    writeMediaTask(task)

    const result = await cancelOrDetachMediaTask(task, {
      channels: [cancellable],
      fetch: fetchImpl,
      now: () => 1200,
    })

    expect(calls).toEqual(['https://api.test/v1/tasks/p-9/cancel'])
    expect(result.detached).toBe(false)
    expect(result.task.status).toBe('cancelled')
    expect(readMediaTask(outPath())?.status).toBe('cancelled')
  })

  test('a refusal is still detached, because the job may be running', async () => {
    const cancellable: MediaChannel = { ...channel, cancelPath: '/v1/tasks/{taskId}/cancel' }
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { message: 'cannot cancel now' } }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch
    const task = newTask({ providerTaskId: 'p-9', status: 'running' })

    const result = await cancelOrDetachMediaTask(task, {
      channels: [cancellable],
      fetch: fetchImpl,
      now: () => 1200,
    })

    expect(result.detached).toBe(true)
    expect(result.task.status).toBe('running')
    expect(result.message).toContain('cannot cancel now')
  })

  test('a task that was never submitted is simply cancelled', async () => {
    const task = newTask({ status: 'queued' })
    writeMediaTask(task)

    const result = await cancelOrDetachMediaTask(task, { channels: [channel], now: () => 1200 })

    expect(result.detached).toBe(false)
    expect(result.task.status).toBe('cancelled')
  })
})
