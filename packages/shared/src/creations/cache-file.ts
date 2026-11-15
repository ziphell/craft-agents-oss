/**
 * The session index, written down so a launch does not have to rebuild it.
 *
 * The index is derived, and it has always been rebuilt from nothing at every launch: a cold scan of
 * a real workspace (133 transcripts, 140 MB) costs 565 ms of CPU before the library can draw its
 * first card, and the person is looking at a spinner for all of it. That is the *whole* cost of
 * opening the library for the first time in a session; after it, a warm scan is 75 ms.
 *
 * What makes writing it down safe is the key the in-memory cache already uses: **a session's entry
 * is only valid for one `(size, mtimeMs)` of its transcript**, and the parser that produced it is
 * named by `CREATIONS_INDEX_VERSION`. Those are re-checked against the filesystem on every refresh —
 * the scan stats every transcript whether the entry came from memory or from this file — so a stale
 * entry is re-parsed rather than believed. The file is therefore not a second source of truth: it is
 * the same cache, kept between processes, and any answer about which work exists still comes from
 * the filesystem at the moment it is asked.
 *
 * Three rules, matching the posters and the versions:
 *
 * - **Nothing goes in the workspace.** This is the host's own folder, handed in by the caller.
 * - **A cache that cannot be read is not an error.** A missing, truncated or older file is simply a
 *   cold scan, which is what every launch did before.
 * - **A write is atomic.** The file is written beside itself and renamed, so a crash mid-write can
 *   never leave a half-index that parses as valid JSON.
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CREATIONS_INDEX_VERSION } from './types'
import type { CreationsCache, SessionEntry } from './scan'

/** The file's own format, separate from the index version: a shape change need not re-parse. */
const CACHE_FORMAT = 1

export const CREATIONS_CACHE_FILE = 'sessions.json'

interface StoredCache {
  format: number
  /** Which parser wrote it — an index built by different rules is discarded, not reinterpreted. */
  indexVersion: number
  /** `[sessionId, entry]` pairs, in the order the cache held them. */
  sessions: Array<[string, SessionEntry]>
}

/** Everything a `SessionEntry` must be for the scan to trust it. Shape only, not meaning. */
function looksLikeEntry(value: unknown): value is SessionEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.size === 'number' &&
    typeof entry.mtimeMs === 'number' &&
    typeof entry.toolRecords === 'number' &&
    (entry.name === null || typeof entry.name === 'string') &&
    (entry.projectId === null || typeof entry.projectId === 'string') &&
    Array.isArray(entry.hits) &&
    entry.hits.every(
      (hit) =>
        !!hit &&
        typeof hit === 'object' &&
        typeof (hit as Record<string, unknown>).path === 'string' &&
        typeof (hit as Record<string, unknown>).format === 'string',
    )
  )
}

/**
 * The remembered index for one workspace, or `null` when there is nothing usable.
 *
 * Null covers every way this can be unhelpful — no file yet, unreadable, not JSON, a different
 * format, an index built by an older parser, one malformed entry — because the answer to all of them
 * is the same: scan.
 */
export async function loadCache(dir: string): Promise<CreationsCache | null> {
  let text: string
  try {
    text = await readFile(join(dir, CREATIONS_CACHE_FILE), 'utf8')
  } catch {
    return null
  }

  let stored: StoredCache
  try {
    stored = JSON.parse(text) as StoredCache
  } catch {
    return null
  }
  if (!stored || stored.format !== CACHE_FORMAT) return null
  if (stored.indexVersion !== CREATIONS_INDEX_VERSION) return null
  if (!Array.isArray(stored.sessions)) return null

  const sessions = new Map<string, SessionEntry>()
  for (const pair of stored.sessions) {
    if (!Array.isArray(pair) || pair.length !== 2) return null
    const [sessionId, entry] = pair
    if (typeof sessionId !== 'string' || !looksLikeEntry(entry)) return null
    sessions.set(sessionId, entry)
  }
  return { version: CREATIONS_INDEX_VERSION, sessions }
}

/** Write the index where the next launch will find it. A failure is the caller's to ignore. */
export async function saveCache(dir: string, cache: CreationsCache): Promise<void> {
  const stored: StoredCache = {
    format: CACHE_FORMAT,
    indexVersion: cache.version,
    sessions: [...cache.sessions.entries()],
  }
  const file = join(dir, CREATIONS_CACHE_FILE)
  const temporary = `${file}.${process.pid}.tmp`
  await mkdir(dir, { recursive: true })
  await writeFile(temporary, JSON.stringify(stored), 'utf8')
  try {
    await rename(temporary, file)
  } catch (error) {
    // A rename that fails leaves a temporary file behind; it is not a cache anyone reads.
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}
