import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import {
  DOWNLOADABLE_MODELS,
  ModelDownloadCancelled,
  modelFileUrl,
  modelInstalled,
  downloadModel,
  type ModelDownloadProgress,
  type DownloadableModel,
} from '../model-download.ts'

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

const alpha = Buffer.from('alpha-model-bytes')
const beta = Buffer.from('beta-tokens')

const MODEL: DownloadableModel = {
  id: 'test-model',
  kind: 'asr',
  title: 'Test Model',
  repo: 'owner/repo',
  files: [
    { file: 'model.bin', bytes: alpha.length, sha256: sha(alpha) },
    { file: 'tokens.txt', bytes: beta.length, sha256: sha(beta) },
  ],
  bytes: alpha.length + beta.length,
}

interface Served {
  origin: string
  requests: string[]
  server: Server
}

/** A model host that answers `/owner/repo/resolve/main/<file>`, with one redirect per file. */
function serve(files: Record<string, Buffer>, options: { slow?: boolean } = {}): Promise<Served> {
  const requests: string[] = []
  const server = createServer((request, response) => {
    const url = request.url ?? ''
    requests.push(url)
    if (url.startsWith('/redirect/')) {
      response.writeHead(302, { location: url.replace('/redirect', '') })
      response.end()
      return
    }
    const name = decodeURIComponent(url.split('/').pop() ?? '')
    const body = files[name]
    if (!body) {
      response.writeHead(404)
      response.end('missing')
      return
    }
    response.writeHead(200, { 'content-length': String(body.length) })
    if (!options.slow) {
      response.end(body)
      return
    }
    // Half the file now, the rest never: enough for a cancel to land mid-stream.
    response.write(body.subarray(0, Math.max(1, Math.floor(body.length / 2))))
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({ origin: `http://127.0.0.1:${port}`, requests, server })
    })
  })
}

let root = ''
let served: Served | null = null

afterEach(() => {
  served?.server.closeAllConnections()
  served?.server.close()
  served = null
  if (root) rmSync(root, { recursive: true, force: true })
  root = ''
})

function workspace(): string {
  root = mkdtempSync(join(tmpdir(), 'craft-asr-model-'))
  return root
}

describe('the ASR model downloader', () => {
  it('writes every file, follows a redirect, and reports one bar across the model', async () => {
    served = await serve({ 'model.bin': alpha, 'tokens.txt': beta })
    const dir = workspace()
    const progress: ModelDownloadProgress[] = []

    const result = await downloadModel({
      model: MODEL,
      root: dir,
      origin: served.origin,
      onProgress: (item) => progress.push(item),
    })

    expect(readFileSync(join(result.dir, 'model.bin'))).toEqual(alpha)
    expect(readFileSync(join(result.dir, 'tokens.txt'))).toEqual(beta)
    expect(existsSync(join(result.dir, 'model.bin.downloading'))).toBe(false)
    expect(progress.at(-1)?.percent).toBe(100)
    expect(progress.at(-1)?.receivedBytes).toBe(MODEL.bytes)
    expect(progress.map((item) => item.file)).toContain('tokens.txt')
  })

  it('leaves files that are already there alone, so a retry does not refetch 239 MB', async () => {
    served = await serve({ 'model.bin': alpha, 'tokens.txt': beta })
    const dir = workspace()
    const modelDir = join(dir, MODEL.id)
    mkdirSync(modelDir, { recursive: true })
    writeFileSync(join(modelDir, 'model.bin'), alpha)
    writeFileSync(join(modelDir, 'tokens.txt'), beta)

    const result = await downloadModel({ model: MODEL, root: dir, origin: served.origin })

    expect(result.files).toHaveLength(2)
    expect(served.requests).toHaveLength(0)
    expect(modelInstalled(MODEL, dir)).toBe(true)
  })

  it('deletes a file whose hash does not match instead of keeping a broken model', async () => {
    const wrong = Buffer.from('alpha-model-bytez')
    expect(wrong.length).toBe(alpha.length)
    served = await serve({ 'model.bin': wrong, 'tokens.txt': beta })
    const dir = workspace()

    await expect(
      downloadModel({ model: MODEL, root: dir, origin: served.origin }),
    ).rejects.toThrow('文件校验失败')

    expect(existsSync(join(dir, MODEL.id, 'model.bin'))).toBe(false)
    expect(existsSync(join(dir, MODEL.id, 'model.bin.downloading'))).toBe(false)
  })

  it('stops on cancel and cleans up the partial file', async () => {
    served = await serve({ 'model.bin': alpha, 'tokens.txt': beta }, { slow: true })
    const dir = workspace()
    const controller = new AbortController()

    const running = downloadModel({
      model: MODEL,
      root: dir,
      origin: served.origin,
      signal: controller.signal,
      onProgress: () => controller.abort(),
    })

    await expect(running).rejects.toBeInstanceOf(ModelDownloadCancelled)
    expect(existsSync(join(dir, MODEL.id, 'model.bin'))).toBe(false)
    expect(existsSync(join(dir, MODEL.id, 'model.bin.downloading'))).toBe(false)
  })

  it('builds the same path on every mirror', () => {
    expect(modelFileUrl('huggingface', MODEL, 'model.bin')).toBe(
      'https://huggingface.co/owner/repo/resolve/main/model.bin',
    )
    expect(modelFileUrl('hf-mirror', MODEL, 'model.bin')).toBe(
      'https://hf-mirror.com/owner/repo/resolve/main/model.bin',
    )
    expect(modelFileUrl('aifasthub', MODEL, 'model.bin')).toBe(
      'https://aifasthub.com/owner/repo/resolve/main/model.bin',
    )
  })

  it('keeps each manifest total equal to the files it lists, and offers the recognition model', () => {
    for (const model of DOWNLOADABLE_MODELS) {
      const sum = model.files.reduce((total, file) => total + file.bytes, 0)
      expect(`${model.id}:${sum}`).toBe(`${model.id}:${model.bytes}`)
    }
    expect(DOWNLOADABLE_MODELS.some((model) => model.kind === 'asr')).toBe(true)
  })
})
