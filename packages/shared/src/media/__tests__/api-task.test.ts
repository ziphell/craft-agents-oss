import { describe, expect, test } from 'bun:test'
import { generateOverTaskApi, readPath } from '../providers/api-task.ts'
import { MediaFailure } from '../types.ts'

const mp4 = Uint8Array.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]) // ftyp…

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('generateOverTaskApi', () => {
  test('submits, polls until the task is done, then downloads the result', async () => {
    const calls: string[] = []
    let polls = 0
    const fetchImpl = (async (url: string) => {
      calls.push(url)
      if (url.endsWith('/v2/video_generation')) return json({ task_id: 'task-1' })
      if (url.includes('/v2/query/video_generation/task-1')) {
        polls += 1
        if (polls < 2) return json({ task: { status: 'running' } })
        return json({ task: { status: 'succeeded', content: { url: 'https://cdn.example.com/v.mp4' } } })
      }
      return new Response(mp4, { status: 200, headers: { 'content-type': 'video/mp4' } })
    }) as unknown as typeof fetch

    const seenTaskIds: string[] = []
    const result = await generateOverTaskApi({
      kind: 'video',
      baseUrl: 'https://metaso.cn/api/minimax',
      apiKey: 'k',
      body: { model: 'MiniMax-H3', content: [{ type: 'text', text: 'a wave' }] },
      submitPath: '/v2/video_generation',
      pollPath: '/v2/query/video_generation/{taskId}',
      statusPath: 'task.status',
      resultPath: 'task.content.url',
      pollMs: 0,
      fetch: fetchImpl,
      onTaskId: (id) => seenTaskIds.push(id),
    })

    expect(seenTaskIds).toEqual(['task-1'])
    expect(polls).toBe(2)
    expect(result.filename.endsWith('.mp4')).toBe(true)
    expect(result.taskId).toBe('task-1')
    expect(calls[0]).toBe('https://metaso.cn/api/minimax/v2/video_generation')
  })

  test('a failed task reports the provider reason and names no retry', async () => {
    const fetchImpl = (async (url: string) => {
      if (url.endsWith('/v2/video_generation')) return json({ task_id: 't2' })
      return json({ task: { status: 'failed', message: '内容审核不通过' } })
    }) as unknown as typeof fetch

    const error = await generateOverTaskApi({
      kind: 'video',
      baseUrl: 'https://x',
      apiKey: 'k',
      body: {},
      submitPath: '/v2/video_generation',
      pollPath: '/v2/query/video_generation/{taskId}',
      pollMs: 0,
      fetch: fetchImpl,
    }).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(MediaFailure)
    expect((error as MediaFailure).message).toContain('内容审核不通过')
  })

  test('a timeout says to re-query the task, not to submit again', async () => {
    const fetchImpl = (async (url: string) => {
      if (url.endsWith('/v2/video_generation')) return json({ task_id: 't3' })
      return json({ task: { status: 'running' } })
    }) as unknown as typeof fetch

    const error = await generateOverTaskApi({
      kind: 'video',
      baseUrl: 'https://x',
      apiKey: 'k',
      body: {},
      submitPath: '/v2/video_generation',
      pollPath: '/v2/query/video_generation/{taskId}',
      pollMs: 1,
      timeoutMs: 20,
      fetch: fetchImpl,
    }).catch((cause: unknown) => cause)

    expect((error as MediaFailure).message).toContain('t3')
    expect((error as MediaFailure).message).toContain('重新查询')
  })

  test('a 402 is about the account, and quotes the provider', async () => {
    const fetchImpl = (async () =>
      json(
        {
          type: 'error',
          error: { type: 'insufficient_balance_error', message: 'H3 积分余额不足 (1008)' },
        },
        402,
      )) as unknown as typeof fetch

    const error = await generateOverTaskApi({
      kind: 'video',
      baseUrl: 'https://x',
      apiKey: 'k',
      body: {},
      submitPath: '/v2/video_generation',
      pollPath: '/v2/query/video_generation/{taskId}',
      fetch: fetchImpl,
    }).catch((cause: unknown) => cause)

    const message = (error as MediaFailure).message
    expect(message).toContain('余额')
    expect(message).toContain('H3 积分余额不足')
    // One prefix, not two: the failure class already says which layer failed.
    expect(message.startsWith('生成失败：')).toBe(true)
    expect(message.startsWith('生成失败：生成失败：')).toBe(false)
  })

  test('readPath walks dotted paths and array indexes', () => {
    const payload = { data: [{ url: ['https://a/1.png'] }] }
    expect(readPath(payload, 'data.0.url.0')).toBe('https://a/1.png')
    expect(readPath(payload, 'data.1.url')).toBeUndefined()
    expect(readPath(payload, undefined)).toBe(payload)
  })
})
