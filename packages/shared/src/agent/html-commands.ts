/**
 * `html_tool`'s commands.
 *
 * HTML has had an element index since the visual editor landed — parse5 gives every element's character offsets in
 * the source (`shared/html/source-edits.ts`), which is how an edit in the frame becomes a patch to one span. What was
 * missing is a door an agent can knock on: `elements` says what a page is made of, so a change can name an element
 * the way a markdown change names a block.
 *
 * ```
 * elements <file>                       the page's elements, by path, with their tag and first text
 * ```
 *
 * Read-only for now, and deliberately shaped like `markdown_tool blocks`: name it before you change it.
 */

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { indexHtml, patchElementHtml, replaceOnce } from '../html/source-edits.ts'
import {
  contentRootOf,
  resolveLocalPath,
  tokenizeCommand,
  type BrowserCommandImage,
  type BrowserCommandResult,
  type ToolCommandArgs,
} from './command-cli.ts'

export function htmlHelp(): string {
  return `Read and change an HTML file the way the editor sees it (one command per call).

The visual editor changes a page one **element** at a time, addressed by its path of element-child indices — the same
address this tool takes. That is what lets a change land in the page's own source without reformatting it.

\`elements <file>\` lists the page's elements in document order: the path, the tag, and the first words of the element's
own text. A path nobody printed is a path that was guessed, so read this first. Text is shown only for elements that
hold text and nothing else.

\`set <file> --path <p> --html "<markup>"\` replaces one element — its tags and everything inside — keeping every other
byte of the file, indentation included. The markup is inserted as written.

\`edit <file> --expect "<text>" --text "<text>"\` changes one occurrence, and only when it is unambiguous. An open page
takes the change in its own editor; otherwise the file is edited directly.

\`shot <file> [--width n] [--height n] [--out <dir>]\` draws the page into the reply — the file itself, loaded by its
own address, so its relative stylesheets and images resolve and its scripts run: the picture is the page a person opens
rather than its skeleton. It waits for the page to finish loading its own resources and for the timers and fetches it
started.

Paths count from the workspace root.`
}

const say = (output: string, failed = false): BrowserCommandResult => ({
  output: failed ? `Error: ${output}` : output,
  appendReleaseHint: failed,
})

/** 5 MB is the API's limit for an image once encoded; base64 inflates by 4/3. */
const MAX_IMAGE_BYTES = 3_750_000

/** The pictures that ride the reply, and a path for any that could not. */
function imagesOf(files: string[]): BrowserCommandImage[] {
  const images: BrowserCommandImage[] = []
  for (const path of files) {
    try {
      const size = statSync(path).size
      if (size > MAX_IMAGE_BYTES) continue
      images.push({ data: readFileSync(path).toString('base64'), mimeType: 'image/png', sizeBytes: size, path })
    } catch {
      // A picture that vanished is already a path in the text.
    }
  }
  return images
}

/**
 * A picture of the page, into the reply.
 *
 * Scripts do **not** run: this is the same window an `html-preview` block is drawn in, and the app
 * never executes a page it is only showing. A file whose content is built by script therefore comes
 * back as its static skeleton — which is the honest answer to "what will this look like", because
 * it is exactly what the person reading it sees.
 */
async function shotPage(args: {
  path: string
  tokens: string[]
  captureWebShot?: ToolCommandArgs['captureWebShot']
}): Promise<BrowserCommandResult> {
  const flags = new Map<string, string>()
  for (let i = 2; i < args.tokens.length; i += 1) {
    const token = args.tokens[i]!
    if (!token.startsWith('--')) return say(`Unexpected "${token}" — shot takes --width, --height and --out.`, true)
    const name = token.slice(2)
    if (name !== 'width' && name !== 'height' && name !== 'out') {
      return say(`shot does not take --${name}: it takes --width, --height and --out.`, true)
    }
    const value = args.tokens[i + 1]
    if (!value || value.startsWith('--')) return say(`--${name} needs a value.`, true)
    flags.set(name, value)
    i += 1
  }

  const size = (name: string, fallback: number) => {
    const raw = flags.get(name)
    if (!raw) return fallback
    const value = Number(raw)
    if (!Number.isFinite(value) || value < 50 || value > 4000) {
      return null
    }
    return Math.round(value)
  }
  const width = size('width', 1000)
  const height = size('height', 625)
  if (width === null || height === null) {
    return say('--width and --height are pixels between 50 and 4000.', true)
  }

  if (!args.captureWebShot) {
    return say(
      'This host has no renderer, so it cannot draw a page. `elements` works anywhere: it reads the file itself.',
      true,
    )
  }

  const out = flags.get('out')
  const outDir = out ? resolveLocalPath(out, process.cwd()) : join(tmpdir(), `craft-shot-${process.pid}-${Date.now()}`)
  const scratch = !out
  // The host writes into the directory it is given; a scratch one is ours to create.
  mkdirSync(outDir, { recursive: true })
  try {
    const files = await args.captureWebShot({ path: args.path, width, height, outDir })
    if (!files.length) return say(`Could not draw ${basename(args.path)}.`, true)
    const images = imagesOf(files)
    const label = `${basename(args.path)} — ${width}×${height}, scripts run`
    // When a picture is too large to ride the reply, its path is still what `Read` needs.
    const named = [label, ...files].join(String.fromCharCode(10))
    return { output: images.length ? label : named, images, appendReleaseHint: false }
  } catch (error) {
    return say(`${basename(args.path)} could not be drawn: ${error instanceof Error ? error.message : String(error)}`, true)
  } finally {
    if (scratch) rmSync(outDir, { recursive: true, force: true })
  }
}

export async function executeHtmlToolCommand(args: {
  command: string | string[]
  workspaceRootPath?: string | undefined
  /** The session's own place: bare paths count from the content root it names. */
  sessionId?: string | undefined
  projectId?: string | undefined
  sessionWorkingDirectory?: string | undefined
  /** See `ToolCommandArgs.applyEdit` — `edit` is the one command that reads it. */
  applyEdit?: ToolCommandArgs['applyEdit']
  /** See `ToolCommandArgs.captureWebShot` — `shot` is the one command that reads it. */
  captureWebShot?: ToolCommandArgs['captureWebShot']
}): Promise<BrowserCommandResult> {
  const cwd = contentRootOf(args) ?? args.workspaceRootPath ?? process.cwd()
  const tokens = Array.isArray(args.command)
    ? args.command.flatMap((part) => tokenizeCommand(part))
    : tokenizeCommand(args.command ?? '')

  const command = tokens[0]?.toLowerCase()
  if (!command || command === 'help' || command === '--help' || command === '-h') return say(htmlHelp())
  if (command !== 'elements' && command !== 'set' && command !== 'edit' && command !== 'shot') {
    return say(
      `Unknown command "${tokens[0]}". Commands: elements <file>, set <file> --path <p> --html "…", ` +
        'edit <file> --expect "…" --text "…", shot <file> [--width n] [--height n] [--out <dir>].',
      true,
    )
  }

  const file = tokens[1]
  if (!file) return say(command + ' needs a file: `' + command + ' <file>`.', true)
  const path = resolveLocalPath(file, cwd)

  if (command === 'shot') return shotPage({ path, tokens, captureWebShot: args.captureWebShot })

  let source: string
  try {
    source = readFileSync(path, 'utf8')
  } catch (error) {
    return say(`Cannot read ${basename(path)}: ${error instanceof Error ? error.message : String(error)}`, true)
  }

  if (command === 'set') return setElement({ path, source, tokens })
  if (command === 'edit') return editText({ path, source, tokens, applyEdit: args.applyEdit })

  const index = indexHtml(source)
  if (index.size === 0) return say(`${basename(path)} has no elements: it is empty, or not HTML at all.`)

  // Document order is the order `indexHtml` walked, which is the order the frame numbers: sort by path numerically.
  const rows = [...index.values()].sort((a, b) => comparePaths(a.path, b.path))
  const lines = rows.map((info) => {
    const own = info.editableText ? firstText(source, info.innerStart, info.innerEnd) : ''
    return `${info.path.padEnd(10)} ${info.tag.padEnd(10)} ${own}`
  })
  return say(`${basename(path)} — ${rows.length} element(s):\n${lines.join('\n')}`)
}

/** `1/10` after `1/9`: a path is a list of numbers, not a string. */
function comparePaths(a: string, b: string): number {
  const left = a.split('/').map(Number)
  const right = b.split('/').map(Number)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const l = left[index]
    const r = right[index]
    if (l === undefined) return -1
    if (r === undefined) return 1
    if (l !== r) return l - r
  }
  return 0
}

function firstText(source: string, start: number, end: number, limit = 48): string {
  const text = source
    .slice(start, end)
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

/** The value after a flag, or `undefined` when the flag is absent. */
function valueOf(tokens: readonly string[], flag: string): string | undefined {
  const at = tokens.indexOf(flag)
  return at >= 0 ? tokens[at + 1] : undefined
}

/**
 * `set <file> --path <p> --html "<markup>"` — one element replaced, by its own offsets.
 *
 * The path is the address `elements` printed, and an address nobody printed is refused: substituting a guess would
 * rewrite a different element than the caller meant, and the file would still look plausible afterwards.
 */
function setElement(args: { path: string; source: string; tokens: readonly string[] }): BrowserCommandResult {
  const { path, source, tokens } = args
  const elementPath = valueOf(tokens, '--path')
  const html = valueOf(tokens, '--html')
  if (!elementPath || html === undefined) {
    return say('set needs an element and its markup: `set <file> --path 1/1/0 --html "<p>…</p>"`.', true)
  }

  const info = indexHtml(source).get(elementPath)
  if (!info) {
    const known = [...indexHtml(source).keys()].sort().slice(0, 12).join(', ')
    return say(
      `No element at path ${elementPath} in ${basename(path)}. Paths it has include: ${known || '(none)'}.`,
      true,
    )
  }

  const next = patchElementHtml(source, info, html)
  if (next === null) {
    return say(`The element at ${elementPath} cannot be replaced in place (it has no usable offsets).`, true)
  }
  writeFileSync(path, next, 'utf8')
  return say(`Replaced <${info.tag}> at ${elementPath} of ${basename(path)}.`)
}

/**
 * `edit <file> --expect "<text>" --text "<text>"` — one occurrence, changed.
 *
 * **The editor wins when there is one.** A page somebody has open is the document of record, and asking its editor to
 * make the change is what keeps the edit one step of that history instead of a file that moved under the frame. With
 * nothing showing the file, the same edit is applied to the bytes.
 */
async function editText(args: {
  path: string
  source: string
  tokens: readonly string[]
  applyEdit?: ToolCommandArgs['applyEdit']
}): Promise<BrowserCommandResult> {
  const { path, source, tokens, applyEdit } = args
  const expectedText = valueOf(tokens, '--expect')
  const text = valueOf(tokens, '--text')
  if (expectedText === undefined || text === undefined) {
    return say('edit needs `--expect "<what is there now>" --text "<what it becomes>"`.', true)
  }

  if (applyEdit) {
    const answer = await applyEdit(path, { kind: 'html', expectedText, text })
    if (answer) {
      return answer.ok
        ? say(`Changed the page open in the editor: ${basename(path)}.`)
        : say(answer.message ?? `${basename(path)} refused the edit.`, true)
    }
  }

  const outcome = replaceOnce(source, expectedText, text)
  if ('problem' in outcome) return say(`${basename(path)}: ${outcome.problem}`, true)
  writeFileSync(path, outcome.text, 'utf8')
  return say(`Changed ${basename(path)} on disk${applyEdit ? ' — no editor is showing it' : ''}.`)
}
