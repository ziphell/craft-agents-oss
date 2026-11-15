/**
 * `markdown_tool`'s commands.
 *
 * A `.md` file is written by the agent with `Write`/`Edit`, like every other file of its work. What those cannot do is
 * speak about the file the way the editor does — as **blocks**, the unit a save may rewrite, and as a **body under an
 * envelope** that carries the frontmatter. This is that vocabulary as a command line:
 *
 * ```
 * blocks <file>                 what the file is made of, in order, with the index each command takes
 * frontmatter <file> [--get]    the YAML above the body — read now, editable as the next step
 * ```
 *
 * `blocks` comes first on purpose, for the reason `drawio_tool pages` comes before `--page`: a name that is not
 * listed cannot be asked for, and an index nobody printed is an index the caller guessed. Everything here is read
 * only so far — nothing in this file writes a byte.
 *
 * The offsets behind it live in `@craft-agent/shared/markdown/blocks`, the same module the editor's save path uses,
 * so "block 3" means the same thing to a tool and to the document on screen.
 */

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { blockTexts, layoutMarkdown, spliceBlocks } from '../markdown/blocks.ts'
import { buildFrontmatterRaw, frontmatterInner, parseDocText, serializeDocText } from '../markdown/envelope.ts'
import { replaceOnce } from '../text/replace-once.ts'
import {
  contentRootOf,
  resolveLocalPath,
  tokenizeCommand,
  type BrowserCommandImage,
  type BrowserCommandResult,
  type ToolCommandArgs,
} from './command-cli.ts'

export function markdownHelp(): string {
  return `Read and change a markdown file the way the editor sees it (one command per call).

A \`.md\` file is written with \`Write\`/\`Edit\`, like any other file. What those cannot say is how the file is
**divided**: which top-level blocks it has, and which part of it is frontmatter rather than document.

\`blocks <file>\` lists the top-level blocks in order, numbered from 0, each with its kind and first line. Read it
before naming a block: a number nobody printed is a number that was guessed.

\`set <file> --block <n> --text "<markdown>"\` replaces one block in place; every byte around it is kept. A replacement
that would become two blocks is refused, because it would renumber the rest.

\`edit <file> --expect "<text>" --text "<text>"\` changes one occurrence, and only when it is unambiguous. An open
document takes the change in its own editor (one undo step, caret kept); otherwise the file is edited directly.

\`frontmatter <file>\` prints the YAML above the body — \`--set "<yaml>"\` replaces it, \`--remove\` takes it off.
Frontmatter is never a block.

Paths count from the workspace root.`
}

const say = (output: string, failed = false): BrowserCommandResult => ({
  output: failed ? `Error: ${output}` : output,
  appendReleaseHint: failed,
})

/**
 * A picture of the document as an **outside reader** sees it.
 *
 * The renderer is the app's own (`captureMarkdownPoster`), so tables, code and the fences that hold
 * their own content come out as they would anywhere. What it deliberately does *not* draw are the
 * fences that only mean "open this in Craft" — `markdown-preview`, `html-preview`, `pdf-preview`,
 * `drawio-preview` — because they are not standard markdown and an outside reader gets a code block
 * for each. That is the honest answer to "what am I about to hand over", and it is why this is a
 * picture and not a promise: the app's own reading surface may show more.
 *
 * The height is the caller's because a markdown document has no page: a card takes 450 px from the
 * top, and a model checking its own work may want the whole thing.
 */
async function shotDocument(args: {
  path: string
  tokens: string[]
  captureMarkdownShot?: ToolCommandArgs['captureMarkdownShot']
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

  const pixels = (name: string, fallback: number) => {
    const raw = flags.get(name)
    if (!raw) return fallback
    const value = Number(raw)
    if (!Number.isFinite(value) || value < 50 || value > 4000) return null
    return Math.round(value)
  }
  const width = pixels('width', 800)
  const height = pixels('height', 900)
  if (width === null || height === null) return say('--width and --height are pixels between 50 and 4000.', true)

  if (!args.captureMarkdownShot) {
    return say(
      'This host has no renderer, so it cannot draw the document. `blocks` works anywhere: it reads the file itself.',
      true,
    )
  }

  const out = flags.get('out')
  const outDir = out ? resolveLocalPath(out, process.cwd()) : join(tmpdir(), `craft-md-shot-${process.pid}-${Date.now()}`)
  const scratch = !out
  mkdirSync(outDir, { recursive: true })
  try {
    const files = await args.captureMarkdownShot({ path: args.path, width, height, outDir })
    if (!files.length) return say(`Could not draw ${basename(args.path)}.`, true)
    const images = imagesOf(files)
    const label = `${basename(args.path)} — ${width}×${height}, as the reader draws it`
    const named = [label, ...files].join(String.fromCharCode(10))
    return { output: images.length ? label : named, images, appendReleaseHint: false }
  } catch (error) {
    return say(`${basename(args.path)} could not be drawn: ${error instanceof Error ? error.message : String(error)}`, true)
  } finally {
    if (scratch) rmSync(outDir, { recursive: true, force: true })
  }
}

/** The pictures that ride the reply, and a path for any that could not fit. */
function imagesOf(files: string[]): BrowserCommandImage[] {
  const images: BrowserCommandImage[] = []
  for (const path of files) {
    try {
      const size = statSync(path).size
      if (size > 3_750_000) continue
      images.push({ data: readFileSync(path).toString('base64'), mimeType: 'image/png', sizeBytes: size, path })
    } catch {
      // A picture that vanished is already a path in the text.
    }
  }
  return images
}

/** A block's first line, cut short: enough to recognise it, never enough to be the document. */
function firstLine(text: string, limit = 72): string {
  const line = (text.trim().split('\n')[0] ?? '').trim()
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line
}

/**
 * What kind of block this is, in one word.
 *
 * Read off the text rather than the mdast node, deliberately: the answer has to be the same whether it comes from
 * this tool or from somebody looking at the file, and "the line starts with `##`" is that answer.
 */
function kindOf(text: string): string {
  const first = text.trimStart()
  if (first.startsWith('```') || first.startsWith('~~~')) return 'code'
  if (/^#{1,6}\s/.test(first)) return 'heading'
  if (first.startsWith('>')) return 'quote'
  if (/^([-*+]|\d+[.)])\s/.test(first)) return 'list'
  if (first.startsWith('|')) return 'table'
  if (first.startsWith('---') && first.includes('\n')) return 'frontmatter'
  if (first.startsWith('<')) return 'html'
  return 'paragraph'
}

export async function executeMarkdownToolCommand(args: {
  command: string | string[]
  workspaceRootPath?: string | undefined
  /** The session's own place: bare paths count from the content root it names. */
  sessionId?: string | undefined
  projectId?: string | undefined
  sessionWorkingDirectory?: string | undefined
  /** See `ToolCommandArgs.applyEdit` — `edit` is the one command that reads it. */
  applyEdit?: ToolCommandArgs['applyEdit']
  /** See `ToolCommandArgs.captureMarkdownShot` — `shot` is the one command that reads it. */
  captureMarkdownShot?: ToolCommandArgs['captureMarkdownShot']
}): Promise<BrowserCommandResult> {
  const cwd = contentRootOf(args) ?? args.workspaceRootPath ?? process.cwd()
  const tokens = Array.isArray(args.command)
    ? args.command.flatMap((part) => tokenizeCommand(part))
    : tokenizeCommand(args.command ?? '')

  const command = tokens[0]?.toLowerCase()
  if (!command || command === 'help' || command === '--help' || command === '-h') return say(markdownHelp())

  if (
    command !== 'blocks' &&
    command !== 'frontmatter' &&
    command !== 'set' &&
    command !== 'edit' &&
    command !== 'shot'
  ) {
    return say(
      `Unknown command "${tokens[0]}". Commands: blocks <file>, set <file> --block <n> --text "…", ` +
        'frontmatter <file> [--set "…" | --remove], shot <file> [--width n] [--height n] [--out <dir>].',
      true,
    )
  }

  const file = tokens[1]
  if (!file) return say(`${command} needs a file: \`${command} <file>\`.`, true)
  const path = resolveLocalPath(file, cwd)

  // Before reading the file: a picture is drawn by the renderer, which reads the document itself.
  if (command === 'shot') {
    return shotDocument({ path, tokens, captureMarkdownShot: args.captureMarkdownShot })
  }

  let source: string
  try {
    source = readFileSync(path, 'utf8')
  } catch (error) {
    return say(`Cannot read ${basename(path)}: ${error instanceof Error ? error.message : String(error)}`, true)
  }

  const envelope = parseDocText(source)
  const blocks = blockTexts(layoutMarkdown(envelope.body))

  if (command === 'blocks') {
    if (blocks.length === 0) return say(`${basename(path)} has no blocks: it is empty, or only frontmatter.`)
    const lines = blocks.map((text, index) => `#${index}  ${kindOf(text).padEnd(9)}  ${firstLine(text)}`)
    const note = envelope.frontmatter ? '\n\nIts frontmatter is not a block: `frontmatter <file>` prints it.' : ''
    return say(`${basename(path)} — ${blocks.length} block(s):\n${lines.join('\n')}${note}`)
  }

  if (command === 'set') return setBlock({ path, envelope, blocks, tokens })
  if (command === 'edit') return editSpan({ path, source, tokens, applyEdit: args.applyEdit })

  // `frontmatter`: read it, replace it, or take it off.
  if (tokens.includes('--remove')) {
    if (!envelope.frontmatter) return say(`${basename(path)} has no frontmatter to remove.`)
    writeFileSync(path, serializeDocText({ ...envelope, frontmatter: '' }, envelope.body), 'utf8')
    return say(`Removed the frontmatter from ${basename(path)}.`)
  }
  const yaml = valueOf(tokens, '--set')
  if (yaml !== undefined) {
    const frontmatter = buildFrontmatterRaw(yaml)
    writeFileSync(path, serializeDocText({ ...envelope, frontmatter }, envelope.body), 'utf8')
    return say(
      frontmatter
        ? `Replaced the frontmatter in ${basename(path)}.`
        : `Removed the frontmatter from ${basename(path)}.`,
    )
  }
  if (!envelope.frontmatter) return say(`${basename(path)} has no frontmatter.`)
  return say(`---\n${frontmatterInner(envelope.frontmatter)}\n---`)
}

/**
 * `edit <file> --expect "<text>" --text "<text>"` — one occurrence, changed.
 *
 * **The editor wins when there is one.** A document somebody has open is ahead of its file by whatever they have
 * typed, and an edit written straight to the disk would race them; asking the editor instead makes the change one
 * step of its history, with their caret mapped through it. When nothing is showing the file, the same edit is
 * applied to the bytes and written — which is the ordinary case for a file nobody is looking at.
 *
 * "One occurrence" is checked in both paths, and a miss is refused rather than approximated: `--expect` is the
 * caller's claim about what is there, and an edit that lands somewhere else is worse than one that did not land.
 */
async function editSpan(args: {
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
    const answer = await applyEdit(path, { kind: 'markdown', expectedText, text })
    if (answer) {
      return answer.ok
        ? say(`Changed the open document ${basename(path)}. The change is one step of its history.`)
        : say(answer.message ?? `${basename(path)} refused the edit.`, true)
    }
  }

  const outcome = replaceOnce(source, expectedText, text)
  if ('problem' in outcome) return say(`${basename(path)}: ${outcome.problem}`, true)
  writeFileSync(path, outcome.text, 'utf8')
  return say(`Changed ${basename(path)} on disk${applyEdit ? ' — no editor is showing it' : ''}.`)
}

/** The value after a flag, or `undefined` when the flag is absent. */
function valueOf(tokens: readonly string[], flag: string): string | undefined {
  const at = tokens.indexOf(flag)
  return at >= 0 ? tokens[at + 1] : undefined
}

/**
 * `set <file> --block <n> --text <markdown>` — one block, replaced by the caller's own markdown.
 *
 * The block is swapped **in place**, by offsets, so every byte around it is kept — which is the whole point of having
 * a block model. The replacement is checked before anything is written: it has to parse back as exactly one block,
 * because text that splits in two would silently renumber every block the caller was told about.
 */
function setBlock(args: {
  path: string
  envelope: ReturnType<typeof parseDocText>
  blocks: readonly string[]
  tokens: readonly string[]
}): BrowserCommandResult {
  const { path, envelope, blocks, tokens } = args
  const index = Number(valueOf(tokens, '--block'))
  const text = valueOf(tokens, '--text')
  if (valueOf(tokens, '--block') === undefined || !Number.isInteger(index) || index < 0) {
    return say('set needs a block: `set <file> --block <n> --text "<markdown>"` — the numbers `blocks` printed.', true)
  }
  if (text === undefined) return say('set needs `--text "<markdown>"`.', true)
  if (index >= blocks.length) {
    return say(`There is no block #${index}: ${basename(path)} has ${blocks.length} block(s).`, true)
  }

  const nextBody = spliceBlocks(layoutMarkdown(envelope.body), new Map([[index, text.trimEnd()]]))
  const after = blockTexts(layoutMarkdown(nextBody))
  if (after.length !== blocks.length) {
    return say(
      `That replacement would make ${basename(path)} go from ${blocks.length} block(s) to ${after.length}. ` +
        'A `--text` that is one block, not several: keep blank lines out of it.',
      true,
    )
  }

  writeFileSync(path, serializeDocText(envelope, nextBody), 'utf8')
  return say(`Replaced block #${index} of ${basename(path)}; ${blocks.length} block(s), as before.`)
}
