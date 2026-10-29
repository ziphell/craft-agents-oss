/**
 * The `computer` door's command language.
 *
 * One command per call; the door that receives it (`device_tool`) decides which machine runs it.
 * Refs are written `w<windowId>:<elementIndex>` — the window is part of the ref because a desktop
 * has several trees and an index alone would be ambiguous.
 *
 * The verbs are ordered by what a person can trust:
 *
 * - `windows` / `snapshot` / `screenshot` read.
 * - `invoke` / `set-value` / `click` act on an **element the snapshot offered**, so the audit trail
 *   can name what was acted on (`Button "Submit"`) rather than a coordinate.
 * - `click-at` / `type` / `key` / `scroll` are the pixel rung: real input, marked in the reply so a
 *   reader can tell them apart from an accessibility invocation.
 *
 * Reads that name no window (`windows` / `snapshot` / `screenshot` / `click-at`) act on the
 * frontmost one, **including this app's own windows** — operating the app itself is a legitimate
 * ask. `--exclude-self` is the explicit opt-out for the cases where it is not (a capture meant to
 * show somebody else's screen).
 */

import type { BrowserCommandImage } from './command-cli.ts'
import { resolveLocalPath } from './command-cli.ts'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import type {
  ComputerActionOutcome,
  ComputerElement,
  ComputerPaneFns,
  ComputerSnapshot,
  ComputerTarget,
  ComputerWindowInfo,
} from './computer-pane.ts'

/** Appended when a command did something the person would want to know is still held. */
export const COMPUTER_RELEASE_HINT =
  '\n\nThe desktop is still held by this session. Run `computer` with `stop` to give it back now; ' +
  'it is released automatically when the session goes idle.'

const MAX_ELEMENTS_RENDERED = 400

export interface ComputerToolCommandArgs {
  /** One command, or several run in order. */
  command: string | string[]
  fns: ComputerPaneFns
  /**
   * Where a relative `--out` path counts from — the same rule `read --save` follows. Omitted for
   * probes and device calls with no workspace, where only an absolute path can be written.
   */
  workspaceRootPath?: string
}

export interface ComputerToolCommandResult {
  output: string
  image?: BrowserCommandImage
  images?: BrowserCommandImage[]
  appendReleaseHint?: boolean
}

// ============================================================================
// Parsing
// ============================================================================

/** Split a command line into tokens, honouring double quotes and backslash escapes. */
export function tokenizeComputerCommand(line: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quoted = false
  let started = false
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]!
    // A backslash is a **path separator here, not an escape**. This door runs on Windows, where
    // `C:\Users\me\shot.png` is the ordinary spelling; treating `\` as an escape ate them
    // (`C:Usersmeshot.png`), which is how a path stopped being absolute. Write `""` for a literal
    // quote inside quoted text.
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"'
        started = true
        i += 1
        continue
      }
      quoted = !quoted
      started = true
      continue
    }
    if (!quoted && /\s/.test(char)) {
      if (started) {
        tokens.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += char
    started = true
  }
  if (quoted) throw new Error('Unbalanced quote in command.')
  if (started) tokens.push(current)
  return tokens
}

interface ParsedCommand {
  verb: string
  positional: string[]
  /** `--window <id|title>` — the window a command acts on when the verb has no ref of its own. */
  windowRef?: string
  /** `--element <token>` — the field `type` should write into, instead of whatever has focus. */
  elementRef?: string
  /** `--exclude-self` — leave this app's own windows out of the default-window choice. */
  excludeSelf?: boolean
  /** `--out <dir|file>` — also write a screenshot there. */
  outRef?: string
}

const VERBS = new Set([
  'status',
  'windows',
  'snapshot',
  'screenshot',
  'click',
  'click-at',
  'invoke',
  'set-value',
  'type',
  'key',
  'scroll',
  'launch',
  'stop',
])

export function parseComputerCommand(line: string): ParsedCommand {
  const tokens = tokenizeComputerCommand(line.trim())
  const verb = tokens.shift()
  if (!verb) throw new Error('Empty command.')
  if (!VERBS.has(verb)) {
    throw new Error(`Unknown command "${verb}". Known: ${[...VERBS].join(', ')}.`)
  }
  const positional: string[] = []
  let windowRef: string | undefined
  let elementRef: string | undefined
  let outRef: string | undefined
  let excludeSelf = false
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!
    if (token === '--window') {
      const value = tokens[i + 1]
      if (!value) throw new Error('--window needs a window id or title.')
      windowRef = value
      i += 1
      continue
    }
    if (token === '--element') {
      const value = tokens[i + 1]
      if (!value) throw new Error('--element needs an element token from `snapshot`.')
      elementRef = value
      i += 1
      continue
    }
    if (token === '--out') {
      const value = tokens[i + 1]
      if (!value || value.startsWith('--')) throw new Error('--out needs a directory or file path.')
      outRef = value
      i += 1
      continue
    }
    if (token === '--exclude-self') {
      excludeSelf = true
      continue
    }
    positional.push(token)
  }
  return {
    verb,
    positional,
    ...(windowRef !== undefined ? { windowRef } : {}),
    ...(elementRef !== undefined ? { elementRef } : {}),
    ...(outRef !== undefined ? { outRef } : {}),
    ...(excludeSelf ? { excludeSelf } : {}),
  }
}

/**
 * `s00000001:12` → `{ token }`. The token is the driver's, copied from `snapshot` verbatim.
 *
 * Shape is checked here only so a hand-written index (`12`) fails with advice instead of reaching
 * the driver as an unknown token.
 */
export function parseComputerRef(ref: string): ComputerTarget {
  const token = ref.trim()
  if (!/^\S+:\d+$/.test(token)) {
    throw new Error(`"${ref}" is not an element token. Take one from \`snapshot\` (it looks like s00000001:12).`)
  }
  return { token }
}

function parseCoordinate(raw: string | undefined, what: string): number {
  if (raw == null) throw new Error(`"${what}" is required.`)
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new Error(`"${what}" must be a number.`)
  return value
}

function parseAmount(raw: string | undefined, fallback: number): number {
  if (raw == null) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) throw new Error('"amount" must be a non-negative number.')
  return value
}

// ============================================================================
// Rendering
// ============================================================================

function formatBounds(bounds: ComputerWindowInfo['bounds']): string {
  return bounds ? ` · ${bounds.width}×${bounds.height} at ${bounds.x},${bounds.y}` : ''
}

function formatWindows(windows: ComputerWindowInfo[]): string {
  if (windows.length === 0) {
    return 'No windows. The desktop may be locked, or this session has no display to read.'
  }
  const lines = [`${windows.length} window${windows.length === 1 ? '' : 's'}:`]
  for (const window of windows) {
    // macOS withholds window titles until Screen Recording is granted; an untitled window is still
    // a real target, so say so instead of printing empty quotes next to the app name.
    lines.push(
      `- w${window.id} · ${window.app || 'unknown app'} · "${window.title || '(no title)'}"` +
      (window.pid != null ? ` · pid ${window.pid}` : '') +
      (window.active ? ' · active' : '') +
      formatBounds(window.bounds),
    )
  }
  return lines.join('\n')
}

function formatElement(element: ComputerElement): string {
  const actions = element.actions.length > 0 ? ` [${element.actions.join(',')}]` : ''
  const value = element.value ? ` = ${JSON.stringify(element.value)}` : ''
  const disabled = element.enabled ? '' : ' (disabled)'
  return `${element.label ? `"${element.label}"` : '(unnamed)'}${value}${actions}${disabled}`
}

function formatSnapshot(snapshot: ComputerSnapshot): string {
  const header =
    `w${snapshot.window.id} · ${snapshot.window.app || 'unknown app'} · "${snapshot.window.title || '(no title)'}"` +
    ` · source=${snapshot.source} · ${snapshot.elements.length} element(s)`
  const lines = [header]
  if (snapshot.note) lines.push(`note: ${snapshot.note}`)
  if (snapshot.elements.length === 0) {
    lines.push(
      'No elements. This window exposes no accessible tree (canvas, game, or a locked session) — ' +
      'use `screenshot` together with `click-at` instead.',
    )
    return lines.join('\n')
  }
  const shown = snapshot.elements.slice(0, MAX_ELEMENTS_RENDERED)
  for (const element of shown) {
    const indent = '  '.repeat(Math.max(0, Math.min(element.depth ?? 0, 6)))
    lines.push(`${element.token}\t${indent}${element.role}\t${formatElement(element)}`)
  }
  if (snapshot.elements.length > shown.length) {
    lines.push(`… (${snapshot.elements.length - shown.length} more element(s) not shown)`)
  }
  return lines.join('\n')
}

function describeOutcome(ref: string, outcome: ComputerActionOutcome): string {
  const what = outcome.label ? `${outcome.role} "${outcome.label}"` : outcome.role
  return `Done: ${ref} · ${what} · delivered=${outcome.delivered}`
}

function toImage(result: { data: string; mimeType: 'image/png' | 'image/jpeg' }): BrowserCommandImage {
  return {
    data: result.data,
    mimeType: result.mimeType,
    sizeBytes: Math.ceil((result.data.length * 3) / 4),
  }
}

/**
 * The file `--out` means.
 *
 * A directory is created if needed and answered with the next `screenshot-0001.ext` (the numbering
 * `video_tool --out` uses), so repeated captures never overwrite each other. Anything that looks
 * like a file — it exists as one, or ends in an image extension — is written at that path; its
 * extension is corrected to the image's real format rather than leaving PNG bytes in a `.jpg`.
 */
function screenshotOutputPath(
  requested: string,
  mimeType: 'image/png' | 'image/jpeg',
  workspaceRootPath?: string,
): string {
  let resolved: string
  try {
    resolved = resolveLocalPath(requested, workspaceRootPath)
  } catch {
    throw new Error(
      `--out: "${requested}" is not absolute and there is no workspace to count a relative path from. ` +
      'Pass an absolute path.',
    )
  }
  const ext = mimeType === 'image/jpeg' ? 'jpg' : 'png'
  let existing: ReturnType<typeof statSync> | null = null
  try {
    existing = statSync(resolved)
  } catch {
    existing = null
  }
  const looksLikeFile = existing == null && /\.(png|jpe?g)$/i.test(extname(resolved))

  if (existing?.isDirectory() || (existing == null && !looksLikeFile)) {
    mkdirSync(resolved, { recursive: true })
    for (let index = 1; ; index += 1) {
      const candidate = join(resolved, `screenshot-${String(index).padStart(4, '0')}.${ext}`)
      if (!existsSync(candidate)) return candidate
    }
  }

  const givenExt = extname(resolved).toLowerCase()
  const file = !givenExt
    ? `${resolved}.${ext}`
    : givenExt === `.${ext}` || (ext === 'jpg' && givenExt === '.jpeg')
      ? resolved
      : `${resolved.slice(0, -givenExt.length)}.${ext}`
  mkdirSync(dirname(file), { recursive: true })
  return file
}

/** Write the captured image and answer where it went. */
function writeScreenshot(
  shot: { data: string; mimeType: 'image/png' | 'image/jpeg' },
  requested: string,
  workspaceRootPath?: string,
): string {
  const file = screenshotOutputPath(requested, shot.mimeType, workspaceRootPath)
  writeFileSync(file, Buffer.from(shot.data, 'base64'))
  return file
}

// ============================================================================
// Execution
// ============================================================================

async function runOne(
  parsed: ParsedCommand,
  fns: ComputerPaneFns,
  workspaceRootPath?: string,
): Promise<ComputerToolCommandResult> {
  const { verb, positional, windowRef, elementRef, outRef, excludeSelf } = parsed
  if (outRef !== undefined && verb !== 'screenshot') {
    throw new Error('--out only applies to screenshot.')
  }

  switch (verb) {
    case 'status': {
      const status = await fns.status()
      const lines = [
        `driver ${status.driver.version} · contract ${status.driver.contractVersion}`,
        `windows ${status.windows}`,
        `desktop capture: ${status.desktopCapture}`,
        `injected input: ${status.injectedInput}`,
        `agent cursor: ${status.agentCursor}`,
        ...status.permissions.map((line) => `  ${line}`),
      ]
      return { output: lines.join(String.fromCharCode(10)) }
    }

    case 'windows':
      return { output: formatWindows(await fns.windows(excludeSelf ? { excludeSelf: true } : undefined)) }

    case 'snapshot':
      return {
        output: formatSnapshot(await fns.snapshot({
          ...(windowRef ? { windowId: windowRef } : {}),
          ...(excludeSelf ? { excludeSelf: true } : {}),
        })),
      }

    case 'screenshot': {
      const shot = await fns.screenshot({
        ...(windowRef ? { windowId: windowRef } : {}),
        ...(excludeSelf ? { excludeSelf: true } : {}),
      })
      const where = shot.windowId ? `w${shot.windowId}` : 'the active window'
      const savedAt = outRef ? writeScreenshot(shot, outRef, workspaceRootPath) : null
      const scaleNote = shot.scale != null && Math.abs(shot.scale - 1) > 0.01
        ? ` · image scale ${shot.scale} px per window unit`
        : ''
      return {
        output: `Screenshot ${shot.width}×${shot.height} of ${where}${scaleNote}.` +
          (savedAt ? `\nSaved: ${savedAt}` : ''),
        // `path` tells a backend that shows images from disk (Pi) to use this file rather than
        // writing a second copy of the same capture.
        image: { ...toImage(shot), ...(savedAt ? { path: savedAt } : {}) },
      }
    }

    case 'click': {
      const ref = positional[0]
      if (!ref) throw new Error('click needs an element ref (w<window>:<index>).')
      return { output: describeOutcome(ref, await fns.clickElement(parseComputerRef(ref), { mode: 'auto' })) }
    }

    case 'invoke': {
      const ref = positional[0]
      if (!ref) throw new Error('invoke needs an element ref (w<window>:<index>).')
      const target = parseComputerRef(ref)
      return { output: describeOutcome(ref, await fns.invoke(target, positional[1])) }
    }

    case 'set-value': {
      const ref = positional[0]
      if (!ref) throw new Error('set-value needs an element ref (w<window>:<index>).')
      const value = positional.slice(1).join(' ')
      return { output: describeOutcome(ref, await fns.setValue(parseComputerRef(ref), value)) }
    }

    case 'click-at': {
      const x = parseCoordinate(positional[0], 'x')
      const y = parseCoordinate(positional[1], 'y')
      await fns.clickAt(
        { x, y, ...(windowRef ? { windowId: windowRef } : {}) },
        { mode: 'auto', ...(excludeSelf ? { excludeSelf: true } : {}) },
      )
      return {
        output: `Done: click-at ${x},${y}${windowRef ? ` in w${windowRef}` : ''}.`,
        appendReleaseHint: true,
      }
    }

    case 'type': {
      const text = positional.join(' ')
      if (!text) throw new Error('type needs text.')
      await fns.typeText(text, {
        ...(windowRef ? { windowId: windowRef } : {}),
        ...(elementRef ? { token: elementRef } : {}),
      })
      return { output: `Typed ${text.length} character(s).`, appendReleaseHint: true }
    }

    case 'key': {
      const combo = positional[0]
      if (!combo) throw new Error('key needs a combination, e.g. key ctrl+s.')
      await fns.sendKey(combo, windowRef ? { windowId: windowRef } : undefined)
      return { output: `Sent ${combo}.`, appendReleaseHint: true }
    }

    case 'scroll': {
      const direction = (positional[0] ?? '').toLowerCase()
      if (!['up', 'down', 'left', 'right'].includes(direction)) {
        throw new Error('scroll needs a direction: up, down, left or right.')
      }
      const amount = parseAmount(positional[1], 3)
      await fns.scroll(
        direction as 'up' | 'down' | 'left' | 'right',
        amount,
        windowRef ? { windowId: windowRef } : undefined,
      )
      return { output: `Scrolled ${direction} ${amount}.`, appendReleaseHint: true }
    }

    case 'launch': {
      const app = positional.join(' ')
      if (!app) throw new Error('launch needs an application name.')
      const launched = await fns.launchApp(app)
      return {
        output: `Launched ${app}${launched.windowId ? ` (w${launched.windowId})` : ''}` +
          `${launched.pid != null ? ` · pid ${launched.pid}` : ''}.`,
      }
    }

    case 'stop':
      await fns.stop()
      return { output: 'Desktop released.' }

    default:
      throw new Error(`Unhandled command "${verb}".`)
  }
}

/**
 * Run one command, or several in order, and answer in the shape the door expects.
 *
 * A failure stops the batch: the remaining commands were written against a screen the failed one
 * was supposed to change, so continuing would act on a stale picture.
 */
export async function executeComputerToolCommand(
  opts: ComputerToolCommandArgs,
): Promise<ComputerToolCommandResult> {
  const lines = Array.isArray(opts.command) ? opts.command : [opts.command]
  if (lines.length === 0) throw new Error('No command given.')
  const outputs: string[] = []
  const images: BrowserCommandImage[] = []
  let appendReleaseHint = false
  for (const line of lines) {
    const result = await runOne(parseComputerCommand(line), opts.fns, opts.workspaceRootPath)
    outputs.push(result.output)
    if (result.image) images.push(result.image)
    if (result.images) images.push(...result.images)
    if (result.appendReleaseHint) appendReleaseHint = true
  }
  const [first] = images
  return {
    output: outputs.join('\n\n'),
    ...(first ? { image: first } : {}),
    ...(images.length > 1 ? { images } : {}),
    ...(appendReleaseHint ? { appendReleaseHint } : {}),
  }
}
