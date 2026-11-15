import { describe, expect, test } from 'bun:test'
import { mimeOfFile, uploadFileOverApi } from '../providers/api-upload.ts'
import { MediaFailure } from '../types.ts'

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const upload = (fetchImpl: FetchLike) =>
  uploadFileOverApi({
    baseUrl: 'https://api.minimax.cn',
    path: '/v1/files/upload',
    purpose: 'video_generation_input',
    bytes: Uint8Array.from([1, 2, 3]),
    mimeType: 'image/png',
    filename: 'frame.png',
    apiKey: 'k',
    fetch: fetchImpl as unknown as typeof fetch,
  })

describe('uploading a reference file', () => {
  test('posts a multipart file with its purpose and returns the id', async () => {
    let form: FormData | null = null
    let headers: Record<string, string> = {}
    const result = await upload(async (_url, init) => {
      form = init?.body as FormData
      headers = init?.headers as Record<string, string>
      return json({ file: { file_id: 'f-1', bytes: 3 }, base_resp: { status_code: 0 } })
    })

    expect(headers.Authorization).toBe('Bearer k')
    expect((form as unknown as FormData).get('purpose')).toBe('video_generation_input')
    expect((form as unknown as FormData).get('file')).toBeInstanceOf(Blob)
    expect(result.fileId).toBe('f-1')
  })

  test('a base_resp refusal is an upload failure with the provider sentence', async () => {
    const attempt = upload(async () =>
      json({ file: {}, base_resp: { status_code: 1027, status_msg: 'invalid file format' } }),
    )
    await expect(attempt).rejects.toBeInstanceOf(MediaFailure)
    await expect(attempt).rejects.toThrow('invalid file format')
  })

  test('an answer without a file id is not a successful upload', async () => {
    const attempt = upload(async () => json({ file: {}, base_resp: { status_code: 0 } }))
    await expect(attempt).rejects.toThrow('没有 file_id')
  })

  test('the MIME follows the file name, including video and audio', () => {
    expect(mimeOfFile('a.png')).toBe('image/png')
    expect(mimeOfFile('a.mp4')).toBe('video/mp4')
    expect(mimeOfFile('a.wav')).toBe('audio/wav')
    expect(mimeOfFile('a.unknown')).toBe('application/octet-stream')
  })
})
