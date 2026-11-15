/**
 * The one part of local speech recognition that needs the network: getting the model here.
 *
 * A model is a folder of files, and the app knows which folder name it looks for, so a download is
 * "put these files in `<root>/<model>/`". Three things make that safe rather than a bare GET:
 *
 * - **mirrors.** The same path works on huggingface.co and its two mirrors; only the origin changes,
 *   so an unreachable host is a choice, not a dead end.
 * - **an unfinished file is named as such.** Bytes land in `<file>.downloading` and the name is
 *   only swapped when the size and hash match, so a dropped connection cannot leave a plausible but
 *   broken ONNX behind.
 * - **a hash, not a hope.** The model pages publish SHA-256 for the large files; a mismatch deletes
 *   what was written instead of letting sherpa fail later with an unreadable tensor.
 *
 * The downloader itself is plain Node (no N-API): it is the settings page's work, not the
 * transcriber's, and it must run where the models live — the machine that will call `asr-tool`.
 */

import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { get as httpGet, type IncomingMessage } from 'node:http'
import { get as httpsGet } from 'node:https'
import { join } from 'node:path'

/** One file of a model, with what it must weigh once it is here. */
export interface ModelFile {
  file: string
  bytes: number
  /** The upstream SHA-256, when the host publishes one (large files are stored by it). */
  sha256?: string
}

/** A model this app can fetch by itself. */
export interface DownloadableModel {
  /** The folder name, which is also how the engine recognises it. */
  id: string
  /** What the model is for. The settings page shows only its own kind. */
  kind: 'asr'
  /** What a person sees. A model name, not a translated phrase. */
  title: string
  /** `owner/repo` on the model host. */
  repo: string
  files: ModelFile[]
  /** Every file together — what the settings page shows before a download starts. */
  bytes: number
}

/**
 * Where a model can come from, in the order the settings page offers them.
 *
 * The path below `/resolve/main/` is identical on all three; a build that reaches one of them
 * should not be a build that cannot reach the others.
 */
export const MODEL_MIRRORS = [
  { id: 'huggingface', label: 'Hugging Face', host: 'huggingface.co' },
  { id: 'hf-mirror', label: 'HF Mirror', host: 'hf-mirror.com' },
  { id: 'aifasthub', label: 'AIFastHub', host: 'aifasthub.com' },
] as const

export type ModelMirror = (typeof MODEL_MIRRORS)[number]['id']

/**
 * The models the app offers to download.
 *
 * One kind, one flow: SenseVoice for words in. Each entry is data rather than a branch in a page,
 * so a new model does not add a second downloader.
 */
export const DOWNLOADABLE_MODELS: readonly DownloadableModel[] = [
  {
    id: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17',
    kind: 'asr',
    title: 'SenseVoice Small',
    repo: 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17',
    files: [
      {
        file: 'model.int8.onnx',
        bytes: 239_233_841,
        sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51',
      },
      {
        file: 'tokens.txt',
        bytes: 315_894,
        sha256: 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc',
      },
    ],
    bytes: 239_549_735,
  },
]

export function findDownloadableModel(id?: string): DownloadableModel | undefined {
  const wanted = id?.trim()
  return wanted ? DOWNLOADABLE_MODELS.find((model) => model.id === wanted) : DOWNLOADABLE_MODELS[0]
}

/** The URL of one file on a mirror — the only part that differs between hosts. */
export function modelFileUrl(mirror: ModelMirror, model: DownloadableModel, file: string): string {
  const host = MODEL_MIRRORS.find((item) => item.id === mirror)?.host ?? MODEL_MIRRORS[0].host
  return `https://${host}/${model.repo}/resolve/main/${file}`
}

/** Whether every file of this model is already here, at the size it should be. */
export function modelInstalled(model: DownloadableModel, root: string): boolean {
  return model.files.every((file) => {
    const path = join(root, model.id, file.file)
    try {
      return existsSync(path) && statSync(path).size === file.bytes
    } catch {
      return false
    }
  })
}

export interface ModelDownloadProgress {
  modelId: string
  /** The file being written right now. */
  file: string
  fileIndex: number
  fileCount: number
  /** Bytes done across the whole model, so the bar does not restart at every file. */
  receivedBytes: number
  totalBytes: number
  percent: number
}

/** What a settings page polls while a model is being fetched. */
export interface ModelDownloadStatus {
  phase: 'idle' | 'downloading' | 'verifying' | 'done' | 'failed' | 'cancelled'
  modelId?: string
  file?: string
  fileIndex?: number
  fileCount?: number
  receivedBytes: number
  totalBytes: number
  percent: number
  /** Where it landed, once it is done. */
  dir?: string
  /** Why it stopped, when it failed. */
  message?: string
}

export interface ModelDownloadOptions {
  model: DownloadableModel
  /** Where the model folder goes — the same root `asr-tool` reads. */
  root: string
  mirror?: ModelMirror
  /** A whole URL prefix for a test (a local server), replacing the mirror's origin. */
  origin?: string
  signal?: AbortSignal
  onProgress?: (progress: ModelDownloadProgress) => void
  /** `downloading` while bytes arrive, `verifying` while the hash is checked. */
  onPhase?: (phase: 'downloading' | 'verifying', file: string) => void
}

/** A cancelled download is not a failure, and the caller can tell them apart. */
export class ModelDownloadCancelled extends Error {
  constructor() {
    super('下载已取消')
    this.name = 'ModelDownloadCancelled'
  }
}

const MAX_REDIRECTS = 5

/** A GET that follows redirects — the model hosts answer with one to their CDN. */
function open(url: string, redirects = 0): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      reject(new Error(`下载地址无效：${url}`))
      return
    }
    const getter = parsed.protocol === 'http:' ? httpGet : httpsGet
    const request = getter(parsed, (response) => {
      const status = response.statusCode ?? 0
      const location = response.headers.location
      if (status >= 300 && status < 400 && location) {
        response.resume()
        if (redirects >= MAX_REDIRECTS) {
          reject(new Error(`下载地址重定向太多次：${url}`))
          return
        }
        resolve(open(new URL(location, parsed).toString(), redirects + 1))
        return
      }
      if (status !== 200) {
        response.resume()
        reject(new Error(`下载失败：HTTP ${status}。`))
        return
      }
      resolve(response)
    })
    request.setTimeout(30_000, () => request.destroy(new Error('连接下载源超时。')))
    request.on('error', reject)
  })
}

const isAbort = (signal?: AbortSignal): boolean => signal?.aborted === true

const throwIfAborted = (signal?: AbortSignal): void => {
  if (isAbort(signal)) throw new ModelDownloadCancelled()
}

/**
 * One file, streamed to `<path>.downloading`.
 *
 * The hash is computed as the bytes pass, so verification costs no second read. Nothing is renamed
 * into place until the size and the hash agree.
 */
async function downloadFile(options: {
  url: string
  path: string
  expected: ModelFile
  signal?: AbortSignal
  onBytes: (received: number) => void
  onPhase: () => void
}): Promise<void> {
  const temporary = `${options.path}.downloading`
  throwIfAborted(options.signal)

  const response = await open(options.url)
  const hash = createHash('sha256')
  let received = 0

  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(temporary)
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      options.signal?.removeEventListener('abort', onAbort)
      if (error) {
        output.destroy()
        try {
          unlinkSync(temporary)
        } catch {
          // A temp file that is already gone is the same outcome.
        }
        reject(error)
        return
      }
      resolve()
    }
    const onAbort = () => {
      response.destroy()
      finish(new ModelDownloadCancelled())
    }

    options.signal?.addEventListener('abort', onAbort, { once: true })
    response.on('data', (chunk: Buffer) => {
      received += chunk.length
      hash.update(chunk)
      options.onBytes(received)
    })
    response.on('error', (error) => finish(error))
    response.setTimeout(60_000, () => response.destroy(new Error('下载超时，连接没有数据。')))
    output.on('error', (error) => finish(error))
    output.on('finish', () => finish())
    response.pipe(output)
  })

  if (received !== options.expected.bytes) {
    try {
      unlinkSync(temporary)
    } catch {
      // Nothing to clean up.
    }
    throw new Error(`文件不完整：${options.expected.file}（${received} / ${options.expected.bytes} 字节）。`)
  }

  options.onPhase()
  const digest = hash.digest('hex')
  if (options.expected.sha256 && digest !== options.expected.sha256) {
    try {
      unlinkSync(temporary)
    } catch {
      // Nothing to clean up.
    }
    throw new Error(`文件校验失败：${options.expected.file}。请换一个下载源再试。`)
  }

  renameSync(temporary, options.path)
}

/**
 * Put a model in `<root>/<model>/`, file by file.
 *
 * Files already here at the right size are left alone: running the download again after a partial
 * failure resumes from the first missing file rather than fetching 239 MB again.
 */
export async function downloadModel(
  options: ModelDownloadOptions,
): Promise<{ dir: string; files: string[] }> {
  const { model, root } = options
  const dir = join(root, model.id)
  mkdirSync(dir, { recursive: true })

  const totalBytes = model.bytes
  let completedBytes = 0
  const files: string[] = []
  const report = (file: string, index: number, received: number): void => {
    options.onProgress?.({
      modelId: model.id,
      file,
      fileIndex: index,
      fileCount: model.files.length,
      receivedBytes: completedBytes + received,
      totalBytes,
      percent: totalBytes > 0 ? Math.min(100, Math.round(((completedBytes + received) / totalBytes) * 100)) : 0,
    })
  }

  for (const [index, spec] of model.files.entries()) {
    throwIfAborted(options.signal)
    const path = join(dir, spec.file)
    files.push(path)

    if (existsSync(path) && statSync(path).size === spec.bytes) {
      completedBytes += spec.bytes
      report(spec.file, index, 0)
      continue
    }

    options.onPhase?.('downloading', spec.file)
    const url = options.origin
      ? `${options.origin.replace(/\/$/, '')}/${model.repo}/resolve/main/${spec.file}`
      : modelFileUrl(options.mirror ?? MODEL_MIRRORS[0].id, model, spec.file)

    await downloadFile({
      url,
      path,
      expected: spec,
      ...(options.signal ? { signal: options.signal } : {}),
      onBytes: (received) => report(spec.file, index, received),
      onPhase: () => options.onPhase?.('verifying', spec.file),
    })
    completedBytes += spec.bytes
    report(spec.file, index, 0)
  }

  return { dir, files }
}
