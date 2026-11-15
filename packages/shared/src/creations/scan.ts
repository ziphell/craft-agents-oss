/**
 * Building the library out of what is already on disk.
 *
 * The scan is per session, and every session's result is cached against `(size, mtimeMs)` — the
 * two numbers that change whenever a turn is appended. So a warm call reads one session (the one
 * that is running) and re-stats the rest, which is the difference between "open the library" and
 * "re-read 120 MB of transcripts".
 *
 * The cache is held in memory and, when the host has a folder of its own, **written down between
 * launches** (`cache-file.ts`). What makes that safe is the key above: the refresh below stats every
 * transcript whether its entry came from memory or from that file, so a remembered entry is only
 * ever a shortcut to a re-parse and never an answer in its own right. The numbers it removes are the
 * whole reason it exists — a real workspace (133 sessions, 140 MB) costs 565 ms to build from
 * nothing and 75 ms to verify once it exists, and the first open of a launch was paying the first.
 *
 * The parse itself is a `readFile` and a `split`, not a `readline` stream: measured on that same
 * workspace, a stream pass that did nothing with the lines cost 613 ms and the same bytes read and
 * split cost 164 ms.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { extractArtifacts } from './extract'
import {
  formatOfPath,
  isBookkeepingPath,
  isMediaFormat,
  isWorkFormat,
  MEDIA_FORMATS,
  normalizeArtifactPath,
  placeOfPath,
  titleOfPath,
} from './paths'
import { readGenerationRecord } from '../provenance/storage'
import { recordPathFor } from '../provenance/paths'
import {
  CREATIONS_INDEX_VERSION,
  type Creation,
  type CreationFormat,
  type CreationOrigin,
  type CreationPlace,
  type CreationsQuery,
  type CreationsScanStats,
  type CreationsSnapshot,
} from './types'

/** One path one tool call named, already resolved and classified. */
interface SessionHit {
  path: string
  format: CreationFormat
  place: CreationPlace
  projectSlug: string | null
  role: 'created' | 'modified'
  explicit: boolean
  tool: string
  messageId: string
  turnId: string | null
  at: number
}

/** A session as the scan remembers it. Invalidated by a change to `(size, mtimeMs)`. */
export interface SessionEntry {
  size: number
  mtimeMs: number
  name: string | null
  /**
   * The project this conversation belongs to, from its own header.
   *
   * Kept here rather than on a hit: it is a fact about the session, not about the path a tool
   * named, and every work the session wrote inherits it — including the ones attributed by folder
   * alone, which have no tool call to read it from.
   */
  projectId: string | null
  /** How many tool calls the transcript had — a cheap health number for the empty state. */
  toolRecords: number
  hits: SessionHit[]
}

/**
 * One workspace's cache. Held in memory, and — when the host has a folder of its own — written down
 * between launches (`cache-file.ts`): the same entries, re-keyed against the filesystem on every
 * refresh, so a remembered one is only ever a shortcut to a re-parse, never an answer.
 */
export interface CreationsCache {
  version: number
  sessions: Map<string, SessionEntry>
}

export function createCreationsCache(): CreationsCache {
  return { version: CREATIONS_INDEX_VERSION, sessions: new Map() }
}

/**
 * Every path the index has a record of — including ones a view is filtering out.
 *
 * Callers that keep something *next to* a creation (the poster cache, for instance) need this
 * rather than the visible list: a work hidden by a filter is still a work, and its picture must not
 * be collected as garbage just because nobody is looking at it.
 */
export function knownCreationPaths(cache: CreationsCache): string[] {
  const paths = new Set<string>()
  for (const entry of cache.sessions.values()) {
    for (const hit of entry.hits) paths.add(hit.path)
  }
  return [...paths]
}

/** The header line every `session.jsonl` starts with. Only these fields are used. */
interface SessionHeader {
  id?: string
  name?: string
  workingDirectory?: string
  sdkCwd?: string
  projectId?: string
}

/**
 * Read one session's transcript into hits. The only part that touches file contents.
 *
 * **A read and a split, not a `readline` stream.** Measured on the transcripts of a real workspace
 * (133 sessions, 140 MB): a `readline` pass that does nothing with the lines costs 613 ms, while
 * reading the same bytes asynchronously and splitting them costs 164 ms — the stream's per-line
 * machinery, not the bytes, is the price. There is nothing here that wants a stream either: a
 * transcript is a megabyte, it is read once, and the whole thing is needed anyway.
 *
 * The prefilter is kept because it is the cheap half of the work: 20k of 32k lines name a tool, and
 * `JSON.parse` of the rest is what would make this slow for no reason.
 */
async function parseSession(
  sessionId: string,
  sessionDir: string,
  workspaceRootPath: string,
): Promise<{ header: SessionHeader | null; hits: SessionHit[]; toolRecords: number }> {
  const file = join(sessionDir, 'session.jsonl')
  const hits: SessionHit[] = []
  const seen = new Set<string>()
  let header: SessionHeader | null = null
  let toolRecords = 0

  const text = await readFile(file, 'utf8')
  let firstLine = true
  let cwd = workspaceRootPath

  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    if (firstLine) {
      firstLine = false
      try {
        header = JSON.parse(line) as SessionHeader
        const declared = header.workingDirectory ?? header.sdkCwd
        if (declared) cwd = declared
      } catch {
        // A header that cannot be read is not fatal: the session still has a name-less list.
      }
      continue
    }
    // Cheap prefilter: the JSON.parse below is the expensive part, and most lines are not calls.
    if (!line.includes('"toolInput"')) continue

    let record: {
      type?: string
      id?: string
      turnId?: string | null
      timestamp?: number
      toolName?: string
      toolInput?: unknown
    }
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (record.type !== 'tool') continue
    toolRecords += 1
    if (!record.toolName || !record.toolInput) continue

    const context = { workspaceRootPath, sessionDir, cwd }
    for (const hit of extractArtifacts(record.toolName, record.toolInput)) {
      const path = normalizeArtifactPath(hit.raw, context)
      if (!path) continue
      const format = formatOfPath(path)
      if (!format) continue
      // Documents are works. A picture, clip or recording is one only when a tool **named it as an
      // output**: `Write` of a png is a copied file, while `media_tool generate --out`, a drawio
      // export or a converted image is something produced. Data files stay out either way.
      if (!isWorkFormat(format) && !(isMediaFormat(format) && hit.explicit)) continue
      // The app's own scratchpad is not something the agent made for a person.
      if (isBookkeepingPath(path, workspaceRootPath)) continue
      // One tool call naming the same path twice (an `--out` and a `--to`) is one event.
      const key = `${hit.tool}|${record.id ?? ''}|${path}`
      if (seen.has(key)) continue
      seen.add(key)
      const place = placeOfPath(path, workspaceRootPath)
      hits.push({
        path,
        format,
        place: place.place,
        projectSlug: place.projectSlug,
        role: hit.role,
        explicit: hit.explicit,
        tool: hit.tool,
        messageId: record.id ?? '',
        turnId: record.turnId ?? null,
        at: record.timestamp ?? 0,
      })
    }
  }

  return { header, hits, toolRecords }
}

/**
 * A file an agent edited in a source tree is not a work.
 *
 * This is the one rule that keeps the library from becoming a second file browser: `Write` of a
 * new `README.md` inside a checkout, and `Edit` of an i18n locale, both land in `source` and stay
 * out — unless a tool named that path as an **output**, which is a decision, not an accident.
 *
 * Being inside a project is not enough either: a project's root holds the agent's own memory file
 * and its config, and neither is a deliverable (see `isBookkeepingPath`).
 */
function worthShowing(hit: SessionHit, query: CreationsQuery): boolean {
  if (hit.place === 'session' || hit.place === 'project') return true
  if (hit.explicit) return true
  return query.includeSources === true
}

/** The newest origin, by time then by arrival — the card's one-line provenance. */
function newest(origins: CreationOrigin[]): CreationOrigin {
  let last = origins[0]!
  for (const origin of origins) if (origin.at >= last.at) last = origin
  return last
}

/** Folders a session writes into — the ones a person would look in, not its whole tree. */
const SESSION_OUTPUT_DIRS = ['data', 'plans', 'downloads', 'long_responses', 'attachments']

/** How deep a project folder is read. Deep enough for `reports/2026/q3/x.xlsx`, no deeper. */
const PROJECT_MAX_DEPTH = 4

/** Directories that are never a document's home. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.craft', 'dist', 'build', '.cache'])

/**
 * The formats discovery looks for — **the ones an engine writes**.
 *
 * A `.docx` is not typed by anybody: it comes out of a converter or a command line, and the tool
 * that names its `--out` may not be the one that ran it (`Bash` can call the same engine). Text
 * formats are the opposite case: markdown, html and drawio are written by `Write`/`Edit`, which the
 * transcript records — so a text file with no record is far more likely to be something *copied or
 * captured* (a saved web page, a scraped snapshot) than something made. Discovery returns the
 * binaries; the transcript keeps the text.
 */
const DISCOVERY_FORMATS: ReadonlySet<CreationFormat> = new Set<CreationFormat>(['docx', 'xlsx', 'pptx', 'pdf'])

/** Everything a directory holds that could be a work, one level down. */
function documentsIn(
  dir: string,
  out: string[],
  depth: number,
  formats: ReadonlySet<CreationFormat> = DISCOVERY_FORMATS,
): void {
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as unknown as typeof entries
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (depth > 0 && !entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name)) {
        documentsIn(full, out, depth - 1, formats)
      }
      continue
    }
    if (!entry.isFile()) continue
    const format = formatOfPath(full)
    if (format && formats.has(format)) out.push(full)
  }
}

/**
 * Documents the transcripts never named, with the origin their **folder** proves.
 *
 * A file under `sessions/<id>/data/` was written by that session — the folder is the session's own
 * output folder, and the path is the evidence. A file under `projects/<slug>/` belongs to that
 * project and to no conversation in particular, which is what its card says.
 *
 * `already` is the transcript's own set: a file a tool named keeps its real provenance and is not
 * re-attributed to "found on disk". That distinction matters — "turn 7 of *Report v2* wrote this"
 * is a better answer than "it is in that session's folder".
 */
function discoverDocuments(
  workspaceRootPath: string,
  already: ReadonlyMap<string, Creation>,
  cache: CreationsCache,
): Creation[] {
  const found: string[] = []

  const sessionsRoot = join(workspaceRootPath, 'sessions')
  let sessionIds: string[] = []
  try {
    sessionIds = readdirSync(sessionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    sessionIds = []
  }
  for (const sessionId of sessionIds) {
    for (const dir of SESSION_OUTPUT_DIRS) documentsIn(join(sessionsRoot, sessionId, dir), found, 1)
  }

  const projectsRoot = join(workspaceRootPath, 'projects')
  let projectSlugs: string[] = []
  try {
    projectSlugs = readdirSync(projectsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    projectSlugs = []
  }
  for (const slug of projectSlugs) documentsIn(join(projectsRoot, slug), found, PROJECT_MAX_DEPTH)

  const creations: Creation[] = []
  for (const path of found) {
    if (already.has(path)) continue
    const format = formatOfPath(path)
    if (!format) continue
    if (isBookkeepingPath(path, workspaceRootPath)) continue
    const place = placeOfPath(path, workspaceRootPath)
    if (place.place !== 'session' && place.place !== 'project') continue

    // The folder names the session; the transcript names it better, when it has a record.
    const sessionId = place.place === 'session' ? (relative(join(workspaceRootPath, 'sessions'), path).split(sep)[0] ?? '') : ''
    let at = 0
    try {
      at = statSync(path).mtimeMs
    } catch {
      continue
    }
    const origin: CreationOrigin = {
      sessionId,
      sessionName: sessionId ? (cache.sessions.get(sessionId)?.name ?? null) : null,
      messageId: '',
      turnId: null,
      at,
      tool: 'disk',
      role: 'created',
    }
    creations.push({
      id: path,
      path,
      title: titleOfPath(path),
      format,
      place: place.place,
      projectSlug: place.projectSlug,
      projectSlugs: [],
      bytes: 0,
      mtimeMs: at,
      exists: true,
      origins: [origin],
      last: origin,
      explicit: false,
    })
  }
  return creations
}

/**
 * Generated media the transcripts never named, proven by the note beside the file.
 *
 * A generated picture usually lands in `assets/` — the canvas writes there, and `media_tool` falls
 * back there when no `--out` is given — so the path never appears in a tool call. The `.gen.json`
 * note is the proof that it was made rather than copied, and reading it is what keeps uploads and
 * screenshots out: a file is a work here only because something recorded how it was produced.
 *
 * An ordinary conversation has no asset panel; this is how its generated pictures and clips still
 * reach the library. Both session folders and project folders are read, because a canvas makes its
 * pictures in the project while an unbound conversation makes them in its own folder.
 */
function discoverGeneratedMedia(
  workspaceRootPath: string,
  already: ReadonlyMap<string, Creation>,
  cache: CreationsCache,
): Creation[] {
  const found: string[] = []

  const sessionsRoot = join(workspaceRootPath, 'sessions')
  let sessionIds: string[] = []
  try {
    sessionIds = readdirSync(sessionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    sessionIds = []
  }
  for (const sessionId of sessionIds) {
    documentsIn(join(sessionsRoot, sessionId, 'assets'), found, 2, MEDIA_FORMATS)
  }

  const projectsRoot = join(workspaceRootPath, 'projects')
  let projectSlugs: string[] = []
  try {
    projectSlugs = readdirSync(projectsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    projectSlugs = []
  }
  for (const slug of projectSlugs) {
    documentsIn(join(projectsRoot, slug, 'assets'), found, 3, MEDIA_FORMATS)
  }

  const creations: Creation[] = []
  for (const path of found) {
    if (already.has(path)) continue
    const format = formatOfPath(path)
    if (!format || !isMediaFormat(format)) continue
    // The note is the source: no note, no claim that this file was produced.
    if (!existsSync(recordPathFor(path))) continue
    if (isBookkeepingPath(path, workspaceRootPath)) continue
    const place = placeOfPath(path, workspaceRootPath)
    if (place.place !== 'session' && place.place !== 'project') continue

    const record = readGenerationRecord(path)
    // A session folder names its session; a project file can only learn it from the note, which
    // the agent's own path writes. A canvas generation has none — the panel is not a conversation.
    const folderSessionId =
      place.place === 'session'
        ? (relative(sessionsRoot, path).split(sep)[0] ?? '')
        : ''
    const sessionId = folderSessionId || record?.session || ''
    let at = record?.at ?? 0
    if (!at) {
      try {
        at = statSync(path).mtimeMs
      } catch {
        continue
      }
    }
    const origin: CreationOrigin = {
      sessionId,
      sessionName: sessionId ? (cache.sessions.get(sessionId)?.name ?? null) : null,
      messageId: '',
      turnId: null,
      at,
      tool: 'media',
      role: 'created',
    }
    creations.push({
      id: path,
      path,
      title: titleOfPath(path),
      format,
      place: place.place,
      projectSlug: place.projectSlug,
      projectSlugs: [],
      bytes: 0,
      mtimeMs: at,
      exists: true,
      origins: [origin],
      last: origin,
      explicit: true,
    })
  }
  return creations
}

/**
 * `projectId` → `slug`, read from each project's own config.
 *
 * The two sides name a project differently: a **slug** is what a folder is called and what a route
 * takes, while a session records the **id** it was bound to. This is the one place they meet. It is
 * read rather than cached — a handful of small JSON files, on a scan that already walks the
 * workspace, and a cache would be a second place a renamed project could go stale.
 */
function projectSlugById(workspaceRootPath: string): Map<string, string> {
  const projectsRoot = join(workspaceRootPath, 'projects')
  const byId = new Map<string, string>()
  let dirs: string[] = []
  try {
    dirs = readdirSync(projectsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return byId
  }
  for (const dir of dirs) {
    try {
      const config = JSON.parse(readFileSync(join(projectsRoot, dir, 'config.json'), 'utf8')) as {
        id?: string
        slug?: string
      }
      // The folder name is the slug unless the config says otherwise: a project keeps its own
      // answer, and the directory is only what it fell back to.
      if (config.id) byId.set(config.id, config.slug || dir)
    } catch {
      // A project mid-creation has no readable config yet; it names nothing until it does.
    }
  }
  return byId
}

/**
 * Which projects a work belongs to, by slug.
 *
 * Both halves are facts already on disk: the folder it sits in, and the project each conversation
 * that touched it belongs to. Folding them is what makes this dimension worth having — an agent
 * writes into `sessions/<id>/`, so **the folder alone names a project for almost nothing**, which
 * is exactly why "project" used to be an empty filter and the session's own binding is the fact
 * that carries the weight.
 */
function projectsOf(
  creation: Creation,
  cache: CreationsCache,
  slugById: ReadonlyMap<string, string>,
): string[] {
  const slugs = new Set<string>()
  if (creation.projectSlug) slugs.add(creation.projectSlug)
  for (const origin of creation.origins) {
    const projectId = cache.sessions.get(origin.sessionId)?.projectId
    const slug = projectId ? slugById.get(projectId) : undefined
    if (slug) slugs.add(slug)
  }
  return [...slugs]
}

/**
 * Refresh the library.
 *
 * `cache` is mutated: unchanged sessions are kept, changed ones are re-parsed, vanished ones are
 * dropped. The returned snapshot is what a caller renders; nothing is written anywhere.
 */
export async function refreshCreations(
  workspaceRootPath: string,
  cache: CreationsCache,
  query: CreationsQuery = {},
): Promise<CreationsSnapshot> {
  if (cache.version !== CREATIONS_INDEX_VERSION) {
    cache.version = CREATIONS_INDEX_VERSION
    cache.sessions.clear()
  }

  const sessionsRoot = join(workspaceRootPath, 'sessions')
  let sessionDirs: string[] = []
  try {
    sessionDirs = readdirSync(sessionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    sessionDirs = []
  }

  const stats: CreationsScanStats = {
    sessions: sessionDirs.length,
    parsed: 0,
    toolRecords: 0,
    hits: 0,
    shown: 0,
    hidden: 0,
    discovered: 0,
  }
  const alive = new Set(sessionDirs)
  for (const sessionId of cache.sessions.keys()) {
    if (!alive.has(sessionId)) cache.sessions.delete(sessionId)
  }

  // Read once per refresh, and after the cache is current: the project fold below asks it for
  // every origin of every work, and re-reading four configs per card would be silly.
  const slugById = projectSlugById(workspaceRootPath)

  // A first refresh reads every session in the workspace (151 of them, ~174 MB of transcript
  // here), and each parse is synchronous JSON work on the main process — which is the process that
  // answers every other IPC. Yielding every few sessions turns "the app freezes for a few seconds"
  // into "the file list arrives a moment later", which is the difference people actually feel.
  let parsed_since_yield = 0

  for (const sessionId of sessionDirs) {
    const sessionDir = join(sessionsRoot, sessionId)
    let stat
    try {
      stat = statSync(join(sessionDir, 'session.jsonl'))
    } catch {
      continue
    }
    const cached = cache.sessions.get(sessionId)
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) continue

    try {
      const { header, hits, toolRecords } = await parseSession(sessionId, sessionDir, workspaceRootPath)
      cache.sessions.set(sessionId, {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        name: header?.name?.trim() || null,
        projectId: header?.projectId ?? null,
        toolRecords,
        hits,
      })
      stats.parsed += 1
      if (++parsed_since_yield >= 8) {
        parsed_since_yield = 0
        await new Promise<void>(resolve => setImmediate(resolve))
      }
    } catch {
      // A session that cannot be read is skipped, not fatal: it may be mid-write.
    }
  }

  for (const entry of cache.sessions.values()) stats.toolRecords += entry.toolRecords

  // ── merge ──
  const byPath = new Map<string, Creation>()
  for (const [sessionId, entry] of cache.sessions) {
    for (const hit of entry.hits) {
      if (!worthShowing(hit, query)) {
        stats.hidden += 1
        continue
      }
      const origin: CreationOrigin = {
        sessionId,
        sessionName: entry.name,
        messageId: hit.messageId,
        turnId: hit.turnId,
        at: hit.at,
        tool: hit.tool,
        role: hit.role,
      }
      const existing = byPath.get(hit.path)
      if (existing) {
        existing.origins.push(origin)
        if (hit.explicit) existing.explicit = true
        continue
      }
      byPath.set(hit.path, {
        id: hit.path,
        path: hit.path,
        title: titleOfPath(hit.path),
        format: hit.format,
        place: hit.place,
        projectSlug: hit.projectSlug,
        projectSlugs: [],
        bytes: 0,
        mtimeMs: 0,
        exists: false,
        origins: [origin],
        last: origin,
        explicit: hit.explicit,
      })
    }
  }

  // ── discovery: what is on disk that no tool ever named ──
  //
  // Not every file is written by a tool whose arguments say so. A document produced by a command
  // line (the office engine, run through `Bash`), copied in, or written by a script appears in no
  // transcript — and a library that showed only what it could attribute would hide most of a
  // workspace's real output. So the folders are read too, and what they hold is attributed by
  // **where it is**: a file under `sessions/<id>/data/` is that session's output, and a file under
  // `projects/<slug>/` belongs to that project.
  //
  // Bash arguments are still deliberately not parsed: a path in a shell line is a guess, a path on
  // disk is a fact.
  for (const found of [
    ...discoverDocuments(workspaceRootPath, byPath, cache),
    // Generated media is attributed by its note, not by folder alone: the `.gen.json` is what says
    // "made", which is why a dropped-in picture stays out.
    ...discoverGeneratedMedia(workspaceRootPath, byPath, cache),
  ]) {
    byPath.set(found.path, found)
    stats.discovered += 1
  }

  // ── stat: does it still exist, and how big ──
  const creations: Creation[] = []
  for (const creation of byPath.values()) {
    try {
      const stat = statSync(creation.path)
      creation.exists = stat.isFile()
      creation.bytes = stat.isFile() ? stat.size : 0
      creation.mtimeMs = stat.mtimeMs
    } catch {
      creation.exists = false
    }
    creation.origins.sort((a, b) => a.at - b.at)
    creation.last = newest(creation.origins)
    creation.projectSlugs = projectsOf(creation, cache, slugById)
    if (!creation.exists && !query.includeMissing) {
      stats.hidden += 1
      continue
    }
    creations.push(creation)
  }

  creations.sort((a, b) => {
    if (a.exists !== b.exists) return a.exists ? -1 : 1
    return (b.mtimeMs || b.last.at) - (a.mtimeMs || a.last.at)
  })

  stats.hits = [...byPath.values()].reduce((sum, creation) => sum + creation.origins.length, 0)
  stats.shown = creations.length

  return {
    generatedAt: Date.now(),
    workspaceRootPath,
    stats,
    creations,
  }
}
