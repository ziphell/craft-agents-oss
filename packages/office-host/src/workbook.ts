/**
 * The workbook host: a `.xlsx` parsed and read by the workbook sidecar.
 *
 * Of the four editors, this is the one whose document lives **outside JavaScript**. The sheets app
 * parses and writes through `xlsx-sidecar` — a Rust process speaking JSON over stdio — because the
 * fidelity that matters (styles, tables, pivots, conditional formats, and only-the-edited-parts
 * rewritten) is not something a JavaScript spreadsheet library reproduces. The client below is the
 * app's own (`apps/sheets/src/main/xlsx-sidecar-client.ts`), bundled by
 * `scripts/build-office-engine.ts`; the binary is `resources/office-native/xlsx-sidecar`.
 *
 * What this file owns, then, is the *session*: one sidecar session per open workbook, keyed by the
 * file's path, started lazily and stopped when the app quits.
 *
 * **Reading is hosted; writing is not yet.** The editor's save path asks the host to build the
 * archive's parts (the workbook gateway turns the renderer's edit journal into OOXML fragments) and
 * hands them to the sidecar as `save_archive`. That builder is a bigger piece than this one — so
 * `saveWorkbook` answers with a sentence instead of pretending, and everything that only *reads* a
 * workbook works today.
 */

import { existsSync } from 'node:fs'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { getBundledAssetsDir } from '@craft-agent/shared/utils'
import { checkDocument, conflictMessage, recordFromDisk } from './guard'
import { officeRuntime } from './runtime'
import { noteUnwired } from './deck'

/** The slice of the bundled client this host uses (see `resources/office-engine/xlsx.d.ts`). */
interface WorkbookClient {
  start(): void
  stop(): void
  onProcessExit(listener: () => void): () => void
  open(path: string, locale?: string): Promise<unknown>
  readRange(input: {
    sessionId: string
    sheetId: string
    range: { startRow: number; endRow: number; startColumn: number; endColumn: number }
  }): Promise<unknown>
  readRowOutline(input: { sessionId: string; sheetId: string }): Promise<unknown>
  /** The reads the editor asks for directly; each is a sidecar command with its own schema. */
  readFormulaCells(input: Record<string, unknown> & { sessionId: string }): Promise<unknown>
  findCells(input: Record<string, unknown> & { sessionId: string }): Promise<unknown>
  readMedia(input: Record<string, unknown> & { sessionId: string }): Promise<unknown>
  /** IronCalc recalculation, on demand. */
  recalcCells(input: Record<string, unknown> & { sessionId: string }): Promise<unknown>
  close(sessionId: string): Promise<void>
}

interface WorkbookSession {
  /** The sidecar's session id — the handle every read is addressed against. */
  sessionId: string
  /** The parse result the editor renders from (sheets, styles, widths…). */
  snapshot: unknown
  /** What the file looked like when that parse was made (see `workbookOpen`). */
  stamp: { mtimeMs: number; size: number }
}

const sessions = new Map<string, WorkbookSession>()
let client: WorkbookClient | null = null

/** The binary this platform runs, beside the engine bundle. */
function sidecarPath(): string | null {
  const root = getBundledAssetsDir('office-native')
  if (!root) return null
  const binary = process.platform === 'win32' ? 'xlsx-sidecar.exe' : 'xlsx-sidecar'
  const path = join(root, binary)
  return existsSync(path) ? path : null
}

/**
 * The client, started on first use.
 *
 * Started here rather than at app launch: a session that never opens a workbook should not carry a
 * resident process. A sidecar that dies is *not* recovered here — every session it held is gone,
 * so the honest answer is an error the frame can show, not a silent reopen.
 */
function loadClient(): WorkbookClient {
  if (client) return client
  const binary = sidecarPath()
  if (!binary) {
    throw new Error('The workbook sidecar is not installed. Run: bun scripts/build-office-assets.ts')
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { XlsxSidecarClient } = require(join(getBundledAssetsDir('office-engine')!, 'xlsx.cjs')) as {
    XlsxSidecarClient: new (binaryPath: string) => WorkbookClient
  }
  const instance = new XlsxSidecarClient(binary)
  instance.start()
  client = instance
  return instance
}

/** Stop the sidecar with the app. */
export function stopWorkbookHost(): void {
  client?.stop()
  client = null
  sessions.clear()
}

/**
 * When the file looked like this, as far as the parse in hand is concerned.
 *
 * A session is a parse of **bytes**, so it is only an answer for the file those bytes came from. The
 * frame is remounted when the document is reloaded (a change on disk, an agent's write, ⌘S from
 * somewhere else), and that remount asks for the document again — answering from the session would
 * hand it the version it was reloading *away* from, with the new bytes sitting on disk untouched.
 */
async function fileStamp(path: string): Promise<{ mtimeMs: number; size: number } | null> {
  try {
    const stats = await stat(path)
    return { mtimeMs: stats.mtimeMs, size: stats.size }
  } catch {
    // Gone or unreadable: re-opening cannot help, so the parse in hand stays the best answer.
    return null
  }
}

/** Open (or reuse) the session for a path; the answer is the snapshot the editor renders. */
export async function workbookOpen(path: string, locale = 'zh'): Promise<unknown> {
  const existing = sessions.get(path)
  if (existing) {
    const current = await fileStamp(path)
    if (!current || (current.mtimeMs === existing.stamp.mtimeMs && current.size === existing.stamp.size)) {
      return existing.snapshot
    }
    // The bytes moved on: the old session describes a file that is no longer there.
    await workbookClose(path)
  }
  const stamp = await fileStamp(path)
  const opened = (await loadClient().open(path, locale)) as { sessionId?: string }
  if (!opened || typeof opened.sessionId !== 'string') {
    throw new Error('The workbook sidecar did not open this file.')
  }
  sessions.set(path, { sessionId: opened.sessionId, snapshot: opened, stamp: stamp ?? { mtimeMs: 0, size: 0 } })
  return opened
}

/** A rectangle of cells, as the editor asks for it while scrolling. */
export async function workbookReadRange(
  path: string,
  sheetId: string,
  range: { startRow: number; endRow: number; startColumn: number; endColumn: number },
): Promise<unknown> {
  const session = sessions.get(path)
  if (!session) throw new Error('No workbook is open for this file.')
  return loadClient().readRange({ sessionId: session.sessionId, sheetId, range })
}

/** The row outline (grouping) a sheet keeps. */
/** One sheet as the parse result describes it: what the used area is, and its name. */
interface SheetFacts {
  id: string
  name: string
  rowCount: number
  columnCount: number
}

/** The sheets the parse result knows about — the only place the used area is written down. */
function sheetsOf(session: WorkbookSession): SheetFacts[] {
  const snapshot = session.snapshot as { sheets?: Array<Record<string, unknown>> } | undefined
  return (snapshot?.sheets ?? [])
    .map((sheet) => ({
      id: typeof sheet.id === 'string' ? sheet.id : '',
      name: typeof sheet.name === 'string' ? sheet.name : '',
      rowCount: Number(sheet.rowCount) || 0,
      columnCount: Number(sheet.columnCount) || 0,
    }))
    .filter((sheet) => sheet.id)
}

/**
 * Row grouping, from the **range** read.
 *
 * The sidecar's own `read_row_outline` is in GenOffice's Rust source but not in the binary this
 * build ships (zero occurrences in `xlsx-sidecar.exe`), so asking for it waits out the client's
 * timeout. It is not needed: `read_range` already answers each row's `outlineLevel`, `hidden` and
 * `collapsed` — the same data, from the same parse — so the outline is a projection of an answer we
 * already get, not a missing feature.
 */
export async function workbookRowOutline(path: string, sheetId: string): Promise<unknown> {
  const session = sessions.get(path)
  if (!session) return null
  const sheet = sheetsOf(session).find((candidate) => candidate.id === sheetId)
  if (!sheet) return { rows: [], indexingComplete: true }

  const range = (await workbookReadRange(path, sheetId, {
    startRow: 0,
    endRow: Math.max(0, sheet.rowCount - 1),
    startColumn: 0,
    endColumn: Math.max(0, sheet.columnCount - 1),
  })) as { rows?: Array<Record<string, unknown>> } | null

  const rows = (range?.rows ?? [])
    .map((row) => ({
      row: Number(row.row) || 0,
      level: Number(row.outlineLevel) || 0,
      ...(row.collapsed === true ? { collapsed: true } : {}),
      ...(row.hidden === true ? { hidden: true } : {}),
    }))
    // Level 0 is "not grouped": the editor draws nothing for it, and a sheet with no groups should
    // answer an empty list rather than every row it has.
    .filter((row) => row.level > 0)
    .sort((left, right) => left.row - right.row)

  return { rows, indexingComplete: true }
}

/** One cell's text, as a person reading the sheet would see it. */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  return String(value)
}

/** Excel's wildcards, as a matcher: `*` is any run, `?` is one character, `~` escapes both. */
export function wildcardMatcher(pattern: string, matchCase: boolean, whole: boolean): (text: string) => boolean {
  let source = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!
    if (character === '~' && index + 1 < pattern.length) {
      source += pattern[index + 1]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      index += 1
      continue
    }
    if (character === '*') source += '.*'
    else if (character === '?') source += '.'
    else source += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  const flags = matchCase ? '' : 'i'
  const regex = new RegExp(`${whole ? '^' : ''}${source}${whole ? '$' : ''}`, flags)
  return (text) => regex.test(text)
}

/**
 * Find across a workbook's cells, over the **range** read.
 *
 * Their sidecar walks a chunk index; we read the used area of each sheet and filter it here. That is
 * more work per search and less work per install — no new native binary — and the used area is known
 * from the parse result, so nothing has to be guessed. The answer is the shape the editor validates:
 * matches (paged), whether the search finished, and where to resume.
 */
export async function workbookFindCells(
  path: string,
  request: Record<string, unknown>,
): Promise<unknown> {
  const session = sessions.get(path)
  if (!session) return { matches: [], complete: true, indexingComplete: true }

  const query = typeof request.query === 'string' ? request.query : ''
  if (!query) return { matches: [], complete: true, indexingComplete: true }
  const matchCase = request.matchCase === true
  const whole = request.matchEntireCell === true
  const useWildcards = request.wildcards === true
  const lookIn = typeof request.lookIn === 'string' ? request.lookIn : 'values'
  const limit = Math.max(1, Math.min(100_000, Number(request.limit) || 1000))

  const needle = matchCase ? query : query.toLowerCase()
  const test = useWildcards
    ? wildcardMatcher(query, matchCase, whole)
    : (text: string) => {
        const haystack = matchCase ? text : text.toLowerCase()
        return whole ? haystack === needle : haystack.includes(needle)
      }

  const wanted = typeof request.sheetId === 'string' && request.sheetId
    ? sheetsOf(session).filter((sheet) => sheet.id === request.sheetId)
    : sheetsOf(session)
  const resumeAt = request.resumeAt as { sheetId?: string; row?: number; column?: number } | undefined

  const matches: Array<Record<string, unknown>> = []
  let complete = true
  let nextCursor: Record<string, unknown> | undefined
  let started = !resumeAt

  for (const sheet of wanted) {
    if (!started) {
      // Resume where the last page stopped: its sheet, then its row/column, inclusive.
      if (resumeAt?.sheetId !== sheet.id) continue
      started = true
    }
    let range: { cells?: Array<Record<string, unknown>> } | null = null
    try {
      range = (await workbookReadRange(path, sheet.id, {
        startRow: 0,
        endRow: Math.max(0, sheet.rowCount - 1),
        startColumn: 0,
        endColumn: Math.max(0, sheet.columnCount - 1),
      })) as { cells?: Array<Record<string, unknown>> } | null
    } catch {
      complete = false
      continue
    }

    for (const cell of range?.cells ?? []) {
      const row = Number(cell.row) || 0
      const column = Number(cell.column) || 0
      if (resumeAt?.sheetId === sheet.id) {
        const afterRow = row > (Number(resumeAt.row) || 0)
        const sameRow = row === (Number(resumeAt.row) || 0) && column >= (Number(resumeAt.column) || 0)
        if (!afterRow && !sameRow) continue
      }

      const value = cell.value ?? null
      const formula = typeof cell.formula === 'string' ? cell.formula : undefined
      const text = cellText(value)
      const inValues = lookIn !== 'formulas_only' && text !== '' && test(text)
      const inFormulas = lookIn !== 'values' && formula !== undefined && test(formula)
      if (!inValues && !inFormulas) continue

      matches.push({
        sheetId: sheet.id,
        row,
        column,
        value,
        valueText: text === '' ? null : text,
        ...(formula !== undefined ? { formulaText: formula } : {}),
      })
      if (matches.length >= limit) {
        complete = false
        nextCursor = { sheetId: sheet.id, row, column }
        break
      }
    }
    if (nextCursor) break
  }

  return { matches, complete, ...(nextCursor ? { nextCursor } : {}), indexingComplete: true }
}


export async function workbookClose(path: string): Promise<void> {
  const session = sessions.get(path)
  if (!session) return
  sessions.delete(path)
  await client?.close(session.sessionId).catch(() => undefined)
}

/**
 * Turn the editor's cell edits into the command line's `--cells` payload.
 *
 * Both speak the same thing — a sheet, a cell, and the content that goes in it — so this is a
 * rename, not an interpretation. A1 addressing is what the command line takes, and that is the one
 * piece of arithmetic here: the editor addresses cells by row and column number.
 */
function cellsForEdits(
  edits: Array<{ sheetId?: string; row?: number; column?: number; value?: unknown; formula?: string; style?: unknown }>,
  sheetNameById: Map<string, string>,
): Array<{ sheet?: string; cell: string; value?: unknown; formula?: string; style?: unknown }> {
  const columnName = (index: number): string => {
    let name = ''
    let n = index
    do {
      name = String.fromCharCode(65 + (n % 26)) + name
      n = Math.floor(n / 26) - 1
    } while (n >= 0)
    return name
  }

  const cells: Array<{ sheet?: string; cell: string; value?: unknown; formula?: string; style?: unknown }> = []
  for (const edit of edits) {
    const row = Number(edit.row)
    const column = Number(edit.column)
    if (!Number.isInteger(row) || !Number.isInteger(column) || row < 0 || column < 0) continue
    const sheet = edit.sheetId ? sheetNameById.get(edit.sheetId) : undefined
    const hasFormula = typeof edit.formula === 'string' && edit.formula !== ''
    const hasValue = edit.value !== undefined
    cells.push({
      ...(sheet ? { sheet } : {}),
      cell: `${columnName(column)}${row + 1}`,
      // A cell entry with no value and no formula is a **style-only** edit; the command line reads
      // that as "leave the content alone and apply the delta", which is what the editor meant.
      ...(hasFormula ? { formula: edit.formula } : hasValue ? { value: edit.value } : {}),
      ...(edit.style ? { style: edit.style } : {}),
    })
  }
  return cells
}

/** Where the command line lives (the same three answers the document tool uses). */
function genofficeCli(): string | null {
  const configured = process.env.GENOFFICE_CLI
  if (configured && existsSync(configured)) return configured
  const candidates = [
    // `resourcesPath` is Electron's addition to `process`; absent on a hub, which finds the CLI
    // through `getBundledAssetsDir` above (CRAFT_BUNDLED_ASSETS_ROOT) instead.
    typeof (process as { resourcesPath?: string }).resourcesPath === 'string'
      ? join((process as { resourcesPath?: string }).resourcesPath!, 'cli', 'genoffice.cjs')
      : null,
    join(process.cwd(), 'apps', 'electron', 'resources', 'cli', 'genoffice.cjs'),
    join(process.cwd(), '..', 'genoffice', 'packages', 'cli', 'dist', 'genoffice.cjs'),
  ].filter((path): path is string => !!path)
  return candidates.find((path) => existsSync(path)) ?? null
}

function runCli(cliPath: string, args: string[], cwd: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    // Which binary runs the CLI is the host's decision, not this function's — see runtime.ts. On a
    // hub there is no Electron to borrow a Node from, and the app must pass `ELECTRON_RUN_AS_NODE`
    // or it starts a second copy of itself.
    const runtime = officeRuntime()
    const env: NodeJS.ProcessEnv = { ...process.env, ...runtime.env, ...extraEnv }
    const child = spawn(runtime.command, [cliPath, ...args], { cwd, env })
    let out = ''
    child.stdout?.on('data', (chunk) => (out += String(chunk)))
    child.stderr?.on('data', (chunk) => (out += String(chunk)))
    child.on('error', (error) => resolve({ code: -1, out: error.message }))
    child.on('close', (code) => resolve({ code: code ?? -1, out }))
  })
}

/**
 * Write a workbook through `genoffice sheet apply` — the same gateway and sidecar the app saves
 * with, in a process of its own. The write is atomic there (a temp file renamed over the target),
 * so a failure leaves the previous file intact.
 */
async function saveCellsThroughCli(
  path: string,
  edits: Array<{ sheetId?: string; row?: number; column?: number; value?: unknown; formula?: string; style?: unknown }>,
): Promise<{ ok: boolean; path?: string; error?: string; written?: number }> {
  const cliPath = genofficeCli()
  if (!cliPath) {
    return { ok: false, error: 'The document engine is not installed (resources/cli), so the workbook cannot be written.' }
  }

  const sheetNameById = new Map<string, string>()
  const opened = sessions.get(path)?.snapshot as { sheets?: Array<{ id?: string; name?: string }> } | undefined
  for (const sheet of opened?.sheets ?? []) {
    if (sheet?.id && sheet.name) sheetNameById.set(sheet.id, sheet.name)
  }

  const cells = cellsForEdits(edits, sheetNameById)
  if (cells.length === 0) return { ok: true, path, written: 0 }

  const dir = await mkdtemp(join(tmpdir(), 'craft-workbook-'))
  try {
    const cellsPath = join(dir, 'cells.json')
    await writeFile(cellsPath, JSON.stringify(cells), 'utf8')
    // The command line resolves its own sidecar from a packaged layout; ours lives beside the
    // engine bundle, so it is named here.
    const binary = sidecarPath()
    const result = await runCli(cliPath, ['sheet', 'apply', path, '--cells', cellsPath], join(path, '..'), binary ? { XLSX_SIDECAR_PATH: binary } : {})
    if (result.code !== 0) {
      return { ok: false, error: result.out.trim().slice(0, 600) || `The workbook engine declined (exit ${result.code}).` }
    }
    return { ok: true, path, written: cells.length }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * Is this workbook redacted, and can we read the answer?
 *
 * The metadata is one JSON part (`xl/gxRedactions.json`). This host does not parse it — the
 * redaction tool is GenOffice's — but *whether the part exists* decides which honest answer to
 * give: `absent` when nothing was ever withheld, `unreadable` when something was and we cannot
 * say what. Emptiness is not on the menu.
 */
async function redactionAnswer(
  path: string,
): Promise<{ status: 'absent' } | { status: 'unreadable'; error: string }> {
  try {
    // jszip ships beside the engine for exactly this: one entry, without the sidecar.
    const jszip = (await import('jszip')) as unknown as {
      default: { loadAsync(data: Uint8Array): Promise<{ files: Record<string, unknown> }> }
    }
    const { readFile } = await import('node:fs/promises')
    const zip = await jszip.default.loadAsync(new Uint8Array(await readFile(path)))
    if (!zip.files['xl/gxRedactions.json']) return { status: 'absent' }
    return {
      status: 'unreadable',
      error: 'This host does not read redaction metadata (xl/gxRedactions.json).',
    }
  } catch (error) {
    return { status: 'unreadable', error: error instanceof Error ? error.message : String(error) }
  }
}


/**
 * The editor's method table, as one door — the same arrangement as the deck host.
 *
 * `OfficeFrame` forwards with the document's path in front (`[path, ...args]`), because the frame
 * knows which file it is showing and the renderer only knows method names.
 */
export async function officeWorkbookCall(method: string, args: unknown[]): Promise<unknown> {
  const path = typeof args[0] === 'string' ? args[0] : ''
  const rest = args.slice(1)

  switch (method) {
    /**
     * The sheets editor's opening handshake, and the reason an embedded workbook used to be empty.
     *
     * It does not pull a document: on boot (and again once Univer has mounted) it asks
     * `hasQueuedWorkbook()`, and only calls `selectWorkbook()` — the actual open — when the answer
     * is true (`apps/sheets/src/renderer/main.tsx`, then `App.tsx`'s `handleInspectWorkbook`).
     *
     * Both export hosts answered `true` already (`office-export-host.ts`, `render-host`), so a
     * poster drew the file's data while the same bundle in a frame sat on a blank in-memory
     * "Sheet1": this door had no case for the question, `noteUnwired` answered `undefined`, and
     * `selectWorkbook` was never called. Measured with `apps/electron/spike/sheets-open-probe.ts`:
     * without this case the editor asks for 11 methods and never opens the file; with it, it asks
     * `selectWorkbook`, then streams the grid through `readWorkbookRange`.
     *
     * `true` is the honest answer here for the same reason it is in an export window: whichever
     * door is asking, it is asking about **one** document, and that is the one the frame was opened
     * with. A door with no path at all (a draft) is the only case where nothing is queued.
     */
    case 'hasQueuedWorkbook':
      return path.length > 0

    case 'reopenWorkbook':
    case 'selectWorkbook':
      return workbookOpen(path)

    case 'readWorkbookRange': {
      const request = (rest[0] ?? {}) as { sheetId?: string; range?: Record<string, number> }
      if (!request.sheetId || !request.range) return null
      return workbookReadRange(path, request.sheetId, {
        startRow: Number(request.range.startRow) || 0,
        endRow: Number(request.range.endRow) || 0,
        startColumn: Number(request.range.startColumn) || 0,
        endColumn: Number(request.range.endColumn) || 0,
      })
    }

    /**
     * Row/column outlines, under **two names**.
     *
     * GenOffice's main calls it `readWorkbookRowOutline` and the editor asks for exactly that;
     * this host had it as `readRowOutline`, so the editor's outline loader answered `undefined`
     * and gave up in its own catch — grouped rows simply never appeared. Both names answer now:
     * the second one is not wrong, it is just not the one on the wire. The sheet id arrives as
     * `{ sheetId }` (the editor's request) or bare (this host's older shape).
     */
    case 'readWorkbookRowOutline':
    case 'readRowOutline': {
      const request = rest[0]
      const sheetId =
        typeof request === 'string'
          ? request
          : typeof (request as { sheetId?: unknown } | undefined)?.sheetId === 'string'
            ? String((request as { sheetId: string }).sheetId)
            : ''
      if (!sheetId) return { rows: [], indexingComplete: true }
      // No timeout any more: this is a projection of `read_range`, which the sidecar does answer.
      return workbookRowOutline(path, sheetId)
    }

    /**
     * The reads the editor does through the sidecar, forwarded as they arrive.
     *
     * Their main validates the request with a schema and passes it to the client unchanged; so do
     * we, with the open session's id in front — the path is ours, the `sessionId` is the sidecar's,
     * and only this host knows both.
     */
    case 'readWorkbookFormulas':
    case 'readWorkbookMedia': {
      const session = sessions.get(path)
      if (!session) return null
      const request = { ...((rest[0] ?? {}) as Record<string, unknown>), sessionId: session.sessionId }
      const clientCall =
        method === 'readWorkbookFormulas' ? loadClient().readFormulaCells(request) : loadClient().readMedia(request)
      return Promise.race([
        clientCall,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 8_000).unref?.()),
      ])
    }

    /** Find is ours: the binary has no `find_cells`, but it answers every cell through `read_range`. */
    case 'findWorkbookCells':
      return workbookFindCells(path, (rest[0] ?? {}) as Record<string, unknown>)

    /** IronCalc recalculation, on demand (the sidecar owns the formula engine). */
    case 'recalcWorkbook': {
      const session = sessions.get(path)
      if (!session) return false
      const request = { ...((rest[0] ?? {}) as Record<string, unknown>), sessionId: session.sessionId }
      const result = (await Promise.race([
        loadClient().recalcCells(request),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 20_000).unref?.()),
      ])) as unknown
      return result !== null
    }

    /**
     * Redaction metadata (`xl/gxRedactions.json`), in the editor's discriminated shape.
     *
     * This host does not parse that part, and "nothing is withheld" is the one answer it must not
     * invent: a workbook somebody redacted would then show its hidden values as ordinary cells.
     * So the package is checked for the part — absent means the question does not apply, present
     * means this host cannot read it and says so.
     */
    case 'readWorkbookRedactions':
      return redactionAnswer(path)

    /**
     * The name shown on comments and the collaboration strip.
     *
     * GenOffice asks the OS for it. A hosted workbook has no person behind it — the app's frame
     * answers with the configured author, an export window has none — so an empty string is the
     * honest answer rather than a machine name nobody chose.
     */
    case 'getUserDisplayName':
      return ''

    case 'closeWorkbook':
      await workbookClose(path)
      return null

    /**
     * Writing a workbook.
     *
     * The fidelity that matters here (styles, tables, charts, pivots, only-the-edited-parts
     * rewritten) lives in the workbook gateway — and the gateway's own assembly is `genoffice
     * sheet apply`, which runs the same pipeline headlessly on the same sidecar. So the save goes
     * **through that command line** rather than re-implementing three hundred lines of archive
     * assembly here: same engines, same result, one implementation to keep faithful.
     *
     * What is translated is the edit journal: a cell's value or formula. A style-only edit or a
     * structural op is refused **by name** — dropping it silently would be a save that quietly
     * discards work.
     */
    case 'saveWorkbook': {
      const request = (rest[0] ?? {}) as {
        edits?: Array<{
          sheetId?: string
          row?: number
          column?: number
          writeValue?: boolean
          value?: unknown
          formula?: string
          style?: unknown
          styleReset?: boolean
        }>
        sheetOps?: Array<Record<string, unknown>>
        sheetOrder?: string[]
        /** The person's answer to "save anyway", after a refusal said the file had changed. */
        overwrite?: boolean
      }
      const edits = Array.isArray(request.edits) ? request.edits : []
      const sheetOps = Array.isArray(request.sheetOps) ? request.sheetOps : []
      const order = Array.isArray(request.sheetOrder) ? request.sheetOrder : []

      // Before anything is written: the sidecar session was built from bytes read at open time, so
      // if the file on disk has moved on (an agent edit, another program), the edits below would be
      // applied to a snapshot that no longer exists and the file would be replaced wholesale.
      if (!request.overwrite && (await checkDocument(path)) === 'conflict') {
        return { ok: false, error: conflictMessage(path), conflict: true }
      }

      // "Reset to the default style first" has no equivalent in the command line's cell payload
      // (a delta is applied to what is there), so it is the one edit this path refuses — by name.
      const resets = edits.filter((edit) => edit.styleReset === true)
      if (resets.length) {
        return {
          ok: false,
          error: `${resets.length} edit(s) clear formatting back to the default style, which this save path cannot express yet. Save from the app for those.`,
        }
      }
      if (edits.length === 0 && sheetOps.length === 0) return { ok: true, path, note: 'nothing to write' }

      // Cells first, then structure: a sheet op can rename or add a sheet that cell addresses
      // depend on, so the cells land against the names the editor knew.
      const cellResult = await saveCellsThroughCli(path, edits)
      if (!cellResult.ok) return cellResult
      const structureResult = await saveStructureThroughCli(path, sheetOps, order)
      if (!structureResult.ok) return structureResult
      // Re-recorded from what is now on disk: the CLI wrote it, so this app never held the bytes,
      // and the next save must be compared against this result rather than the file it replaced.
      await recordFromDisk(path)
      return {
        ok: true,
        path,
        written: cellResult.written ?? 0,
        ...(structureResult.written ? { structure: structureResult.written } : {}),
      }
    }

    default:
      noteUnwired('workbook', method)
      return undefined
  }
}

/**
 * The sheet-level operations a save can carry: rename, add, duplicate, delete, hide, and the tab
 * order. They travel as the command line's workbook DSL (`--ops`), addressed by the sheet's
 * **name** — which is what the editor's ids are translated into here.
 *
 * Ops this path does not translate (charts, pivots, validations, tab colours) are refused **by
 * name**: a save that quietly forgets a chart is worse than one that says it did.
 */
async function saveStructureThroughCli(
  path: string,
  sheetOps: Array<Record<string, unknown>>,
  order: string[],
): Promise<{ ok: boolean; path?: string; error?: string; written?: number }> {
  if (sheetOps.length === 0 && order.length === 0) return { ok: true }

  const cliPath = genofficeCli()
  if (!cliPath) return { ok: false, error: 'The document engine is not installed (resources/cli).' }

  const sheetNameById = new Map<string, string>()
  const opened = sessions.get(path)?.snapshot as { sheets?: Array<{ id?: string; name?: string }> } | undefined
  for (const sheet of opened?.sheets ?? []) {
    if (sheet?.id && sheet.name) sheetNameById.set(sheet.id, sheet.name)
  }
  const nameOf = (id: unknown): string | undefined => (typeof id === 'string' ? sheetNameById.get(id) : undefined)

  const ops: Array<Record<string, unknown>> = []
  const skipped: string[] = []

  for (const op of sheetOps) {
    const kind = typeof op.kind === 'string' ? op.kind : ''
    switch (kind) {
      case 'rename-sheet': {
        const sheetId = nameOf(op.sheetId)
        if (sheetId && typeof op.newName === 'string') ops.push({ op: 'rename_sheet', sheetId, name: op.newName })
        else skipped.push(kind)
        break
      }
      case 'add-sheet':
        if (typeof op.name === 'string') ops.push({ op: 'add_sheet', name: op.name })
        else skipped.push(kind)
        break
      case 'duplicate-sheet': {
        const sheetId = nameOf(op.sourceSheetId)
        if (sheetId) ops.push({ op: 'duplicate_sheet', sheetId, ...(typeof op.name === 'string' ? { name: op.name } : {}) })
        else skipped.push(kind)
        break
      }
      case 'delete-sheet': {
        const sheetId = nameOf(op.sheetId)
        if (sheetId) ops.push({ op: 'delete_sheet', sheetId })
        else skipped.push(kind)
        break
      }
      case 'set-sheet-hidden': {
        const sheetId = nameOf(op.sheetId)
        if (sheetId) ops.push({ op: 'set_sheet_hidden', sheetId, hidden: op.hidden === true })
        else skipped.push(kind)
        break
      }
      case 'reorder-sheets':
        // Handled below from the request's final order, not from the op itself.
        break
      default:
        skipped.push(kind || '(unknown)')
    }
  }

  // Tab order: one `move_sheet` per position, in order — the DSL moves a sheet to a 1-based slot.
  for (const [index, sheetId] of order.entries()) {
    const name = nameOf(sheetId)
    if (name) ops.push({ op: 'move_sheet', sheetId: name, position: index + 1 })
  }

  if (ops.length === 0) {
    return skipped.length
      ? { ok: false, error: `These sheet operations cannot be written from here yet: ${[...new Set(skipped)].join(', ')}.` }
      : { ok: true, written: 0 }
  }

  const dir = await mkdtemp(join(tmpdir(), 'craft-workbook-ops-'))
  try {
    const opsPath = join(dir, 'ops.json')
    await writeFile(opsPath, JSON.stringify(ops), 'utf8')
    const binary = sidecarPath()
    const result = await runCli(cliPath, ['sheet', 'apply', path, '--ops', opsPath], join(path, '..'), binary ? { XLSX_SIDECAR_PATH: binary } : {})
    if (result.code !== 0) {
      return { ok: false, error: result.out.trim().slice(0, 600) || `The workbook engine declined (exit ${result.code}).` }
    }
    return { ok: true, path, written: ops.length }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}
