/**
 * The other end of the poster window's one verb: read **an image**, if it sits beside the document.
 *
 * A poster is the app's own `<Markdown>`, so a picture the document shows (`![](logo.png)`) is read
 * the way every other image in the app is. That is the whole of what this bridge is for: the fences
 * that would read a page or another document are simply not drawn in a picture, so their reads have
 * no caller and no capability here.
 *
 * The read is bounded by the same ceiling as an attachment: a poster shows the top of a page, not a
 * 500 MB asset, and a window that can be asked to read anything is a window worth not having.
 */

import { ipcMain } from 'electron'
import { readFile } from 'node:fs/promises'
import { extname, isAbsolute, resolve, sep } from 'node:path'

/** 64 MB: past this the picture is not the point, and the memory is the window's. */
const MAX_POSTER_READ = 64 * 1024 * 1024

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.pdf': 'application/pdf',
  '.html': 'text/html',
}

/**
 * The root one poster window may read from, registered when that window is created.
 *
 * Per window rather than "every workspace": a picture of a document in workspace A has no reason to
 * read a file in workspace B, and a bridge that answers with all of them would let one document
 * reach everything the person has open. Keyed by `webContents.id`, which is what the IPC event
 * carries — so a poster cannot ask for a different window's root either.
 */
const posterRoots = new Map<number, string>()

/** Say what one poster window may read, before it loads. */
export function registerPosterRoot(webContentsId: number, root: string): void {
  posterRoots.set(webContentsId, resolve(root))
}

/** The root for that window, or null when it was never given one (and so may read nothing). */
function rootFor(webContentsId: number): string | null {
  return posterRoots.get(webContentsId) ?? null
}

/** The file, when a workspace holds it — otherwise a refusal the block shows as its own error. */
async function readForPoster(webContentsId: number, rawPath: unknown, mode: unknown): Promise<string> {
  if (typeof rawPath !== 'string' || !rawPath.trim()) throw new Error('a poster read needs a path')
  const target = resolve(rawPath)
  if (!isAbsolute(target)) throw new Error('a poster read needs an absolute path')

  const root = rootFor(webContentsId)
  if (!root) throw new Error('this poster window was not given a root to read from')

  const prefix = root.endsWith(sep) ? root : `${root}${sep}`
  if (target !== root && !target.startsWith(prefix)) {
    throw new Error(`a poster may only read inside its own workspace: ${target}`)
  }

  const bytes = await readFile(target)
  if (bytes.byteLength > MAX_POSTER_READ) throw new Error(`${target} is too large to draw`)

  if (mode === 'text') return bytes.toString('utf8')
  const mime = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream'
  return `data:${mime};base64,${bytes.toString('base64')}`
}

/** Install the handler. Called once at startup; a second call replaces nothing (IPC is idempotent per name). */
export function installPosterBridge(): void {
  ipcMain.removeHandler('poster:read')
  ipcMain.handle('poster:read', (event, path: unknown, mode: unknown) =>
    readForPoster(event.sender.id, path, mode),
  )
}
