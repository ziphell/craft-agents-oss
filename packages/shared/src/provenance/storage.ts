/**
 * Reading and writing the notes — the filesystem half of provenance.
 *
 * Kept apart from `graph.ts` so the view can import the lineage queries without dragging `fs` into
 * the renderer bundle.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { atomicWriteFileSync } from '../utils/files.ts'
import { RECORD_SUFFIX, recordPathFor, toPosix } from './paths.ts'
import type { GenerationRecord } from './types.ts'

/** Folders that hold tooling rather than a person's work: walking them finds nothing to show. */
const SKIP_DIRS = new Set(['.git', 'node_modules'])

/**
 * The project folder a file belongs to: the nearest folder above it holding a `config.json`.
 *
 * A project's own folder is always deeper than the workspace that contains it, so the nearest match
 * is the right one — and a file outside every project simply has no project folder, which is the
 * honest answer. Nothing is written for those: a note is only useful inside a project.
 */
export function findProjectDir(startPath: string): string | null {
  let current = resolve(startPath)
  try {
    if (!statSync(current).isDirectory()) current = dirname(current)
  } catch {
    current = dirname(current)
  }
  for (;;) {
    if (existsSync(join(current, 'config.json'))) return current
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

/** A path as the project names it. */
export function toProjectPath(projectDir: string, absolutePath: string): string {
  return toPosix(relative(projectDir, absolutePath))
}

/**
 * Write the note beside its file.
 *
 * The artifact is already on disk when this runs; a note that cannot be written is a lost line of
 * history, not a failed generation, so the caller decides whether to care.
 */
export function writeGenerationRecord(filePath: string, record: GenerationRecord): void {
  atomicWriteFileSync(recordPathFor(filePath), JSON.stringify(record, null, 2))
}

/** One note, as stored. Absent, unreadable or not a record → null; never an exception. */
export function readGenerationRecord(filePath: string): GenerationRecord | null {
  const path = recordPathFor(filePath)
  if (!existsSync(path)) return null
  try {
    return normalizeRecord(JSON.parse(readFileSync(path, 'utf8')) as Partial<GenerationRecord>)
  } catch {
    // An unreadable note says nothing about the picture beside it.
    return null
  }
}

/** One shape for every read, so a hand-edited or half-written note cannot become a broken record. */
function normalizeRecord(parsed: Partial<GenerationRecord>): GenerationRecord | null {
  if (typeof parsed.file !== 'string' || !parsed.file) return null
  return {
    file: toPosix(parsed.file),
    prompt: typeof parsed.prompt === 'string' ? parsed.prompt : '',
    references: Array.isArray(parsed.references)
      ? parsed.references.filter((item): item is string => typeof item === 'string').map(toPosix)
      : [],
    ...(typeof parsed.firstFrame === 'string' && parsed.firstFrame
      ? { firstFrame: toPosix(parsed.firstFrame) }
      : {}),
    ...(typeof parsed.lastFrame === 'string' && parsed.lastFrame
      ? { lastFrame: toPosix(parsed.lastFrame) }
      : {}),
    channel: typeof parsed.channel === 'string' ? parsed.channel : undefined,
    model: typeof parsed.model === 'string' ? parsed.model : undefined,
    params: parsed.params && typeof parsed.params === 'object' ? parsed.params : undefined,
    session: typeof parsed.session === 'string' ? parsed.session : undefined,
    at: typeof parsed.at === 'number' ? parsed.at : 0,
  }
}

export interface ReadGenerationRecordsOptions {
  /**
   * Include notes whose artifact is gone.
   *
   * The default is the lineage view's rule: a note about a missing file says nothing about a file
   * that exists. The asset registry asks the other question — "was this path ever an asset?" — and
   * needs those records to keep a generated asset visible after its file is deleted.
   */
  includeMissing?: boolean
}

/**
 * Every note in a project, newest first.
 *
 * The folder is read as it is — there is no index to fall behind. A note whose file is gone is
 * skipped by default rather than cleaned up: reading must not edit the folder a person is looking
 * at. Callers that maintain a registry pass `includeMissing` to keep the record.
 */
export function readGenerationRecords(
  projectDir: string,
  options: ReadGenerationRecordsOptions = {},
): GenerationRecord[] {
  const records: GenerationRecord[] = []

  const walk = (dir: string): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name))
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith(RECORD_SUFFIX)) continue

      let record: GenerationRecord | null = null
      try {
        record = normalizeRecord(
          JSON.parse(readFileSync(join(dir, entry.name), 'utf8')) as Partial<GenerationRecord>,
        )
      } catch {
        // One unreadable note says nothing about the file beside it, or about the next note.
      }
      if (!record) continue
      if (!options.includeMissing && !existsSync(join(projectDir, record.file))) continue
      records.push(record)
    }
  }

  walk(projectDir)
  // Ordering is the reader's business (`newestFirst` in `graph.ts`): this returns what the folder
  // holds, so there is only one place that decides what "newest first" means.
  return records
}
