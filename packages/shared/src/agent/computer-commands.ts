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
 */

import type { BrowserCommandImage } from './command-cli.ts'
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
    if (char === '\\' && i + 1 < line.length) {
      current += line[i + 1]
      started = true
      i += 1
      continue
    }
    if (char === '"') {
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
    positional.push(token)
  }
  return {
    verb,
    positional,
    ...(windowRef !== undefined ? { windowRef } : {}),
    ...(elementRef !== undefined ? { elementRef } : {}),
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
    lines.push(
      `- w${window.id} · ${window.app || 'unknown app'} · "${window.title}"` +
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
    `w${snapshot.window.id} · ${snapshot.window.app || 'unknown app'} · "${snapshot.window.title}"` +
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

// ============================================================================
// Execution
// ============================================================================

async function runOne(parsed: ParsedCommand, fns: ComputerPaneFns): Promise<ComputerToolCommandResult> {
  const { verb, positional, windowRef, elementRef } = parsed

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
      return { output: formatWindows(await fns.windows()) }

    case 'snapshot':
      return { output: formatSnapshot(await fns.snapshot(windowRef ? { windowId: windowRef } : {})) }

    case 'screenshot': {
      const shot = await fns.screenshot(windowRef ? { windowId: windowRef } : {})
      const where = shot.windowId ? `w${shot.windowId}` : 'the active window'
      return { output: `Screenshot ${shot.width}×${shot.height} of ${where}.`, image: toImage(shot) }
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
      await fns.clickAt({ x, y, ...(windowRef ? { windowId: windowRef } : {}) }, { mode: 'auto' })
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
    const result = await runOne(parseComputerCommand(line), opts.fns)
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
