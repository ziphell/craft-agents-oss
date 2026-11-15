/**
 * Turning files into references a provider accepts.
 *
 * The decision order is the whole design:
 *
 * 1. **already a URL** → pass it through. A reference used by a second job must not be uploaded
 *    twice, and a caller that already has a provider URL knows better than we do.
 * 2. **cached** → the same file, the same provider, the same answer. Keys are the file's content
 *    hash, so a copy under a new name still hits (Toonflow uploads per call; this is cheaper).
 * 3. **inline** → when the provider takes bytes and the file fits. Base64 costs a third more, so a
 *    big file is worth a round trip instead.
 * 4. **upload** → the provider's own endpoint; what it returns is the reference.
 *
 * Nothing here invents a public URL for this machine. If none of the four applies, that is an
 * `upload` failure with the reason — not a silent fallback to something the provider will reject.
 */

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { MediaFailure, type MediaInput, type ProviderRef } from './types.ts'

export { isSubtitleFile } from './file-kind.ts'

/** What one provider's transport looks like. Implemented per provider, never guessed. */
export interface InputTransport {
  /** Does it accept `data:` URLs in a request body? */
  acceptsInlineBytes?: boolean
  /** Above this many bytes, inline is a bad idea (or refuses). */
  maxInlineBytes?: number
  /** `POST` the bytes somewhere and return what the provider calls the file. */
  upload?: (file: { bytes: Uint8Array; mimeType: string; filename?: string }) => Promise<ProviderRef>
  /** Some providers make an uploaded asset usable only after a review. */
  review?: (ref: ProviderRef) => Promise<ProviderRef>
}

const DEFAULT_MAX_INLINE_BYTES = 3_500_000

const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'opus'])
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'm4v', 'mkv'])
const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'webp',
  'gif',
  'bmp',
  'tif',
  'tiff',
  'heic',
  'heif',
  'avif',
])

/** What a reference file is, by the name the caller chose. Images are the default. */
export function mediaKindOfFile(absolutePath: string): 'image' | 'video' | 'audio' {
  const extension = absolutePath.split('.').pop()?.toLowerCase() ?? ''
  if (VIDEO_EXTENSIONS.has(extension)) return 'video'
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio'
  return 'image'
}

/**
 * Whether the name is one this door can send at all.
 *
 * `mediaKindOfFile` has to answer with a kind for every name, and answers `image` for an unknown
 * one — right for a relay whose file types we cannot know, wrong for a caller that just pointed
 * `--input` at a brief. This is the stricter question that lets that caller refuse instead.
 */
export function isMediaFile(absolutePath: string): boolean {
  const extension = absolutePath.split('.').pop()?.toLowerCase() ?? ''
  return (
    IMAGE_EXTENSIONS.has(extension) ||
    VIDEO_EXTENSIONS.has(extension) ||
    AUDIO_EXTENSIONS.has(extension)
  )
}

/**
 * One file as a provider wants a reference: inline bytes, typed by the file's own extension.
 *
 * Typed by name rather than by sniffing the bytes, because the name is what the caller chose and an
 * extension it cannot recognise is a file this path should not be guessing about.
 */
export function mimeTypeOfFile(absolutePath: string): string {
  const extension = absolutePath.split('.').pop()?.toLowerCase() ?? 'png'
  const kind = mediaKindOfFile(absolutePath)
  return kind === 'video'
    ? extension === 'webm'
      ? 'video/webm'
      : extension === 'mov'
        ? 'video/quicktime'
        : extension === 'm4v'
          ? 'video/x-m4v'
          : extension === 'mkv'
            ? 'video/x-matroska'
            : 'video/mp4'
    : kind === 'audio'
      ? extension === 'wav'
        ? 'audio/wav'
        : extension === 'ogg' || extension === 'opus'
          ? 'audio/ogg'
          : extension === 'm4a'
            ? 'audio/mp4'
            : extension === 'aac'
              ? 'audio/aac'
              : extension === 'flac'
                ? 'audio/flac'
                : 'audio/mpeg'
      : extension === 'jpg' || extension === 'jpeg'
        ? 'image/jpeg'
        : extension === 'webp'
          ? 'image/webp'
          : extension === 'gif'
            ? 'image/gif'
            : 'image/png'
}

export function dataUrlOfFile(absolutePath: string): string {
  return `data:${mimeTypeOfFile(absolutePath)};base64,${Buffer.from(readFileSync(absolutePath)).toString('base64')}`
}

/**
 * The bytes behind a `data:` URL, or `null` when the caller already has a URL.
 *
 * The renderer sends local references as data URLs; a provider that only reads `http(s)` needs them
 * uploaded first, and this is the only place both shapes have to be understood.
 */
export function bytesOfDataUrl(value: string): { bytes: Uint8Array; mimeType: string } | null {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(value)
  if (!match?.[2]) return null
  const mimeType = match[1] || 'application/octet-stream'
  try {
    return { bytes: new Uint8Array(Buffer.from(match[3] ?? '', 'base64')), mimeType }
  } catch {
    return null
  }
}

/** A file on this machine, as a provider input. Used where the caller has a path, not a data URL. */
export function mediaInputOfFile(absolutePath: string): MediaInput {
  return {
    kind: 'bytes',
    bytes: readFileSync(absolutePath),
    mimeType: mimeTypeOfFile(absolutePath),
    filename: basename(absolutePath),
  }
}

/** FNV-1a over the bytes, twice with different seeds: a cache key, not a security hash. */
function contentHash(bytes: Uint8Array): string {
  const fnv = (seed: number): string => {
    let hash = seed >>> 0
    for (let index = 0; index < bytes.length; index++) {
      hash ^= bytes[index]!
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
    return hash.toString(16).padStart(8, '0')
  }
  return `${fnv(0x811c9dc5)}${fnv(0x9e3779b9)}-${bytes.length.toString(16)}`
}

interface CacheEntry {
  ref: ProviderRef
  at: number
}

/**
 * Per-provider, per-file memory of what was uploaded.
 *
 * Exported so a caller with a longer lifetime than one job can keep it: the win is the *second*
 * generation that uses the same reference.
 */
export class ProviderRefCache {
  private readonly entries = new Map<string, Map<string, CacheEntry>>()

  constructor(private readonly ttlMs = 6 * 60 * 60 * 1000) {}

  get(provider: string, bytes: Uint8Array): ProviderRef | null {
    const key = contentHash(bytes)
    const entry = this.entries.get(provider)?.get(key)
    if (!entry) return null
    if (Date.now() - entry.at > this.ttlMs) {
      this.entries.get(provider)?.delete(key)
      return null
    }
    return entry.ref
  }

  set(provider: string, bytes: Uint8Array, ref: ProviderRef): void {
    const key = contentHash(bytes)
    const bucket = this.entries.get(provider) ?? new Map<string, CacheEntry>()
    bucket.set(key, { ref, at: Date.now() })
    this.entries.set(provider, bucket)
  }

  get size(): number {
    let total = 0
    for (const bucket of this.entries.values()) total += bucket.size
    return total
  }
}

const dataUrlOf = (bytes: Uint8Array, mimeType: string): string =>
  `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`

/**
 * One input → one reference. Throws `MediaFailure('upload', …)` when there is no way to deliver it,
 * because that is what it is: the file never reached the provider.
 */
export async function prepareInput(
  provider: string,
  input: MediaInput,
  transport: InputTransport,
  cache?: ProviderRefCache,
): Promise<ProviderRef> {
  if (input.kind === 'url') return { kind: 'url', value: input.url }

  const cached = cache?.get(provider, input.bytes)
  if (cached) return cached

  const maxInline = transport.maxInlineBytes ?? DEFAULT_MAX_INLINE_BYTES
  if (transport.acceptsInlineBytes && input.bytes.length <= maxInline) {
    const ref: ProviderRef = { kind: 'data-url', value: dataUrlOf(input.bytes, input.mimeType) }
    cache?.set(provider, input.bytes, ref)
    return ref
  }

  if (!transport.upload) {
    throw new MediaFailure(
      'upload',
      `${(input.bytes.length / 1024 / 1024).toFixed(1)} MB ${input.mimeType} cannot be inlined ` +
        `(limit ${(maxInline / 1024 / 1024).toFixed(1)} MB) and this provider has no upload endpoint.`,
    )
  }

  let ref: ProviderRef
  try {
    ref = await transport.upload({
      bytes: input.bytes,
      mimeType: input.mimeType,
      ...(input.filename ? { filename: input.filename } : {}),
    })
  } catch (error) {
    if (error instanceof MediaFailure) throw error
    throw new MediaFailure('upload', error instanceof Error ? error.message : String(error), {
      code: 'upload_failed',
      retryable: true,
      cause: error,
    })
  }

  if (transport.review) {
    try {
      ref = await transport.review(ref)
    } catch (error) {
      if (error instanceof MediaFailure) throw error
      throw new MediaFailure('review', error instanceof Error ? error.message : String(error), {
        code: 'review_failed',
        cause: error,
      })
    }
  }

  cache?.set(provider, input.bytes, ref)
  return ref
}

/** All of a request's inputs, in order. The first failure stops it — a half-delivered request is not one. */
export async function prepareInputs(
  provider: string,
  inputs: readonly MediaInput[],
  transport: InputTransport,
  cache?: ProviderRefCache,
): Promise<ProviderRef[]> {
  const refs: ProviderRef[] = []
  for (const input of inputs) refs.push(await prepareInput(provider, input, transport, cache))
  return refs
}
