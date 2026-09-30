/**
 * Artifacts → their drawn previews, host-side.
 *
 * This is a **cache, not a source of truth**: read that as a claim about the whole
 * file. Nothing here is written to disk, there is no sidecar and no index file, and
 * if this module's map is thrown away the next call simply draws the picture again.
 * The `.drawio` on disk is the only record; this remembers what a file's current
 * bytes look like so that scrolling a list does not redraw every diagram in it.
 *
 * Keyed by (path, mtime): a file that has not moved is handed back as it was, and one
 * that has is drawn afresh. Drawing is expensive in a way reading is not — every call
 * opens a hidden BrowserWindow, loads the drawio editor into it and tears it down
 * (`drawio-render.ts`) — so calls are also let through a few at a time: a list that
 * scrolls into view asks for many previews at once, and one window per row would be a
 * stampede of them.
 */

import { readFile, stat } from 'node:fs/promises'
import type { ArtifactThumbnail } from '@craft-agent/shared/artifacts'

/** One drawn picture, plus the file mtime it was drawn from. */
interface Cached {
  mtimeMs: number
  svg: string
}

/** Keyed by absolute path — the file is the artifact, and its path is its identity. */
const cache = new Map<string, Cached>()

/** How many hidden windows may draw at once. Small on purpose: each is a whole editor. */
const MAX_CONCURRENT_RENDERS = 2
let rendering = 0
const waiting: Array<() => void> = []

/**
 * The SVG for one `.drawio` file, or null when there is none to be had.
 *
 * Null is the answer to every way this can come up empty — no file, no engine, a
 * document the engine refused — because the caller is a list row that shows its icon
 * either way: a preview is a bonus, and a row must never look broken over one.
 */
export async function artifactThumbnailForFile(input: {
  /** Absolute path of the `.drawio` file. */
  filePath: string
  /** How to draw it — the host's own renderer, already bound to SVG. */
  render: (xml: string) => Promise<{ bytes: Uint8Array }>
}): Promise<ArtifactThumbnail | null> {
  let mtimeMs: number
  try {
    mtimeMs = (await stat(input.filePath)).mtimeMs
  } catch {
    // Gone, or never there: a file that is not on disk has no preview.
    return null
  }

  const cached = cache.get(input.filePath)
  if (cached && cached.mtimeMs === mtimeMs) return { svg: cached.svg }

  let xml: string
  try {
    xml = await readFile(input.filePath, 'utf-8')
  } catch {
    return null
  }

  await acquire()
  try {
    const { bytes } = await input.render(xml)
    const svg = Buffer.from(bytes).toString('utf-8')
    cache.set(input.filePath, { mtimeMs, svg })
    return { svg }
  } catch {
    // The bundle is not installed, or the engine could not draw this document: the
    // row keeps its icon, and nothing here is the renderer's to handle.
    return null
  } finally {
    release()
  }
}

/** Wait for a slot, then take it. */
function acquire(): Promise<void> {
  if (rendering < MAX_CONCURRENT_RENDERS) {
    rendering += 1
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => {
    waiting.push(() => {
      rendering += 1
      resolve()
    })
  })
}

/** Give a slot back, and hand it to whoever has waited longest. */
function release(): void {
  rendering -= 1
  const next = waiting.shift()
  if (next) next()
}
