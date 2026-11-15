/**
 * Project media, on the app's own origin — `craft-local://media/?path=…`.
 *
 * A `<video>` needs a URL it can **seek**: fetching and range-requesting are how it plays, scrubs
 * and samples frames. A data URL cannot — the browser refuses it as `application/octet-stream`,
 * and once typed correctly it is still one monolithic base64 string, several megabytes per minute
 * of footage, with no way to read a single frame without decoding all of it.
 *
 * So the same scheme that serves the bundled editors serves the files: one label (`media`), one
 * query parameter, and `Range` answered properly — the browser then seeks by asking for bytes it
 * does not have, and a filmstrip can sample a clip without holding it in memory.
 *
 * The whitelist is the workspaces root: a media URL may name a file under `~/.craft-agent/workspaces`
 * and nothing else. The scheme is installed on the app's own session only, but a scheme handler
 * that answers for any path would still be a file server, and this is not one.
 */

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, normalize, sep } from 'node:path'
import { Readable } from 'node:stream'
import { CONFIG_DIR } from '@craft-agent/shared/config/paths'
import { localHostOrigin } from '@craft-agent/shared/local-origin'
import { textResponse } from './local-http'

/** The host label the media lives under. */
export const MEDIA_HOST = 'media'

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

/** The origin project media is reachable at on the desktop. */
export const mediaOriginUrl = (): string => localHostOrigin(MEDIA_HOST)

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

export async function serveMediaRequest(request: Request): Promise<Response | null> {
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return null
  }
  if (url.host !== MEDIA_HOST) return null

  const path = url.searchParams.get('path')
  if (!path) return textResponse(404, 'No path.')

  let size: number
  try {
    const info = await stat(path)
    if (!info.isFile()) return textResponse(404, 'Not a file.')
    size = info.size
  } catch {
    return textResponse(404, 'Not found.')
  }
  // After the stat, so a missing file is a plain 404 rather than a hint about the whitelist.
  if (!isInsideRoot(path)) return textResponse(403, 'Media outside the workspace is not served.')

  const type = MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
  const range = parseRange(request.headers.get('range'), size)
  // The preview fetches these bytes to decode sound, and its canvas samples an element that seeks
  // them; both need the response to be CORS-clean.
  const allowed = { 'access-control-allow-origin': '*' }

  // HEAD and a range both matter here: the browser asks "how big is it" before asking for bytes.
  if (request.method === 'HEAD') {
    return new Response(null, {
      status: 200,
      headers: {
        'content-type': type,
        'content-length': String(size),
        'accept-ranges': 'bytes',
        'cache-control': 'no-store',
        ...allowed,
      },
    })
  }

  if (!range) {
    return new Response(Readable.toWeb(createReadStream(path)) as unknown as ReadableStream, {
      status: 200,
      headers: {
        'content-type': type,
        'content-length': String(size),
        'accept-ranges': 'bytes',
        'cache-control': 'no-store',
        ...allowed,
      },
    })
  }

  const { start, end } = range
  return new Response(Readable.toWeb(createReadStream(path, { start, end })) as unknown as ReadableStream, {
    status: 206,
    headers: {
      'content-type': type,
      'content-length': String(end - start + 1),
      'content-range': `bytes ${start}-${end}/${size}`,
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
      ...allowed,
    },
  })
}
