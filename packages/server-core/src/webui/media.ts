/**
 * Project media over the hub — `/api/media?path=…`, with `Range`.
 *
 * The browser tab has no `craft-local://`, so the hub serves the files itself. This is the same
 * job `media-host.ts` does on the desktop, and the same rules: a `<video>` needs a URL it can seek
 * (a data URL cannot be seeked, and base64 doubles the bytes in memory), and only files under the
 * workspaces root may be named.
 *
 * Behind the session on purpose: the hub is not a file server, and media is somebody's work.
 */

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, normalize, sep } from 'node:path'
import { Readable } from 'node:stream'
import { CONFIG_DIR } from '@craft-agent/shared/config/paths'

export const MEDIA_ROUTE = '/api/media'

const ROOT = normalize(`${CONFIG_DIR}${sep}workspaces`)

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
}

const isInsideRoot = (path: string): boolean => {
  const candidate = normalize(path)
  return candidate === ROOT || candidate.startsWith(`${ROOT}${sep}`)
}

const parseRange = (header: string | null, size: number): { start: number; end: number } | null => {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null
  const start = match[1] ? Number(match[1]) : 0
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null
  return { start, end }
}

/** `null` when this request is not for media. */
export async function serveMediaRoute(request: Request, path: string): Promise<Response | null> {
  if (path !== MEDIA_ROUTE) return null
  const url = new URL(request.url)
  const file = url.searchParams.get('path')
  if (!file) return new Response('No path.', { status: 400 })

  let size: number
  try {
    const info = await stat(file)
    if (!info.isFile()) return new Response('Not a file.', { status: 404 })
    size = info.size
  } catch {
    return new Response('Not found.', { status: 404 })
  }
  if (!isInsideRoot(file)) return new Response('Media outside the workspace is not served.', { status: 403 })

  const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
  const range = parseRange(request.headers.get('range'), size)

  if (request.method === 'HEAD') {
    return new Response(null, {
      status: 200,
      headers: { 'content-type': type, 'content-length': String(size), 'accept-ranges': 'bytes', 'cache-control': 'no-store' },
    })
  }

  if (!range) {
    return new Response(Readable.toWeb(createReadStream(file)) as unknown as ReadableStream, {
      status: 200,
      headers: { 'content-type': type, 'content-length': String(size), 'accept-ranges': 'bytes', 'cache-control': 'no-store' },
    })
  }

  const { start, end } = range
  return new Response(Readable.toWeb(createReadStream(file, { start, end })) as unknown as ReadableStream, {
    status: 206,
    headers: {
      'content-type': type,
      'content-length': String(end - start + 1),
      'content-range': `bytes ${start}-${end}/${size}`,
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
    },
  })
}
