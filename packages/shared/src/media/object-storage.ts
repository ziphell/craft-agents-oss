/**
 * A public place for the reference files a provider will not take inline.
 *
 * The desktop has no public URL of its own, so a provider that only reads `http(s)` references
 * needs someone to host the bytes. That is what an S3-compatible bucket is for. The settings page
 * describes the bucket; the secret lives in the credential store, never in the JSON file.
 *
 * The uploader is deliberately small: one signed PUT, then the URL the provider should read. When
 * a public base URL is configured that URL is stable (a CDN domain); otherwise a presigned GET is
 * returned, so a private bucket still works without making every object public.
 *
 * Signing is AWS Signature V4, implemented here rather than pulled in as a client, because the only
 * operation needed is PUT — and the same code has to run in the desktop, the server and a test.
 */

import { createHash, createHmac } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CONFIG_DIR } from '../config/paths.ts'
import { getCredentialManager } from '../credentials/index.ts'
import type { CredentialId } from '../credentials/types.ts'
import {
  DEFAULT_OBJECT_STORAGE,
  OBJECT_STORAGE_FILE,
  normalizeObjectStorage,
  validateObjectStorage,
  type ObjectStorageConfig,
  type ObjectStorageFailure,
  type ObjectStorageTestResult,
} from './object-storage-config.ts'
import { MediaFailure } from './types.ts'

export interface ObjectStorageUploadInput {
  bytes: Uint8Array
  mimeType: string
  filename?: string
}

/** Uploads one file and answers the URL a provider should read. */
export type ObjectStorageUpload = (file: ObjectStorageUploadInput) => Promise<string>

const PRESIGN_TTL_SECONDS = 24 * 60 * 60
const PROBE_KEY = '.connection-check'
const PROBE_BODY = new TextEncoder().encode('craft-agent')

export function objectStoragePath(): string {
  return join(CONFIG_DIR, OBJECT_STORAGE_FILE)
}

// ─── Config file ─────────────────────────────────────────────────────────────

export function readObjectStorageConfig(): { config: ObjectStorageConfig; problem?: string } {
  const path = objectStoragePath()
  if (!existsSync(path)) return { config: { ...DEFAULT_OBJECT_STORAGE } }
  try {
    return { config: normalizeObjectStorage(JSON.parse(readFileSync(path, 'utf8'))) }
  } catch (error) {
    return {
      config: { ...DEFAULT_OBJECT_STORAGE },
      problem: `对象存储配置无法读取：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/** Writes the description of the bucket. The secret goes to the credential store instead. */
export function writeObjectStorageConfig(config: ObjectStorageConfig): void {
  const path = objectStoragePath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    `${JSON.stringify({ version: 1, ...normalizeObjectStorage(config) }, null, 2)}\n`,
    'utf8',
  )
}

// ─── Secret ──────────────────────────────────────────────────────────────────

/** One machine, one bucket: the config file is per-install too. */
const SECRET_ID: CredentialId = { type: 'object_storage_secret' }

export async function readObjectStorageSecret(): Promise<string | null> {
  try {
    const stored = await getCredentialManager().get(SECRET_ID)
    const value = stored?.value?.trim()
    return value ? value : null
  } catch {
    // A store that cannot be read is the same as no secret: the test says what is missing.
    return null
  }
}

export async function writeObjectStorageSecret(secret: string): Promise<void> {
  await getCredentialManager().set(SECRET_ID, { value: secret.trim() })
}

export async function clearObjectStorageSecret(): Promise<boolean> {
  try {
    return await getCredentialManager().delete(SECRET_ID)
  } catch {
    return false
  }
}

// ─── Signing and transport ───────────────────────────────────────────────────

const sha256Hex = (data: Uint8Array | string): string =>
  createHash('sha256').update(data).digest('hex')

const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac('sha256', key).update(data).digest()

/** RFC 3986 — the encoding SigV4 canonicalises with, which `encodeURIComponent` nearly is. */
const encodeRfc3986 = (value: string): string =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )

const encodeKeyPath = (key: string): string => key.split('/').map(encodeRfc3986).join('/')

const amzDateOf = (now: Date): string => now.toISOString().replace(/[:-]|\.\d{3}/g, '')

/** Where one object lives, addressed the way the config asks. */
function objectUrl(config: ObjectStorageConfig, key: string): URL {
  const endpoint = new URL(config.endpoint)
  const basePath = endpoint.pathname.replace(/\/+$/, '')
  const encodedKey = encodeKeyPath(key)
  const host = config.pathStyle ? endpoint.host : `${config.bucket}.${endpoint.host}`
  const path = config.pathStyle
    ? `${basePath}/${encodeRfc3986(config.bucket)}/${encodedKey}`
    : `${basePath}/${encodedKey}`
  return new URL(`${endpoint.protocol}//${host}${path || '/'}`)
}

/** The URL a provider reads. A public base is stable; otherwise the link is presigned. */
export function objectPublicUrl(
  config: ObjectStorageConfig,
  secret: string,
  key: string,
  now: Date = new Date(),
): string {
  if (config.publicBaseUrl) {
    return `${config.publicBaseUrl}/${encodeKeyPath(key)}`
  }
  return presignGet(config, secret, key, now)
}

function canonicalQueryOf(entries: Array<[string, string]>): string {
  return entries
    .map(([name, value]) => [encodeRfc3986(name), encodeRfc3986(value)] as const)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&')
}

function signatureOf(options: {
  method: string
  url: URL
  query: string
  headers: Record<string, string>
  payloadHash: string
  config: ObjectStorageConfig
  secret: string
  now: Date
}): string {
  const { method, url, query, headers, payloadHash, config, secret, now } = options
  const amzDate = amzDateOf(now)
  const dateStamp = amzDate.slice(0, 8)
  const names = Object.keys(headers).sort()
  const canonicalHeaders = names.map((name) => `${name}:${headers[name]!.trim()}\n`).join('')
  const signedHeaders = names.join(';')
  const canonicalRequest = [
    method,
    url.pathname,
    query,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')
  const scope = `${dateStamp}/${config.region}/s3/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n')
  const dateKey = hmac(`AWS4${secret}`, dateStamp)
  const regionKey = hmac(dateKey, config.region)
  const serviceKey = hmac(regionKey, 's3')
  const signingKey = hmac(serviceKey, 'aws4_request')
  return hmac(signingKey, stringToSign).toString('hex')
}

/** A header-signed request (PUT/DELETE). The host header is set by fetch; it is still signed. */
function signedHeaders(options: {
  method: string
  url: URL
  payloadHash: string
  config: ObjectStorageConfig
  secret: string
  now: Date
}): { headers: Record<string, string>; amzDate: string; signature: string } {
  const amzDate = amzDateOf(options.now)
  const headers = {
    host: options.url.host,
    'x-amz-content-sha256': options.payloadHash,
    'x-amz-date': amzDate,
  }
  const signature = signatureOf({
    method: options.method,
    url: options.url,
    query: '',
    headers,
    payloadHash: options.payloadHash,
    config: options.config,
    secret: options.secret,
    now: options.now,
  })
  return { headers, amzDate, signature }
}

/** A presigned GET: credentials travel in the query, so the link works without headers. */
function presignGet(
  config: ObjectStorageConfig,
  secret: string,
  key: string,
  now: Date,
): string {
  const url = objectUrl(config, key)
  const amzDate = amzDateOf(now)
  const dateStamp = amzDate.slice(0, 8)
  const scope = `${dateStamp}/${config.region}/s3/aws4_request`
  const query = canonicalQueryOf([
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${config.accessKeyId}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(PRESIGN_TTL_SECONDS)],
    ['X-Amz-SignedHeaders', 'host'],
  ])
  const signature = signatureOf({
    method: 'GET',
    url,
    query,
    headers: { host: url.host },
    payloadHash: 'UNSIGNED-PAYLOAD',
    config,
    secret,
    now,
  })
  const separator = url.search ? '&' : '?'
  return `${url.toString()}${separator}${query}&X-Amz-Signature=${signature}`
}

function authorizationOf(config: ObjectStorageConfig, amzDate: string, signature: string): string {
  const dateStamp = amzDate.slice(0, 8)
  return (
    `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${dateStamp}/${config.region}/s3/aws4_request, ` +
    `SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${signature}`
  )
}

async function putObject(options: {
  config: ObjectStorageConfig
  secret: string
  key: string
  bytes: Uint8Array
  mimeType: string
  fetch: typeof fetch
  now: Date
}): Promise<void> {
  const { config, secret, key, bytes, mimeType, fetch: doFetch, now } = options
  const url = objectUrl(config, key)
  const payloadHash = sha256Hex(bytes)
  const signed = signedHeaders({ method: 'PUT', url, payloadHash, config, secret, now })
  let response: Response
  try {
    response = await doFetch(url, {
      method: 'PUT',
      headers: {
        ...signed.headers,
        'content-type': mimeType,
        authorization: authorizationOf(config, signed.amzDate, signed.signature),
      },
      body: bytes as unknown as ArrayBuffer,
      signal: AbortSignal.timeout(120_000),
    })
  } catch (error) {
    throw new MediaFailure('upload', error instanceof Error ? error.message : String(error), {
      code: 'network',
      retryable: true,
      cause: error,
    })
  }
  if (response.ok) return
  const body = await response.text().catch(() => '')
  throw new ObjectStorageHttpError(response.status, storageDetail(response.status, body))
}

async function deleteObject(options: {
  config: ObjectStorageConfig
  secret: string
  key: string
  fetch: typeof fetch
  now: Date
}): Promise<void> {
  const { config, secret, key, fetch: doFetch, now } = options
  const url = objectUrl(config, key)
  const payloadHash = sha256Hex('')
  const signed = signedHeaders({ method: 'DELETE', url, payloadHash, config, secret, now })
  await doFetch(url, {
    method: 'DELETE',
    headers: {
      ...signed.headers,
      authorization: authorizationOf(config, signed.amzDate, signed.signature),
    },
    signal: AbortSignal.timeout(30_000),
  })
}

class ObjectStorageHttpError extends MediaFailure {
  constructor(readonly status: number, detail: string) {
    super('upload', detail, {
      code: status === 401 || status === 403 ? 'missing_credentials' : 'provider_rejected',
      cause: status,
    })
  }
}

/** A provider sentence without the XML noise, kept short enough to show under a field. */
function storageDetail(status: number, body: string): string {
  const code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1]
  const message = /<Message>([^<]+)<\/Message>/.exec(body)?.[1]
  const detail = [code, message].filter(Boolean).join(': ')
  return detail || `对象存储返回 HTTP ${status}`
}

function failureOf(error: unknown, fallback: ObjectStorageFailure): ObjectStorageTestResult {
  if (error instanceof ObjectStorageHttpError) {
    const { status, detail } = error
    if (status === 401 || status === 403) return { ok: false, reason: 'auth', status, detail }
    if (status === 404 || /NoSuchBucket/i.test(detail)) {
      return { ok: false, reason: 'bucket', status, detail }
    }
    return { ok: false, reason: fallback, status, detail }
  }
  if (error instanceof MediaFailure) {
    const detail = error.detail
    if (/fetch failed|ENOTFOUND|ECONNREFUSED|timed out|TimeoutError/i.test(detail)) {
      return { ok: false, reason: 'network', detail }
    }
    return { ok: false, reason: fallback, detail }
  }
  return {
    ok: false,
    reason: fallback,
    detail: error instanceof Error ? error.message : String(error),
  }
}

/**
 * Upload a probe, read it back through the URL a provider would receive, then remove it.
 *
 * A successful PUT alone proves the key works, not that the URL does: a private bucket without a
 * presigned link would pass the first and fail every generation. The read is the point.
 */
export async function testObjectStorage(options: {
  config: ObjectStorageConfig
  secret: string
  fetch?: typeof fetch
  now?: Date
}): Promise<ObjectStorageTestResult> {
  const config = normalizeObjectStorage(options.config)
  const issue = validateObjectStorage(config, options.secret)
  if (issue === 'config') return { ok: false, reason: 'config' }
  if (issue === 'secret') return { ok: false, reason: 'secret' }

  const doFetch = options.fetch ?? fetch
  const now = options.now ?? new Date()
  const key = config.keyPrefix ? `${config.keyPrefix}/${PROBE_KEY}` : PROBE_KEY
  try {
    await putObject({
      config,
      secret: options.secret,
      key,
      bytes: PROBE_BODY,
      mimeType: 'text/plain',
      fetch: doFetch,
      now,
    })
  } catch (error) {
    return failureOf(error, 'upload')
  }

  try {
    const response = await doFetch(objectPublicUrl(config, options.secret, key, now), {
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) {
      return {
        ok: false,
        reason: 'read',
        status: response.status,
        detail: `对象已上传，但公网地址返回 HTTP ${response.status}。请检查公网地址或公开读取设置。`,
      }
    }
    const body = new Uint8Array(await response.arrayBuffer())
    if (body.byteLength !== PROBE_BODY.byteLength) {
      return {
        ok: false,
        reason: 'read',
        detail: '公网地址返回的内容与上传的不一致，请检查公网地址是否指向这个存储桶。',
      }
    }
  } catch (error) {
    return failureOf(error, 'read')
  } finally {
    // Best effort: a probe left behind is a small lie, not a failed configuration.
    await deleteObject({ config, secret: options.secret, key, fetch: doFetch, now }).catch(() => {})
  }
  return { ok: true }
}

// ─── The uploader used by generation ─────────────────────────────────────────

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-m4v': 'm4v',
  'video/x-matroska': 'mkv',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
}

function objectKeyOf(config: ObjectStorageConfig, file: ObjectStorageUploadInput): string {
  const hash = sha256Hex(file.bytes)
  const extension = EXTENSION_BY_MIME[file.mimeType.toLowerCase()]
  const name = extension ? `${hash}.${extension}` : hash
  return config.keyPrefix ? `${config.keyPrefix}/${name}` : name
}

/**
 * A ready uploader when object storage is on, `null` when it is off.
 *
 * Off is a decision, so it answers `null` and the caller keeps its old behaviour. On but incomplete
 * is a mistake, so it throws: quietly falling back to inline bytes would hide the very setting the
 * person turned on to make their provider work.
 */
export async function objectStorageUploader(
  options: {
    fetch?: typeof fetch
    now?: Date
    config?: ObjectStorageConfig
    secret?: string | null
  } = {},
): Promise<ObjectStorageUpload | null> {
  const config = normalizeObjectStorage(options.config ?? readObjectStorageConfig().config)
  if (!config.enabled) return null
  const secret = options.secret !== undefined ? options.secret : await readObjectStorageSecret()
  if (!secret) {
    throw new MediaFailure(
      'upload',
      '对象存储已启用，但还没有保存 Secret Access Key。请在 设置 → AI → 素材存储 里填写。',
    )
  }
  if (validateObjectStorage(config, secret)) {
    throw new MediaFailure(
      'upload',
      '对象存储已启用，但配置不完整。请在 设置 → AI → 素材存储 里补全端点、区域、存储桶和密钥。',
    )
  }
  const doFetch = options.fetch ?? fetch
  const now = options.now
  return async (file) => {
    const key = objectKeyOf(config, file)
    const at = now ?? new Date()
    await putObject({
      config,
      secret,
      key,
      bytes: file.bytes,
      mimeType: file.mimeType,
      fetch: doFetch,
      now: at,
    })
    return objectPublicUrl(config, secret, key, at)
  }
}
