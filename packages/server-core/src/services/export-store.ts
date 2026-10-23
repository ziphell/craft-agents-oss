/**
 * Export scratch files — files this hub produced for a caller that is not on this machine.
 *
 * A design export is rendered here (the hub owns the renderer), so the bytes live here too. The
 * caller gets an opaque id and fetches `/api/exports/<id>`; nothing about a path travels over the
 * wire, which is what lets a webui tab or a thin client receive a file it could never name.
 *
 * Entries are short-lived by design: an export is a delivery, not storage. They expire on their
 * own, and the directory goes with them.
 */

import { mkdirSync, rmSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import type { DesignExportDownload } from '@craft-agent/shared/designs'

/** How long a produced export stays fetchable. */
const EXPORT_TTL_MS = 30 * 60 * 1000

interface StoredExport {
  path: string
  name: string
  mime: string
  size: number
  expiresAt: number
}

const entries = new Map<string, StoredExport>()
let sweeper: ReturnType<typeof setInterval> | null = null

/** Root the per-export directories live under. */
export function exportScratchRoot(): string {
  const root = join(tmpdir(), 'craft-agent', 'exports')
  mkdirSync(root, { recursive: true })
  return root
}

/** A fresh directory for one export — the renderer writes into it, the store serves it. */
export function createExportDir(): string {
  const dir = join(exportScratchRoot(), randomUUID())
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Publish a finished file and hand back what the caller needs to fetch it.
 *
 * The directory is the unit of cleanup: whatever else the renderer left beside `path` goes with
 * it when the entry expires.
 */
export function storeExport(input: { path: string; name: string; mime: string }): DesignExportDownload {
  const id = randomUUID()
  const size = statSync(input.path).size
  entries.set(id, {
    path: input.path,
    name: input.name,
    mime: input.mime,
    size,
    expiresAt: Date.now() + EXPORT_TTL_MS,
  })
  ensureSweeper()
  return { id, name: input.name, size, mime: input.mime }
}

/** The file behind an id, or `null` once it is unknown or expired. */
export function findExport(id: string): { path: string; name: string; mime: string; size: number } | null {
  const entry = entries.get(id)
  if (!entry) return null
  if (entry.expiresAt <= Date.now()) {
    releaseExport(id)
    return null
  }
  return { path: entry.path, name: entry.name, mime: entry.mime, size: entry.size }
}

/** Drop an entry and its directory (expiry, or a fetch that no longer needs it). */
export function releaseExport(id: string): void {
  const entry = entries.get(id)
  if (!entry) return
  entries.delete(id)
  try {
    rmSync(dirname(entry.path), { recursive: true, force: true })
  } catch {
    // Already gone; the map is what mattered.
  }
}

function ensureSweeper(): void {
  if (sweeper) return
  sweeper = setInterval(() => {
    const now = Date.now()
    for (const [id, entry] of entries) {
      if (entry.expiresAt <= now) releaseExport(id)
    }
  }, 60_000)
  sweeper.unref?.()
}
