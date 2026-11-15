/**
 * `office_tool`'s commands: create, read, apply, convert, merge, compare, pdf, render, check,
 * guide — plus the four staged steps a designed deck is built with (deck_start, deck_page,
 * deck_build, deck_replace).
 *
 * A document is a **file**, and this tool is the door that makes one and changes one without a
 * window. Everything it does runs on the GenOffice command line (`genoffice`), which is the same
 * engine the editor uses — so a file this tool writes opens in the app's editor and in Word, and a
 * file the editor saved can be changed here. Nothing about the work needs a browser, which is why
 * it is a command line rather than a door onto a pane: `drawio_tool` needs drawio's webapp to draw;
 * a `.docx` only needs its own bytes.
 *
 * **Files are written by this tool, not by the agent.** OOXML is a zip of XML parts whose
 * relationships and content types must agree; hand-editing it through `Write` produces files that
 * open in one program and not the next, and that is a failure which shows up days later. The
 * commands below are the whole surface: a document is created from Markdown or HTML, changed
 * through structured ops, read back as blocks, filled from a template, compared as a redline, and
 * its PDF text read.
 *
 * **A flag this tool does not know is an error, never a silent drop.** The engine's options are
 * richer than what is forwarded here, and a caller who writes `--sheet Data` on a command that
 * ignores it would otherwise get the active sheet and never learn. Each command therefore declares
 * what it accepts, and the difference is reported by name.
 *
 * `export` is deliberately absent. Printing a document is the app's own renderer (a hidden window
 * printing the editor at the sheet's size); the app offers that as an action, and an agent that
 * needs a PDF asks for it there rather than duplicating the path here.
 */

import { spawn } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import {
  contentRootOf,
  tokenizeCommand,
  resolveLocalPath,
  type BrowserCommandImage,
  type BrowserCommandResult,
} from './command-cli.ts'
import { PDF_VERBS, pageNeedsOcr, pdfHelp, pdfPageStats, runPdfCommand } from './office-pdf-commands.ts'
import {
  officeDomainForCommand,
  officeDomainOf,
  type OfficeDomain,
} from '@craft-agent/session-tools-core'
import { workbookFromDocument } from '../office/sheets-from-document.ts'
import { isDocumentDirty } from '../office/open-documents.ts'
import { runCliTool, type CliRun } from '../utils/cli-tool.ts'
import type { ToolCommandArgs } from './command-cli.ts'

/** The document types this tool creates. Each one is a real Office file, not a copy. */
const CREATE_TYPES = ['docx', 'xlsx', 'pptx'] as const
type CreateType = (typeof CREATE_TYPES)[number]

/** What `convert --to` accepts. The engine's own list, kept short on purpose. */
const CONVERT_TARGETS = ['pdf', 'docx', 'xlsx', 'pptx', 'md', 'html', 'csv'] as const

/**
 * Which engine domain owns a file.
 *
 * The extension decides two things: which verb `read` runs (`docs read` / `sheet read` /
 * `slides read` — each answers the ids the matching `apply` addresses) and which `apply` takes.
 * A file this table does not know is refused by name instead of being sent to `docs`, which was
 * the silent default for every format nobody had thought about (`.ods`, `.xlsb`, `.ppt` …).
 */
type Domain = 'docs' | 'sheet' | 'slides'

const DOMAIN_EXTENSIONS: ReadonlyArray<readonly [Domain, readonly string[]]> = [
  ['docs', ['docx', 'doc', 'odt', 'ott']],
  ['sheet', ['xlsx', 'xlsm', 'xlsb', 'xls', 'ods', 'ots']],
  ['slides', ['pptx', 'ppt', 'odp', 'otp']],
]

/** What `info` answers for — plain text and data files, which have no blocks or cells to index. */
const INFO_EXTENSIONS = ['md', 'markdown', 'html', 'htm', 'txt', 'csv', 'tsv']

function extensionOf(file: string): string {
  // Not `extname`: this also has to read a Windows path on a machine that is not Windows.
  const match = /\.([A-Za-z0-9]+)$/.exec(file)
  return match ? match[1]!.toLowerCase() : ''
}

function domainOf(file: string): Domain | null {
  const ext = extensionOf(file)
  return DOMAIN_EXTENSIONS.find(([, extensions]) => extensions.includes(ext))?.[0] ?? null
}

function domainHint(): string {
  return DOMAIN_EXTENSIONS.map(([domain, extensions]) => `${domain} (${extensions.join(' / ')})`).join(', ')
}

/**
 * Where the `genoffice` command line lives.
 *
 * Three answers, in the order that makes the first one a decision and the rest a fallback:
 *
 * 1. `GENOFFICE_CLI` — an operator pointing at a build (a hub image, a CI run).
 * 2. The app's own bundle (`resources/cli/genoffice.cjs`, copied in by
 *    `scripts/build-office-assets.ts`), run on the runtime that is already here — the same way
 *    GenOffice itself ships it, with `ELECTRON_RUN_AS_NODE`.
 * 3. A checkout found by walking up from the working directory — a test or a tool run from
 *    `packages/shared` must find the same bundle a run from the repository root does.
 *
 * Null when none of them is there, and the tool says so by name rather than failing on a spawn.
 */
function walkingUp(start: string, relative: string): string[] {
  const paths: string[] = []
  let current = resolve(start)
  for (;;) {
    paths.push(join(current, relative))
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return paths
}

export function resolveGenofficeCli(): string | null {
  const configured = process.env.GENOFFICE_CLI
  if (configured && existsSync(configured)) return configured

  const resourcesBase = process.env.CRAFT_RESOURCES_BASE
  const appRoot = process.env.CRAFT_APP_ROOT
  const candidates = [
    // packaged: <resources>/cli/genoffice.cjs (see scripts/build-office-assets.ts)
    typeof process.resourcesPath === 'string' ? join(process.resourcesPath, 'cli', 'genoffice.cjs') : null,
    // the host's own answer in both shapes — `resourcesBase/resources` in a packaged build and in a
    // dev run alike, set by main (`CRAFT_RESOURCES_BASE`). Not `cwd`: the agent runs in the
    // session's folder, which is somebody's documents rather than the app's resources.
    resourcesBase ? join(resourcesBase, 'resources', 'cli', 'genoffice.cjs') : null,
    appRoot ? join(appRoot, 'apps', 'electron', 'resources', 'cli', 'genoffice.cjs') : null,
    // The bundle in this repository, found from wherever the caller happens to sit. A test run
    // from `packages/shared` and one from the root both mean "this checkout's resources".
    ...walkingUp(process.cwd(), join('apps', 'electron', 'resources', 'cli', 'genoffice.cjs')),
    // A sibling GenOffice checkout, which is what a development machine has.
    ...walkingUp(process.cwd(), join('..', 'genoffice', 'packages', 'cli', 'dist', 'genoffice.cjs')),
  ].filter((path): path is string => !!path)

  return [...new Set(candidates)].find((path) => existsSync(path)) ?? null
}

const say = (output: string): BrowserCommandResult => ({ output, appendReleaseHint: false })

/**
 * The resources root the command line sits in — `<…>/cli/genoffice.cjs` ⇒ `<…>`.
 *
 * The anchor is the **CLI's own path**, not this process's working directory: the agent runs in the
 * session's folder, so a `cwd`-based guess points at somebody's documents and never at the app's
 * resources. Null when the CLI was not found under a `cli/` folder (an operator's `GENOFFICE_CLI`
 * may be anywhere), in which case the other candidates still apply.
 */
function resourcesRootOf(cliPath: string): string | null {
  const cliDir = dirname(cliPath)
  return basename(cliDir) === 'cli' ? dirname(cliDir) : null
}

/** Every place one of the engines may live, nearest first. */
function engineCandidates(cliPath: string, relative: string): string[] {
  const root = resourcesRootOf(cliPath)
  return [
    typeof process.resourcesPath === 'string' ? join(process.resourcesPath, relative) : null,
    root ? join(root, relative) : null,
    join(process.cwd(), 'apps', 'electron', 'resources', relative),
  ].filter((path): path is string => !!path)
}

/**
 * Where the pdfium wasm the command line needs for PDF work lives.
 *
 * It ships beside the office engine bundle (the pdf host uses the same copy), because the CLI's
 * own lookup only knows a packaged GenOffice layout — without this, every pdf command fails
 * with "pdfium.wasm not found" even though the file is right there.
 */
function pdfiumWasmPath(cliPath: string): string | null {
  const configured = process.env.GENOFFICE_PDFIUM_WASM
  if (configured && existsSync(configured)) return configured
  const relative = join('office-engine', 'node_modules', '@embedpdf', 'pdfium', 'dist', 'pdfium.wasm')
  return engineCandidates(cliPath, relative).find((path) => existsSync(path)) ?? null
}

/**
 * Where the `.xlsx` engine (a Rust sidecar) lives.
 *
 * Same shape as `pdfiumWasmPath`, and for the same reason: the CLI resolves both from a packaged
 * GenOffice layout. This one used to have only a development path built from `cwd`, so a released
 * build answered "xlsx engine (xlsx-sidecar) not found" while the binary sat in the app's own
 * resources — and in development the agent's `cwd` is the session folder, so it did not work there
 * either without an environment variable.
 */
function xlsxSidecarPath(cliPath: string): string | null {
  const configured = process.env.XLSX_SIDECAR_PATH
  if (configured && existsSync(configured)) return configured
  const binary = process.platform === 'win32' ? 'xlsx-sidecar.exe' : 'xlsx-sidecar'
  const candidates = [
    ...engineCandidates(cliPath, join('office-native', binary)),
    join(process.cwd(), '..', 'genoffice', 'apps', 'shell', 'build', 'native', binary),
  ]
  return candidates.find((path) => existsSync(path)) ?? null
}

/** Environment for the child: the CLI is a CommonJS bundle that runs on Electron's own node. */
function cliEnv(cliPath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
  const wasm = pdfiumWasmPath(cliPath)
  if (wasm) env.GENOFFICE_PDFIUM_WASM = wasm
  const sidecar = xlsxSidecarPath(cliPath)
  if (sidecar) env.XLSX_SIDECAR_PATH = sidecar
  // The conversions the command line cannot do by itself need a renderer, and this app is one: it
  // answers the same headless-export contract GenOffice's own app does (see
  // apps/electron/src/main/headless-export.ts). Only a **packaged** build is a command with an app
  // of its own — in development `process.execPath` is a bare Electron, which would start with no
  // app path at all, so there the CLI keeps looking for its own app.
  if (process.versions.electron && !process.defaultApp && !env.GENOFFICE_APP_BIN) env.GENOFFICE_APP_BIN = process.execPath
  return env
}

/** Run one CLI command: its summary on success, its refusal in the engine's own words. */
function runCli(cliPath: string, args: string[], cwd: string): Promise<{ ok: boolean; result: BrowserCommandResult }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], { cwd, env: cliEnv(cliPath) })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => (stdout += String(chunk)))
    child.stderr?.on('data', (chunk) => (stderr += String(chunk)))
    child.on('error', (error) => resolve({ ok: false, result: say(`The document engine could not start: ${error.message}`) }))
    child.on('close', (code) => {
      // 0 ok, 1 usage, 2 file, 3 conversion failed, 4 app not available. A non-zero answer carries
      // its reason on stderr in the engine's own words, which are what the agent can act on.
      if (code === 0) return resolve({ ok: true, result: say(stdout.trim() || 'ok') })
      resolve({ ok: false, result: say(`The document engine declined (exit ${code}).\n${(stderr || stdout).trim()}`) })
    })
  })
}

/** The name a page image is built from: the document's, without its extension. */
function stemOf(file: string): string {
  const name = file.split(/[\\/]/).pop() ?? 'document'
  return name.replace(/\.[^.]+$/, '')
}

/** The pictures a command wrote into `dir`, in page order. */
function pagesIn(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.toLowerCase().endsWith('.png'))
      .sort()
      .map((name) => join(dir, name))
  } catch {
    return []
  }
}

/**
 * Can this process answer the engine's renderer contract?
 *
 * A packaged build can: `cliEnv` points `GENOFFICE_APP_BIN` at this very executable, and `main`
 * answers `--headless-export` (`headless-export.ts`). An operator can point it at a real GenOffice.
 * A development run cannot — `process.execPath` there is a bare Electron with no app path — and
 * that is the case worth answering **before** the engine waits out its export timeout.
 */
function canPrintHere(): boolean {
  if (process.env.GENOFFICE_APP_BIN) return true
  return Boolean(process.versions.electron) && !(process as { defaultApp?: boolean }).defaultApp
}

/**
 * How many page images come back inside one answer.
 *
 * A deck can be sixty pages. The reply carries the first few so a model can look at the opening
 * pages (the ones that decide whether the deck reads right), and every path is named in the text,
 * so the rest are one `Read` away. The cap is the same reasoning as a screenshot budget: an answer
 * that is mostly base64 is an answer nobody can act on.
 */
const MAX_RENDER_IMAGES = 8

/**
 * A document too large to open for a picture is not worth a picture.
 *
 * The capture path reads the whole file into memory to hand it to the editor (a poster caps at the
 * same number for the same reason), so this is the line where "look at this page" stops being a
 * reasonable request. Over it, the command says so rather than opening a 500 MB file.
 */
const MAX_CAPTURE_BYTES = 48 * 1024 * 1024

/** Refuse a picture of a file too large to open for one — see `MAX_CAPTURE_BYTES`. */
function refuseTooBig(file: string, cwd: string): { kind: 'say'; output: string } | null {
  try {
    const bytes = statSync(resolveLocalPath(file, cwd)).size
    if (bytes <= MAX_CAPTURE_BYTES) return null
    return {
      kind: 'say',
      output:
        `${basename(file)} is ${Math.round(bytes / (1024 * 1024))} MB — too large to draw a page of it. ` +
        '`read` answers its structure, `check` what is wrong with it, and `convert` still writes every text format.',
    }
  } catch {
    // A file that is not there is the engine's refusal to make, in its own words.
    return null
  }
}

/** 5 MB is the API's hard limit for an image once encoded; base64 inflates by 4/3. */
const MAX_RENDER_IMAGE_BYTES = 3_750_000

/** The rendered pages, ready to ride the reply. Too large a page stays a path in the text. */
function pageImages(pages: string[]): BrowserCommandImage[] {
  const images: BrowserCommandImage[] = []
  for (const path of pages) {
    if (images.length >= MAX_RENDER_IMAGES) break
    try {
      const stats = statSync(path)
      if (stats.size > MAX_RENDER_IMAGE_BYTES) continue
      images.push({ data: readFileSync(path).toString('base64'), mimeType: 'image/png', sizeBytes: stats.size, path })
    } catch {
      // A page that vanished is already a path in the text; it is not a reason to fail the command.
    }
  }
  return images
}

/**
 * The engine's "no app" refusal, in this tool's own words.
 *
 * The engine's hint names GenOffice and tells the caller to install it — advice that is wrong here
 * in the one case that produces it, and a product the person reading the reply never chose. What
 * the caller needs to know is which step failed and that the file is untouched; what it must not be
 * told is where a renderer lives.
 */
function withoutPrinter(text: string): string {
  if (!/GenOffice app not found/.test(text)) return text
  return [
    'That needs a renderer to lay the page out, and this host has none.',
    'The document itself was not touched: `read` still answers what it holds, and everything that',
    'does not need printing — editing, converting to another text format, checking — still works.',
  ].join('\n')
}

// ── the staged deck flow ────────────────────────────────────────────────────────────────────────

/** Where one outline entry's page spec lives: `pages/01.json`, numbered from 1, two digits. */
export function deckPageFile(dir: string, index: number): string {
  return join(dir, 'pages', `${String(index + 1).padStart(2, '0')}.json`)
}

/** The titles the outline plans, in order — the outline is what "how many pages" means. */
export function deckOutlineTitles(outline: unknown): string[] {
  const pages = (outline as { pages?: unknown } | null)?.pages
  if (!Array.isArray(pages)) return []
  return pages.map((page) => (typeof (page as { title?: unknown })?.title === 'string' ? (page as { title: string }).title : ''))
}

/** Outline entries that have no page file yet. */
export function deckMissingPages(dir: string, count: number): number[] {
  const present = new Set(
    existsSync(join(dir, 'pages')) ? readdirSync(join(dir, 'pages')).filter((name) => name.endsWith('.json')) : [],
  )
  const missing: number[] = []
  for (let index = 0; index < count; index += 1) {
    if (!present.has(`${String(index + 1).padStart(2, '0')}.json`)) missing.push(index)
  }
  return missing
}

const lines = (...parts: string[]): string => parts.filter(Boolean).join('\n')

/**
 * Run one stage of the staged deck flow.
 *
 * The shape is GenOffice's own (`packages/cli/src/mcp/deck.ts`), because the folder layout is the
 * contract `slides check` and `create --spec` already read: this is the same flow, reachable from
 * the command line an agent has instead of from an MCP server it would have to install.
 */
async function runDeck(request: DeckRequest, cliPath: string, cwd: string): Promise<BrowserCommandResult> {
  const { dir } = request
  const outlinePath = join(dir, 'outline.json')

  const outline = (): { titles: string[] } | string => {
    if (!existsSync(outlinePath)) {
      return 'No outline in that folder — run `deck_start <dir> --style … --outline …` first.'
    }
    try {
      return { titles: deckOutlineTitles(JSON.parse(readFileSync(outlinePath, 'utf-8'))) }
    } catch (error) {
      return `The outline at ${outlinePath} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  switch (request.command) {
    case 'deck_start': {
      // The two files are read for their content and written as they are: the outline and the style
      // sheet are the agent's own work, and re-serializing them would be this tool rewriting prose.
      for (const source of [request.style!, request.outline!]) {
        if (!existsSync(source)) return say(`No such file: ${source}`)
      }
      let titles: string[]
      try {
        titles = deckOutlineTitles(JSON.parse(readFileSync(request.outline!, 'utf-8')))
      } catch (error) {
        return say(`The outline is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
      }
      mkdirSync(join(dir, 'pages'), { recursive: true })
      if (resolve(request.style!) !== resolve(join(dir, 'style.md'))) copyFileSync(request.style!, join(dir, 'style.md'))
      if (resolve(request.outline!) !== resolve(outlinePath)) copyFileSync(request.outline!, outlinePath)

      const checked = await runCli(cliPath, ['slides', 'check', outlinePath], cwd)
      if (!checked.ok) {
        return say(lines(checked.result.output, '', `The outline is on disk at ${outlinePath} — fix it and run deck_start again.`))
      }
      const out = checked.result.output.split('\n').slice(0, 2).join('\n')
      return say(
        lines(
          `deck started in ${dir}`,
          out,
          '',
          `${titles.length} page(s) planned:`,
          ...titles.map((title, index) => `  ${index}. ${title || '(untitled)'} → pages/${String(index + 1).padStart(2, '0')}.json`),
          '',
          titles.length
            ? `next: write page 0 ("${titles[0]}") and run \`deck_page ${dir} --index 0 --page <page.json>\``
            : 'next: the outline plans no pages',
        ),
      )
    }

    case 'deck_page':
    case 'deck_replace': {
      const known = outline()
      if (typeof known === 'string') return say(known)
      const index = request.index!
      if (index >= known.titles.length) {
        return say(`The outline has ${known.titles.length} page(s); index ${index} has no entry (0–${known.titles.length - 1}).`)
      }
      if (!existsSync(request.page!)) return say(`No such page file: ${request.page}`)

      // Pages are written in outline order: a page whose predecessors are missing is a deck whose
      // numbering nobody can trust, so this is refused rather than quietly accepted.
      const missing = deckMissingPages(dir, known.titles.length)
      const nextMissing = missing[0]
      if (nextMissing !== undefined && index > nextMissing) {
        return say(
          `page ${index} comes after missing page ${nextMissing}; pages are written in outline order. Write page ${nextMissing} ("${known.titles[nextMissing]}") first.`,
        )
      }

      // Checked from a `.pending` file beside the real one, so `slides check` still finds the
      // outline and the style sheet, and a page that fails never replaces the file already there.
      const file = deckPageFile(dir, index)
      const pending = `${file}.pending`
      mkdirSync(join(dir, 'pages'), { recursive: true })
      copyFileSync(request.page!, pending)
      const checked = await runCli(cliPath, ['slides', 'check', pending, '--page', String(index)], cwd)
      if (!checked.ok) {
        rmSync(pending, { force: true })
        return say(lines(checked.result.output, '', 'The page was not kept. Fix it and run the same command again.'))
      }
      renameSync(pending, file)

      const stillMissing = deckMissingPages(dir, known.titles.length)
      const done = request.command === 'deck_replace'
        ? null
        : stillMissing.length
          ? `next: page ${stillMissing[0]} ("${known.titles[stillMissing[0]!]}")`
          : `next: every page has a file — \`deck_build ${dir}\``

      // The check ran on the `.pending` copy, and its summary names that file — a name nobody
      // should see in an answer about a page that was kept.
      const report = checked.result.output.split(basename(pending)).join(basename(file))

      if (request.command === 'deck_page') {
        return say(lines(`page ${index} checked and kept: ${file}`, report.split('\n').slice(0, 6).join('\n'), '', done ?? ''))
      }

      const pptx = request.pptx ?? join(dir, 'deck.pptx')
      if (!existsSync(pptx)) return say(`No built deck at ${pptx} — run \`deck_build ${dir}\` first.`)
      const replaced = await runCli(cliPath, ['slides', 'replace', pptx, '--slide', String(index), '--spec', file], cwd)
      return say(lines(`slide ${index} rebuilt from ${file}`, replaced.result.output, '', `next: \`render ${basename(pptx)} --page ${index + 1}\` to look at it`))
    }

    case 'deck_build': {
      const known = outline()
      if (typeof known === 'string') return say(known)
      const missing = deckMissingPages(dir, known.titles.length)
      if (missing.length) {
        return say(
          `${missing.length === 1 ? 'page' : 'pages'} ${missing.join(', ')} ${missing.length === 1 ? 'has' : 'have'} no file yet: ${missing.map((index) => `"${known.titles[index]}"`).join(', ')}. Write ${missing.length === 1 ? 'it' : 'them'} with deck_page before building.`,
        )
      }
      const out = request.out ?? join(dir, 'deck.pptx')
      const built = await runCli(
        cliPath,
        ['create', '--type', 'pptx', '--spec', join(dir, 'pages'), '--outline', outlinePath, '--out', out, ...(request.out ? [] : ['--force'])],
        cwd,
      )
      return say(
        lines(
          built.result.output,
          '',
          built.ok
            ? `next: \`render ${basename(out)}\` to look at every page, \`check ${basename(out)}\` for overflow`
            : '',
        ),
      )
    }
  }
}

// ── reading a command ───────────────────────────────────────────────────────────────────────────

type Flags = Map<string, string | true>

/** One command as it would be run: the engine's argv, and the directory it runs in. */
export interface OfficeInvocation {
  argv: string[]
  cwd: string
}

/**
 * What a `office_tool` command means.
 *
 * Split from running it so the reading of a command — which verb, which file, which flag — is
 * testable without an engine.
 */
/**
 * The staged deck flow, as this tool runs it.
 *
 * The deck folder **is** the state: `style.md`, `outline.json` and `pages/NN.json` are exactly what
 * `slides check` and `create --spec <dir>` read, so a deck started here can be finished on the
 * command line and one built on the command line can be edited here. Each step refuses to run
 * before the step it depends on exists, and a page that fails its check never replaces the file.
 */
export type DeckCommand = 'deck_start' | 'deck_page' | 'deck_build' | 'deck_replace'

export interface DeckRequest {
  command: DeckCommand
  /** The deck folder; everything this flow writes lives under it. */
  dir: string
  /** Which outline entry, 0-based. */
  index?: number
  style?: string
  outline?: string
  page?: string
  /** The deck to rebuild a slide of (`deck_replace`), or to write (`deck_build --out`). */
  pptx?: string
  /** `deck_build --out`: where the deck goes (default `<dir>/deck.pptx`). */
  out?: string
}

export type OfficePlan =
  | {
      kind: 'deck'
      request: DeckRequest
    }
  | {
      /** A `pdf` verb performed in-process: the page-and-mark operations. */
      kind: 'pdf'
      argv: string[]
      cwd: string
    }
  | {
      kind: 'run'
      invocation: OfficeInvocation
      /**
       * A directory the command fills with pictures. The answer to `render` is files, not text, so
       * the tool names them — a path it can `Read` is how an agent looks at what it made.
       */
      list?: string
      /**
       * `list` is a scratch directory this run created, not somewhere the caller asked for: the
       * images are read out of it and it is removed before the answer is returned. Looking at a
       * page must not leave a folder behind — which is what `render` used to do, writing
       * `report-pages/` beside the document for anyone who merely wanted to see it.
       */
      ephemeral?: boolean
      /**
       * Set when the engine must start an app renderer for this command (anything → PDF), named as
       * the caller would say it. Answered by this app in a packaged build; a bare development run
       * has no app to start, and saying so beats the engine's three-minute timeout.
       */
      needsApp?: string
      /**
       * Draw this page in the document's own editor instead of printing the whole file.
       *
       * `render` used to be a print: the engine laid the document out as a PDF and rasterised page
       * one of it — four seconds for a seven-page report, and a page number in the corner that
       * belongs to print, not to the document. A host that can open an editor answers this
       * (see `officePageCapture()`), which is the same route a poster takes.
       */
      capture?: { path: string; page: number; target?: { sheet?: string; range?: string } }
      /**
       * Only the picture will do: there is no print to fall back to.
       *
       * A workbook has no pages, so `shot` is either a picture of the grid or a refusal. Falling
       * through to the engine's `render` would print a page nobody asked for — the one thing this
       * command exists instead of.
       */
      captureOnly?: boolean
    }
  /** The command is not one this tool runs; `output` is what the caller is told. */
  | { kind: 'say'; output: string }

/** `--flag value` and bare `--flag`, read off a tokenized command, in the caller's order. */
function optionsOf(parts: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = []
  const flags: Flags = new Map()
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!
    if (!part.startsWith('--')) {
      positional.push(part)
      continue
    }
    const next = parts[i + 1]
    if (next && !next.startsWith('--')) {
      flags.set(part.slice(2), next)
      i += 1
    } else {
      flags.set(part.slice(2), true)
    }
  }
  return { positional, flags }
}

function flagString(flags: Flags, name: string): string | undefined {
  const value = flags.get(name)
  return typeof value === 'string' ? value : undefined
}

/** Flags whose value is a path, resolved against the session before the engine sees it. */
const PATH_FLAGS = new Set(['out', 'ops', 'spec', 'outline', 'data', 'render'])

/** Which flags each command reads. Anything outside the list is refused by name. */
const FLAGS = {
  create: ['json', 'type', 'from', 'out', 'force', 'ops', 'spec', 'outline', 'render', 'audit', 'header', 'decimal'],
  /** `read` forwards these by domain: the same names the engine's own readers use. */
  read: {
    docs: ['json', 'range', 'full', 'max-chars', 'html', 'comments', 'revisions', 'styles', 'header-footer', 'sections', 'fields', 'notes', 'properties'],
    sheet: ['json', 'sheet', 'range', 'cols', 'max-rows', 'where', 'stats', 'formats'],
    slides: ['json', 'slide', 'full', 'layouts', 'max-chars', 'units'],
    pdf: ['json', 'page', 'range', 'password', 'full', 'max-chars'],
    info: ['json', 'password'],
  },
  apply: ['json', 'ops', 'dry-run', 'track', 'author', 'out', 'force', 'best-effort', 'stop-on-error', 'isolation'],
  convert: ['json', 'to', 'out', 'sheet', 'password', 'force'],
  merge: ['json', 'data', 'out', 'force', 'strict'],
  compare: ['json', 'out', 'force', 'granularity', 'ignore', 'author', 'date'],
  pdf: ['json', 'page', 'range', 'password', 'full', 'max-chars'],
  render: ['json', 'out', 'page', 'scale', 'el', 'pad', 'grid', 'cols', 'tile'],
  shot: ['json', 'out', 'sheet', 'range'],
  deckStart: ['json', 'dir', 'style', 'outline'],
  deckPage: ['json', 'index', 'page'],
  deckBuild: ['json', 'out', 'force'],
  deckReplace: ['json', 'index', 'page', 'pptx'],
  check: {
    docs: ['json'],
    sheet: ['json'],
    slides: ['json', 'slide'],
  },
  guide: [],
} as const

/**
 * The argv for the flags a command accepts, in the caller's order.
 *
 * `handled` names the flags the caller has already placed by hand (`--type docx`, `--data …`);
 * they are accepted and not repeated.
 */
function forward(flags: Flags, accepted: readonly string[], handled: readonly string[], cwd: string): string[] {
  const argv: string[] = []
  for (const [name, value] of flags) {
    if (handled.includes(name)) continue
    if (!accepted.includes(name)) continue
    if (value === true) {
      argv.push(`--${name}`)
      continue
    }
    argv.push(`--${name}`, PATH_FLAGS.has(name) ? resolveLocalPath(value, cwd) : value)
  }
  return argv
}

/** The flags a command was given but does not read — the whole reason `forward` is not silent. */
function unread(flags: Flags, accepted: readonly string[]): string[] {
  return [...flags.keys()].filter((name) => !accepted.includes(name)).map((name) => `--${name}`)
}

/**
 * Read a command into what would be run.
 *
 * `cwd` is the session's directory: every path the caller writes is relative to it, and every path
 * the engine is handed is absolute, because the engine runs in a directory of its own.
 */
export function planOfficeCommand(command: string | string[], cwd: string): OfficePlan {
  const raw = Array.isArray(command) ? command : tokenizeCommand((command ?? '').trim())
  // `deck-start` and `deck_start` are the same command; the rest are single words.
  const cmd = raw[0]?.toLowerCase().replace(/-/g, '_')
  const { positional, flags } = optionsOf(raw.slice(1))
  const at = (index: number): string | undefined => {
    const value = positional[index]
    return value ? resolveLocalPath(value, cwd) : undefined
  }
  const run = (argv: string[]): OfficePlan => ({ kind: 'run', invocation: { argv, cwd } })
  const refuse = (output: string): OfficePlan => ({ kind: 'say', output })
  /** Refuse, naming the flags this command does not read. */
  const refuseUnread = (accepted: readonly string[]): OfficePlan | null => {
    const extra = unread(flags, accepted)
    return extra.length ? refuse(`${cmd} does not take ${extra.join(', ')}.`) : null
  }

  switch (cmd) {
    case 'create': {
      const type = (flagString(flags, 'type') ?? 'docx').toLowerCase() as CreateType
      if (!CREATE_TYPES.includes(type)) return refuse(`--type takes ${CREATE_TYPES.join(' / ')}.`)
      const out = flagString(flags, 'out')
      if (!out) return refuse('create needs `--out <file>`.')
      const bad = refuseUnread(FLAGS.create)
      if (bad) return bad
      const rest = forward(flags, FLAGS.create, ['type', 'from', 'out', 'ops', 'spec'], cwd)
      const tail = [...rest, ...(out ? ['--out', resolveLocalPath(out, cwd)] : [])]

      // A deck is built from ops or a spec, never from a Markdown file: GenOffice's deck model is
      // shapes and text at px coordinates, and the conversion from prose is a design decision the
      // engine will not make. Saying so is the whole of the help for `--type pptx`.
      if (type === 'pptx') {
        const ops = flagString(flags, 'ops')
        const spec = flagString(flags, 'spec')
        if (!ops && !spec) {
          return refuse(
            [
              'A .pptx is built from `--ops <ops.json>` (a JSON array of slide ops) or `--spec <spec.json|dir>`.',
              '`office_tool guide slides` prints the ops; `office_tool guide slides spec` the deck spec format.',
            ].join('\n'),
          )
        }
        // A source file is not an input to a deck: saying nothing would leave the caller believing
        // its outline had been read.
        const prose = at(0) ?? flagString(flags, 'from')
        if (prose) {
          return refuse(
            `A .pptx takes --ops or --spec, not a source file (${prose}). ` +
              '`office_tool guide slides spec` is the page format; `guide slides` the ops.',
          )
        }
        return run([
          'create',
          '--type',
          'pptx',
          ...(ops ? ['--ops', resolveLocalPath(ops, cwd)] : []),
          ...(spec ? ['--spec', resolveLocalPath(spec, cwd)] : []),
          ...tail,
        ])
      }

      const from = at(0) ?? (flagString(flags, 'from') ? resolveLocalPath(flagString(flags, 'from')!, cwd) : undefined)
      if (!from) {
        return refuse(
          type === 'xlsx'
            ? 'create --type xlsx needs a `.csv` or `.json` source (`--out <file.xlsx>`); a Markdown table is not read.'
            : 'create needs a `.md` or `.html` source, and `--out <file>`.',
        )
      }
      if (type === 'xlsx' && !['csv', 'json'].includes(extensionOf(from))) {
        return refuse(
          `create --type xlsx reads a .csv or a .json, not a .${extensionOf(from)}. ` +
            'A Markdown table becomes a workbook by being written as CSV first.',
        )
      }
      return run(['create', '--type', type, '--from', from, ...tail])
    }

    case 'read': {
      const file = at(0)
      if (!file) return refuse('read needs a file.')
      const domain = domainOf(file)
      const narrow = domain ?? (extensionOf(file) === 'pdf' ? 'pdf' : INFO_EXTENSIONS.includes(extensionOf(file)) ? 'info' : null)
      if (!narrow) {
        return refuse(`${file} is not a document this tool reads (${domainHint()}, pdf, ${INFO_EXTENSIONS.join(' / ')}).`)
      }
      const accepted = FLAGS.read[narrow]
      const bad = refuseUnread(accepted)
      if (bad) return bad
      const verb = narrow === 'info' ? ['info', file] : narrow === 'pdf' ? ['pdf', 'read', file] : [narrow, 'read', file]
      return run([...verb, ...forward(flags, accepted, [], cwd)])
    }

    case 'apply': {
      const file = at(0)
      if (!file) return refuse('apply needs a file.')
      const domain = domainOf(file)
      if (!domain) return refuse(`apply needs a document (${domainHint()}); a .${extensionOf(file)} is not one.`)
      const ops = flagString(flags, 'ops')
      if (!ops) {
        return refuse(`apply needs \`--ops <ops.json>\` — \`office_tool guide ${domain === 'sheet' ? 'sheets' : domain}\` prints the op list.`)
      }
      const bad = refuseUnread(FLAGS.apply)
      if (bad) return bad
      return run([domain, 'apply', file, ...forward(flags, FLAGS.apply, [], cwd)])
    }

    case 'convert': {
      const file = at(0)
      if (!file) return refuse('convert needs a file.')
      const to = flagString(flags, 'to')
      if (!to) return refuse(`convert needs \`--to\` (${CONVERT_TARGETS.join(' / ')}).`)
      if (!CONVERT_TARGETS.includes(to as (typeof CONVERT_TARGETS)[number])) {
        return refuse(`--to takes ${CONVERT_TARGETS.join(' / ')}.`)
      }
      const bad = refuseUnread(FLAGS.convert)
      if (bad) return bad
      const invocation = run(['convert', file, ...forward(flags, FLAGS.convert, [], cwd)])
      // `to pdf` is the one conversion the engine cannot do on its own: it prints through a renderer.
      return invocation.kind === 'run' && to === 'pdf' ? { ...invocation, needsApp: 'PDF output' } : invocation
    }

    case 'merge': {
      const template = at(0)
      if (!template) return refuse('merge needs a template (.docx, .pptx or .xlsx).')
      const data = flagString(flags, 'data')
      if (!data) return refuse('merge needs `--data <json>`: an object of values, inline or as a file path.')
      if (!flagString(flags, 'out')) return refuse('merge needs `--out <file>` for the filled document.')
      const bad = refuseUnread(FLAGS.merge)
      if (bad) return bad
      // `--data` is values, and values are JSON: an object stays inline, anything else is a path
      // (`-` means stdin, which the engine reads itself).
      const inline = /^\s*[{[]/.test(data)
      if (inline) {
        try {
          JSON.parse(data)
        } catch {
          // A command given as a **string** is tokenized like a shell line, so the quotes inside
          // `{"a":1}` are consumed as quoting and what arrives is `{a:1}`. The two ways that work
          // are named here, because the engine's own "not valid JSON" would not explain why.
          return refuse(
            [
              'The inline `--data` is not valid JSON once the command has been read.',
              'A command written as a string is tokenized like a shell line, so the quotes inside a JSON object are consumed.',
              'Either write the values to a file and pass `--data values.json`, or send this command as an array of arguments.',
            ].join('\n'),
          )
        }
      }
      const values = inline || data === '-' ? data : resolveLocalPath(data, cwd)
      return run(['merge', template, '--data', values, ...forward(flags, FLAGS.merge, ['data'], cwd)])
    }

    case 'compare': {
      const original = at(0)
      const revised = at(1)
      if (!original || !revised) return refuse('compare needs two .docx files: the original and the revised one.')
      if (!flagString(flags, 'out')) return refuse('compare needs `--out <redline.docx>`.')
      const bad = refuseUnread(FLAGS.compare)
      if (bad) return bad
      return run(['docs', 'compare', original, revised, ...forward(flags, FLAGS.compare, [], cwd)])
    }

    case 'pdf': {
      // `pdf <file>` reads the text layer through the engine; `pdf <verb> …` is a page or mark
      // operation this tool performs itself (see `office-pdf-commands.ts`).
      const verb = (positional[0] ?? '').toLowerCase()
      if (verb === 'help' || verb === '--help') return refuse(pdfHelp())
      if ((PDF_VERBS as readonly string[]).includes(verb)) {
        return { kind: 'pdf', argv: raw.slice(1), cwd }
      }
      const file = at(0)
      if (!file) return refuse('pdf needs a .pdf file, or one of its commands (`pdf info`, `pdf merge`, …).')
      if (extensionOf(file) !== 'pdf') return refuse(`${file} is not a .pdf.`)
      const bad = refuseUnread(FLAGS.pdf)
      if (bad) return bad
      return run(['pdf', 'read', file, ...forward(flags, FLAGS.pdf, [], cwd)])
    }

    case 'render': {
      const file = at(0)
      if (!file) return refuse('render needs a document to look at.')
      const bad = refuseUnread(FLAGS.render)
      if (bad) return bad
      const out = flagString(flags, 'out')
      const page = flagString(flags, 'page')
      // No `--out` means "show me a page", not "fill a folder". The engine always writes files, so
      // the page goes to a scratch directory that is read and deleted — and only the page asked for
      // is drawn, rather than nineteen that nobody will look at.
      const scratch = !out
      const dir = out ? resolveLocalPath(out, cwd) : join(tmpdir(), `craft-render-${process.pid}-${Date.now()}`)
      const scoping = scratch && !page ? ['--page', '1'] : []
      /**
       * A document and a deck are **printed**; a workbook is photographed. That is the whole rule.
       *
       * `render` answers "what does this page look like", and for a `.docx` or a `.pptx` the honest
       * answer is the page as the exporter lays it out: print to PDF, rasterise the page with pdfium.
       * Their editors are editing surfaces, not pages — Word's page view is not the document's
       * pagination and a deck's slideshow is a second program on top of the first, so a photograph of
       * one was the toolbar, a black stage, or the page depending on the frame. The printed page is
       * also page-shaped instead of window-shaped, which is what a caller cropping a picture wants.
       *
       * A workbook has no pages at all until it prints, and its editor shows the grid — which is the
       * better picture of a sheet (`shot` is its own command for exactly that) — so a single page of a
       * `.xlsx` stays a photograph, and only "every page" prints.
       *
       * The cost, measured: a single printed page of a report is 3.1-4.0 s against 2.0-2.3 s for a
       * photograph, and a six-slide deck is 1.23 s printed against six editor rounds photographed.
       */
      const everyPage = Boolean(out) && !page
      const format = extensionOf(file)
      const printed = format === 'docx' || format === 'pptx' ? true : format === 'pdf' ? undefined : everyPage
      // Both routes read the file into memory — the renderer for a photograph, the exporter for a
      // print — so the ceiling belongs to everything that is not already a PDF.
      if (printed !== undefined) {
        const tooBig = refuseTooBig(file, cwd)
        if (tooBig) return tooBig
      }
      return {
        kind: 'run',
        invocation: {
          argv: ['render', file, '--out', dir, ...scoping, ...forward(flags, FLAGS.render, ['out'], cwd)],
          cwd,
        },
        // Named only when the caller asked for files: a scratch directory is not an answer.
        list: dir,
        ...(scratch ? { ephemeral: true } : {}),
        // A PDF is rasterised here by pdfium; a document or a deck is printed by the app and then
        // rasterised; a workbook's single page is a photograph of its grid.
        ...(printed === undefined
          ? {}
          : printed
            ? { needsApp: `page images of a .${format || 'document'}` }
            : { capture: { path: resolveLocalPath(file, cwd), page: Math.max(0, Number(page ?? '1') - 1) || 0 } }),
      }
    }

    case 'shot': {
      const file = at(0)
      if (!file) return refuse('shot needs a workbook to look at.')
      const bad = refuseUnread(FLAGS.shot)
      if (bad) return bad
      const out = flagString(flags, 'out')
      const sheet = flagString(flags, 'sheet')
      const range = flagString(flags, 'range')
      const tooBig = refuseTooBig(file, cwd)
      if (tooBig) return tooBig
      // No `--out` means "let me see it": the picture rides the reply and the scratch directory is
      // read and removed, exactly as `render` does. With `--out` the caller keeps the file.
      const dir = out ? resolveLocalPath(out, cwd) : join(tmpdir(), `craft-shot-${process.pid}-${Date.now()}`)
      return {
        kind: 'run',
        // Nothing to print: a workbook has no pages. The invocation is the command a host without
        // a capture would ask instead, and `captureOnly` says not to run it.
        invocation: { argv: ['sheet', 'read', file, '--json'], cwd },
        list: dir,
        ...(out ? {} : { ephemeral: true }),
        capture: {
          path: resolveLocalPath(file, cwd),
          page: 0,
          ...(sheet || range
            ? { target: { ...(sheet ? { sheet } : {}), ...(range ? { range } : {}) } }
            : {}),
        },
        captureOnly: true,
      }
    }

    case 'check': {
      const file = at(0)
      if (!file) return refuse('check needs a file.')
      const domain = domainOf(file)
      if (!domain) return refuse(`check covers a document, a workbook or a deck (${domainHint()}).`)
      const bad = refuseUnread(FLAGS.check[domain])
      if (bad) return bad
      // A deck's health is its layout, and the engine's word for that is `audit` — `slides check`
      // reads a page spec, not a deck, so it is not this command.
      const verb = domain === 'slides' ? ['slides', 'audit', file] : [domain, 'check', file]
      return run([...verb, ...forward(flags, FLAGS.check[domain], [], cwd)])
    }

    case 'deck_start': {
      const dir = at(0) ?? (flagString(flags, 'dir') ? resolveLocalPath(flagString(flags, 'dir')!, cwd) : undefined)
      if (!dir) return refuse('deck_start needs a deck folder: `deck_start <dir> --style <style.md> --outline <outline.json>`.')
      const style = flagString(flags, 'style')
      const outline = flagString(flags, 'outline')
      if (!style || !outline) {
        return refuse(
          'deck_start needs `--style <style.md>` and `--outline <outline.json>` — the two files you wrote with Write.',
        )
      }
      const bad = refuseUnread(FLAGS.deckStart)
      if (bad) return bad
      return {
        kind: 'deck',
        request: { command: 'deck_start', dir, style: resolveLocalPath(style, cwd), outline: resolveLocalPath(outline, cwd) },
      }
    }

    case 'deck_page':
    case 'deck_replace': {
      const dir = at(0)
      if (!dir) return refuse(`${cmd} needs a deck folder: \`${cmd} <dir> --index <n> --page <page.json>\`.`)
      const page = flagString(flags, 'page')
      if (!page) return refuse(`${cmd} needs \`--page <page.json>\` — the one-page spec you wrote for that entry.`)
      const index = Number(flagString(flags, 'index') ?? positional[1] ?? NaN)
      if (!Number.isInteger(index) || index < 0) return refuse(`${cmd} needs \`--index <n>\`, 0-based, into the outline.`)
      const accepted = cmd === 'deck_page' ? FLAGS.deckPage : FLAGS.deckReplace
      const bad = refuseUnread(accepted)
      if (bad) return bad
      const pptx = flagString(flags, 'pptx')
      return {
        kind: 'deck',
        request: {
          command: cmd,
          dir,
          index,
          page: resolveLocalPath(page, cwd),
          ...(pptx ? { pptx: resolveLocalPath(pptx, cwd) } : {}),
        },
      }
    }

    case 'deck_build': {
      const dir = at(0)
      if (!dir) return refuse('deck_build needs a deck folder: `deck_build <dir> [--out deck.pptx]`.')
      const bad = refuseUnread(FLAGS.deckBuild)
      if (bad) return bad
      const out = flagString(flags, 'out')
      return {
        kind: 'deck',
        request: { command: 'deck_build', dir, ...(out ? { out: resolveLocalPath(out, cwd) } : {}) },
      }
    }

    case 'guide': {
      // `guide slides spec`, `guide slides design`, `guide sheets`, `guide docs` — the group is the
      // engine's own word (`sheets`, not `sheet`), and a second position narrows it. A caller who
      // writes `guide "slides spec"` as one token means the same thing.
      const groups = positional.flatMap((part) => part.toLowerCase().split(/\s+/)).filter(Boolean)
      if (groups[0] === 'sheet') groups[0] = 'sheets'
      return run(['guide', ...(groups.length ? groups : ['docs'])])
    }

    default:
      return refuse(`No such command: ${cmd ?? '(none)'}\n\n${help()}`)
  }
}

function help(): string {
  return [
    'office_tool — documents as files (Word .docx, Excel .xlsx, PowerPoint .pptx, PDF).',
    '',
    'create <source> --out <file> [--type docx|xlsx|pptx] [--force]',
    '    docx: from Markdown (headings, lists, tables, code) or a restricted HTML fragment.',
    '    xlsx: from a .csv or a .json (2-D rows, or {"sheets":[{"name","rows"}]}); --header freezes row 1.',
    '    pptx: from --ops <ops.json> or --spec <spec.json|dir> (`guide slides`); prose is not a deck.',
    '',
    'read <file> [--json] [options]',
    '    What the file holds, by domain: a document (block indexes), a workbook (values, formulas,',
    '    sheet features), a deck (slide and element ids) or a PDF (text layer, page by page).',
    '    The indexes and ids `apply` addresses come from here — read before you change, and pass',
    '    --json. --range / --full / --sheet / --slide / --stats / --formats / --revisions /',
    '    --comments narrow or widen it.',
    '',
    'apply <file> --ops <ops.json> [--dry-run] [--track] [--author <name>] [--out <file>]',
    '    Change the file in place through structured ops; `guide docs|sheets|slides` prints them.',
    '    --track records the edits as tracked changes (--author, default "AI Assistant") — the',
    '    right call on a document someone else owns. Only what an op touches is rewritten.',
    '',
    'convert <file> --to pdf|docx|xlsx|pptx|md|html|csv [--out <file>] [--sheet <name>] [--password <pw>]',
    '    Format conversion. PDF (and html from a Word file) needs a renderer; the text targets run anywhere.',
    '',
    'replace-slide-text <file.pptx> --slide N --find "<phrase>" --replace "<new>" [--count 1] [--element <id>]',
    '    Replace a phrase on one slide **inside the editor showing the deck** — one history step, and',
    '    the runs keep their formatting. `--count` is the fingerprint: how many times the phrase occurs',
    '    there (default 1); a slide where it occurs a different number of times is refused.',
    '',
    'write-range <file.xlsx> --range A1:B2 --values <rows.json> [--sheet Name] [--expect-empty | --expect <rows.json>]',
    '    Write a block of cells **inside the editor showing the workbook** — one undoable step, and',
    '    the rest of the sheet is untouched. The fingerprint is required: `--expect-empty` for a',
    '    blank block, or `--expect` with what it holds now (`sheet read` gives you that).',
    '',
    'edit-selection <file> --from N --to M --expect "<what is there>" --text "<what it becomes>"',
    '    Change one span **inside the editor showing the document**, as one undoable step: the',
    '    person can take it back and their caret stays where it was. Nothing is written to disk',
    '    until they save. `--expect` is the fingerprint: a span that no longer says it is refused',
    '    rather than replaced. Needs the document open in the desktop app; otherwise write the file.',
    '',
    'sheets from <file.md|file.html> --out <file.xlsx>',
    '    The tables a document holds, as one sheet each, named after the heading above them.',
    '    Every table in the document is taken (a table inside a ``` fence is an example, not one).',
    '    `--header` is applied when a table says its first row is a header. A document with no',
    '    tables is refused.',
    '',
    'merge <template> --data <json|file> --out <file> [--strict]',
    '    Fill {{key}} placeholders in a .docx, .pptx or .xlsx from an object of values. Nested keys',
    '    read as a.b; the answer lists used_keys, unused_keys and unresolved_placeholders.',
    '',
    'compare <original.docx> <revised.docx> --out <redline.docx> [--granularity word|char]',
    '    A Word redline: what changed, as tracked revisions, in a document a person can review.',
    '',
    'pdf <file> [--page n | --range a-b] [--password <pw>] [--full]',
    '    The text layer of a PDF, page by page, without any app process.',
    'pdf info|split|reorder|duplicate|crop|nup|merge|rotate|watermark|header-footer|from-image|fill-form',
    '    Pages and marks: `office_tool pdf help` prints each one. Pages count from 1.',
    'pdf ocr <file> --page n [--max-side 1600] [--json] [--out <file>] [--force]',
    '    The words on one page, read locally (no upload, no account). One page per call; the editor',
    '    reads scans on open, and this is the explicit door. `--out` writes .txt, .md or .json.',
    '    A page whose own text layer already says enough is answered with that text; --force reads',
    '    the pixels anyway.',
    '',
    'render <file> [--out <dir>] [--page n] [--scale n] [--el <ids>] [--grid]',
    '    The page as a picture. Without --out it answers the image itself and writes no file (the',
    '    page you named, or page 1); with --out it writes one PNG per page and answers the paths.',
    '    --scale 2 is 144 dpi; --el crops a deck to element ids (from `read --json`); --grid adds a',
    '    contact sheet.',
    '    A PDF renders here; anything else is printed by the app (a packaged build).',
    '',
    'check <file> [--slide n]',
    '    Consistency findings, not a rewrite: a document (unevaluated fields, stale TOC, broken',
    '    refs, missing images, leftover placeholders, pending revisions), a workbook (formula',
    '    errors and unevaluated formulas, broken names, number overflow) or a deck (text overflow,',
    '    out-of-bounds or overlapping elements, stretched pictures).',
    '',
    'deck_start <dir> --style <style.md> --outline <outline.json>',
    '    Stage 1 of a designed deck: the outline is checked and its pages named. For a deck a person',
    '    will present; a short one (up to ~5 slides) is `create --type pptx --ops` instead.',
    'deck_page <dir> --index <n> --page <page.json>   — one page, checked, written in outline order',
    '    A page that fails its check is not kept; the failure names the field to fix.',
    'deck_build <dir> [--out <deck.pptx>]            — build from the checked pages',
    'deck_replace <dir> --index <n> --page <page.json>  — rebuild one slide of a built deck',
    '',
    'guide docs|sheets|slides [spec|design]',
    '    The op reference and design guides. Read `guide docs` before writing ops.',
    '',
    'Nothing here opens a window. A path relative to the conversation content root is resolved against it.',
    'Each door has its own guide (docs/docx-tools.md, xlsx-tools.md, pptx-tools.md, pdf-tools.md, convert-tools.md) — read the one for the file in hand.',
  ].join('\n')
}

/**
 * The file a writing command will replace, as written in the command line.
 *
 * `apply` names its document as the first argument (it changes that file in place); everything else
 * that writes names a destination with `--out`. Reading commands name nothing here, which is why
 * they are not in the list below.
 */
function targetFileOf(tokens: string[]): string | null {
  const verb = tokens[0]?.toLowerCase()
  if (verb === 'apply') return tokens.slice(1).find((token) => !token.startsWith('-')) ?? null
  const at = tokens.indexOf('--out')
  return at >= 0 ? (tokens[at + 1] ?? null) : null
}

/**
 * Refuse to write over **unsaved work**.
 *
 * Not "somebody has this file open": an editor holding a document nobody has typed in has exactly
 * what the disk has, so a write there is ordinary — the editor says the file changed and one press
 * reloads it. What must not happen is a write over edits that were never saved, because the reload
 * that follows takes them with it. So the question here is about work, not about windows.
 */
function refuseWhenOpen(tokens: string[], cwd: string, wantsWrite: boolean): BrowserCommandResult | null {
  if (!wantsWrite) return null
  const named = targetFileOf(tokens)
  if (!named) return null
  const path = resolveLocalPath(named, cwd)
  if (!isDocumentDirty(path)) return null
  if (tokens.includes('--force')) return null
  return say(
    [
      `${basename(path)} has unsaved changes in an editor right now.`,
      'Writing here would replace what the person is working on. Ask them to save or close it — or',
      'pass `--force` to write anyway.',
    ].join(' '),
  )
}

/**
 * `edit-selection <file> --from N --to M --expect "old" --text "new"` — change one span of the
 * document **inside the editor showing it**.
 *
 * Different from every other command here in a way worth being blunt about: nothing is written to
 * disk. The replacement becomes one step of that editor's own history, so the person can undo it
 * and their caret stays where it was — which is exactly what a file write cannot give, because the
 * editor would only learn that the file changed under it.
 *
 * Three refusals, each naming what to do instead:
 *
 * - no editor is showing the file → write it (`apply`, or the reader's own `Edit`);
 * - the editor holds unsaved changes → ask them to save first;
 * - the span no longer says what `--expect` says → read it again and retry.
 */
async function runEditSelection(
  args: { command: string | string[]; applyEdit?: ToolCommandArgs['applyEdit'] },
  cwd: string,
): Promise<BrowserCommandResult | null> {
  const tokens = Array.isArray(args.command)
    ? args.command.flatMap((part) => tokenizeCommand(part))
    : tokenizeCommand(args.command ?? '')
  if (tokens[0]?.toLowerCase() !== 'edit-selection') return null

  const file = tokens[1]
  if (!file) return say('edit-selection needs a document: `edit-selection <file> --from N --to M --expect "old" --text "new"`.')
  const valueOf = (flag: string): string | undefined => {
    const at = tokens.indexOf(flag)
    return at >= 0 ? tokens[at + 1] : undefined
  }
  const from = Number(valueOf('--from'))
  const to = Number(valueOf('--to'))
  const expectedText = valueOf('--expect')
  const text = valueOf('--text')
  if (!Number.isInteger(from) || !Number.isInteger(to) || to < from || expectedText === undefined || text === undefined) {
    return say('edit-selection needs `--from N --to M --expect "<what is there now>" --text "<what it becomes>"`.')
  }

  const path = resolveLocalPath(file, cwd)
  // One editor answers this command today. The others are reachable in principle — a workbook's
  // range, a slide's text box — but each needs its own idea of an anchor, and a command that
  // quietly fell back to a file write would be worse than saying which door works.
  const extension = extensionOf(path)
  if (extension !== 'docx' && extension !== 'doc' && extension !== 'odt') {
    return say(
      `edit-selection changes a Word document in place; ${basename(path)} is a .${extension || 'file'} ` +
        'the editors here cannot address that way yet. Write the file instead (`apply --ops`, or Edit).',
    )
  }
  if (!args.applyEdit) {
    return say(
      `No editor here can take an anchored edit, so ${basename(path)} cannot be changed in place. ` +
        'Write the file instead (`apply --ops`, or Edit), or run this where the desktop app is.',
    )
  }
  if (isDocumentDirty(path)) {
    return say(
      `${basename(path)} has unsaved changes in an editor right now. Ask the person to save or close it ` +
        'first — an edit landing now would be one more change among work they have not saved.',
    )
  }

  const result = await args.applyEdit(path, { from, to, expectedText, text })
  if (!result) {
    return say(
      `No editor is showing ${basename(path)}, so there is nothing to edit in place. Write the file ` +
        'instead (`apply --ops`, or Edit).',
    )
  }
  if (!result.ok) {
    return say(
      `The editor refused the change: ${result.message ?? 'no reason given'}. ` +
        'Read the span again and retry with what it says now.',
    )
  }
  return say(
    `Replaced ${to - from} character(s) of ${basename(path)} in the editor. It is an unsaved change ` +
      'there — the person can undo it, and it reaches the disk when they save.',
  )
}

/**
 * `write-range <file.xlsx> --range A1:B2 --values <json> [--sheet Name] [--expect-empty | --expect <json>]`
 *
 * A block of cells written **inside the editor showing the workbook** — one Univer command, which
 * is one step of the person's undo, and the selection elsewhere in the sheet is untouched.
 *
 * The fingerprint is one of two, and one of them is required: `--expect-empty` for filling a blank
 * block (the common case, and the one that needs no reading), or `--expect <json>` for a grid that
 * is compared cell by cell. Neither is optional: overwriting cells without saying what was there is
 * how a person's work disappears.
 */
async function runWriteRange(
  args: { command: string | string[]; applyEdit?: ToolCommandArgs['applyEdit']; workspaceRootPath?: string },
  cwd: string,
): Promise<BrowserCommandResult | null> {
  const tokens = Array.isArray(args.command)
    ? args.command.flatMap((part) => tokenizeCommand(part))
    : tokenizeCommand(args.command ?? '')
  if (tokens[0]?.toLowerCase() !== 'write-range') return null

  const file = tokens[1]
  const valueOf = (flag: string): string | undefined => {
    const at = tokens.indexOf(flag)
    return at >= 0 ? tokens[at + 1] : undefined
  }
  const range = valueOf('--range')
  const valuesFile = valueOf('--values')
  if (!file || !range || !valuesFile) {
    return say('write-range needs `<file.xlsx> --range A1:B2 --values <rows.json>`, and `--expect-empty` or `--expect <rows.json>`.')
  }

  const path = resolveLocalPath(file, cwd)
  const extension = extensionOf(path)
  if (!['xlsx', 'xls', 'xlsm', 'ods'].includes(extension)) {
    return say(`write-range writes a workbook; ${basename(path)} is a .${extension || 'file'}. Use the file tools for that.`)
  }
  if (!args.applyEdit) {
    return say(
      `No editor here can take a workbook edit, so ${basename(path)} cannot be changed in place. ` +
        'Write the file instead (`apply --ops`, or the sheet tools).',
    )
  }
  if (isDocumentDirty(path)) {
    return say(
      `${basename(path)} has unsaved changes in an editor right now. Ask the person to save or close it first.`,
    )
  }

  const readGrid = (name: string): unknown[][] | null => {
    const at = resolveLocalPath(name, cwd)
    try {
      const parsed = JSON.parse(readFileSync(at, 'utf8')) as unknown
      if (!Array.isArray(parsed) || !parsed.every((row) => Array.isArray(row))) return null
      return parsed as unknown[][]
    } catch {
      return null
    }
  }

  const values = readGrid(valuesFile)
  if (!values) return say(`${valuesFile} is not a 2-D JSON array of cell values.`)
  const expectEmpty = tokens.includes('--expect-empty')
  const expectedFile = valueOf('--expect')
  const expected = expectedFile ? readGrid(expectedFile) : null
  if (!expectEmpty && !expected) {
    return say(
      'write-range needs a fingerprint: `--expect-empty` when the block is blank, or `--expect <rows.json>` ' +
        'with what it holds now (get it from `sheet read`). Overwriting cells without saying what was ' +
        'there is how work disappears.',
    )
  }

  const sheet = valueOf('--sheet')
  const result = await args.applyEdit(path, {
    range,
    values,
    ...(sheet ? { sheet } : {}),
    ...(expectEmpty ? { expectEmpty: true } : {}),
    ...(expected ? { expected } : {}),
  })
  if (!result) {
    return say(
      `No editor is showing ${basename(path)}, so there is nothing to write into. Write the file ` +
        'instead (`apply --ops`, or the sheet tools).',
    )
  }
  if (!result.ok) {
    return say(
      `The editor refused the write: ${result.message ?? 'no reason given'}. ` +
        'Read the block again (`sheet read`) and retry with what it says now.',
    )
  }
  const rows = values.length
  const columns = values[0]?.length ?? 0
  return say(
    `Wrote ${rows}×${columns} cell(s) at ${sheet ? `${sheet}!` : ''}${range} in ${basename(path)}. ` +
      'It is an unsaved change in that editor — the person can undo it, and it reaches the disk when they save.',
  )
}

/**
 * `replace-slide-text <file.pptx> --slide N --find "<phrase>" --replace "<new>" [--count 1] [--element <id>]`
 *
 * Replaces a phrase **on one slide, inside the editor showing the deck** — one history step, and the
 * runs keep their formatting because the deck's own find-and-replace edits them in place.
 *
 * The anchor is the phrase plus how many times it occurs: `--count` is the fingerprint, and a slide
 * where the phrase now occurs a different number of times is refused rather than half-replaced.
 */
async function runReplaceSlideText(
  args: { command: string | string[]; applyEdit?: ToolCommandArgs['applyEdit'] },
  cwd: string,
): Promise<BrowserCommandResult | null> {
  const tokens = Array.isArray(args.command)
    ? args.command.flatMap((part) => tokenizeCommand(part))
    : tokenizeCommand(args.command ?? '')
  if (tokens[0]?.toLowerCase() !== 'replace-slide-text') return null

  const file = tokens[1]
  const valueOf = (flag: string): string | undefined => {
    const at = tokens.indexOf(flag)
    return at >= 0 ? tokens[at + 1] : undefined
  }
  const slide = Number(valueOf('--slide'))
  const find = valueOf('--find')
  const replace = valueOf('--replace')
  const countText = valueOf('--count')
  if (!file || !Number.isInteger(slide) || slide < 1 || find === undefined || replace === undefined) {
    return say(
      'replace-slide-text needs `<file.pptx> --slide N --find "<phrase>" --replace "<new>"`, and `--count <how many times it occurs>`.',
    )
  }

  const path = resolveLocalPath(file, cwd)
  if (extensionOf(path) !== 'pptx') {
    return say(`replace-slide-text changes a deck; ${basename(path)} is not a .pptx.`)
  }
  if (!args.applyEdit) {
    return say(
      `No editor here can take a deck edit, so ${basename(path)} cannot be changed in place. ` +
        'Write the file instead (`apply --ops`, or the deck tools).',
    )
  }
  if (isDocumentDirty(path)) {
    return say(`${basename(path)} has unsaved changes in an editor right now. Ask the person to save or close it first.`)
  }

  const expectCount = countText === undefined ? 1 : Number(countText)
  if (!Number.isInteger(expectCount) || expectCount < 1) {
    return say('--count is how many times the phrase occurs on that slide (a positive number); it defaults to 1.')
  }
  const element = valueOf('--element')

  const result = await args.applyEdit(path, {
    slide,
    find,
    replace,
    expectCount,
    ...(element ? { elementId: element } : {}),
  })
  if (!result) {
    return say(
      `No editor is showing ${basename(path)}, so there is nothing to change in place. Write the file ` +
        'instead (`apply --ops`, or the deck tools).',
    )
  }
  if (!result.ok) {
    return say(
      `The deck refused the replacement: ${result.message ?? 'no reason given'}. ` +
        'Read the slide again (`slides read`) and retry with what it says now.',
    )
  }
  return say(
    `Replaced "${find}" on slide ${slide} of ${basename(path)}. It is an unsaved change in that ` +
      'editor — the person can undo it, and it reaches the disk when they save.',
  )
}

/** The document a `sheets from` command reads. */
const SHEET_SOURCE_EXTENSIONS = new Set(['md', 'markdown', 'mdx', 'html', 'htm'])

/**
 * `sheets from <doc> --out <xlsx>` — the tables a document holds, as a workbook.
 *
 * **Extraction, not conversion.** A `.md` or `.html` has real structure, so nothing here guesses
 * *where* the tables are; the rules for what each becomes live in
 * `../office/sheets-from-document.ts` and are enforced by tests. Two of them are visible here: a
 * document with no tables is refused by name (an empty workbook is a mistake handed to a person),
 * and a frozen header is asked for only when the document said its first row was one.
 *
 * The workbook is built by the engine's own `create --from`, so extraction ends where the entry
 * point that already exists begins — the JSON shape is the engine's, not a second one invented here.
 */
async function runSheetsFromDocument(
  command: string | string[],
  cliPath: string,
  cwd: string,
): Promise<BrowserCommandResult | null> {
  const tokens = Array.isArray(command)
    ? command.flatMap((part) => tokenizeCommand(part))
    : tokenizeCommand(command)
  if (tokens[0]?.toLowerCase() !== 'sheets' || tokens[1]?.toLowerCase() !== 'from') return null

  const docToken = tokens[2]
  if (!docToken) {
    return say('sheets from needs a document: `sheets from <file.md|file.html> --out <file.xlsx>`.')
  }
  const outAt = tokens.findIndex((token) => token === '--out')
  const outToken = outAt >= 0 ? tokens[outAt + 1] : undefined
  if (!outToken) return say('sheets from needs `--out <file.xlsx>` for the workbook it writes.')

  const inputPath = resolveLocalPath(docToken, cwd)
  const outputPath = resolveLocalPath(outToken, cwd)
  if (!existsSync(inputPath)) return say(`No such document: ${docToken}`)
  const extension = (inputPath.split('.').pop() ?? '').toLowerCase()
  if (!SHEET_SOURCE_EXTENSIONS.has(extension)) {
    return say(`sheets from reads a .md or .html document; ${basename(inputPath)} is not one.`)
  }

  const spec = workbookFromDocument(
    readFileSync(inputPath, 'utf8'),
    extension === 'html' || extension === 'htm' ? 'html' : 'md',
  )
  if (!spec) {
    return say(
      [
        `${basename(inputPath)} has no tables, so there is nothing to put in a workbook.`,
        'A table is a markdown `| a | b |` block with its `---` line, or an HTML `<table>`.',
      ].join('\n'),
    )
  }

  // The engine's `--from` takes a file, so the spec is one — written to the temp folder and removed
  // either way: a document's tables are not a thing to leave lying around.
  const openRefusal = refuseWhenOpen(['create', '--out', outputPath], cwd, true)
  if (openRefusal) return openRefusal

  const specPath = join(tmpdir(), `craft-sheets-${process.pid}-${Date.now()}.json`)
  writeFileSync(specPath, JSON.stringify(spec), 'utf8')
  try {
    const argv = ['create', '--type', 'xlsx', '--from', specPath, '--out', outputPath, '--force']
    // A frozen header and an AutoFilter are right only when every sheet's first row is a header.
    if (spec.sheets.every((sheet) => sheet.headerRow)) argv.push('--header')

    const { ok, result } = await runCli(cliPath, argv, cwd)
    if (!ok) return say(withoutPrinter(result.output))

    const sheets = spec.sheets
      .map((sheet) => `  ${sheet.name} — ${sheet.rows.length} row(s) × ${sheet.rows[0]?.length ?? 0} column(s)`)
      .join('\n')
    return {
      ...result,
      output: [`made ${basename(outputPath)} from ${basename(inputPath)}: ${spec.sheets.length} sheet(s)`, sheets].join(
        '\n',
      ),
    }
  } finally {
    rmSync(specPath, { force: true })
  }
}

// ── pdf ocr: one page, on request ───────────────────────────────────────────────────────────────

/**
 * How many pixels the recogniser gets, at most.
 *
 * The bundled engine was tuned on screenshots at 960. A full A4 page needs more than that for small
 * print, and the cost is memory rather than accuracy, so the page default sits between the two and
 * `--max-side` is there for a scan with unusually small text.
 */
const PDF_OCR_DEFAULT_MAX_SIDE = 1600
/** 144 dpi: enough for A4 print without a 300 dpi bitmap the recogniser would only downscale. */
const PDF_OCR_RENDER_SCALE = 2
const PDF_OCR_OUT_EXTENSIONS = new Set(['txt', 'md', 'json'])

export interface PdfOcrRequest {
  file: string
  /** 1-based, the way a person reads a page number. */
  page: number
  maxSide: number
  json: boolean
  /** Read the pixels even when the page's own text layer already says enough. */
  force: boolean
  out?: string
}

/**
 * Read `pdf ocr <file> --page n [--max-side n] [--json] [--out <file>] [--force]`, or answer null
 * for any other command.
 *
 * This is the explicit door: it reads exactly the page the caller names, one call per page. The
 * editor has an automatic pass of its own over scanned pages, so this is for an agent that wants
 * one page's words without opening an editor — or wants them as a file. No upload, no account; a
 * build without the OCR models says so when the command is used, not by failing to start.
 *
 * `--force` is the way to insist on the recogniser: without it, a page whose own text layer already
 * says enough is answered with that text instead (see `pageNeedsOcr`).
 */
export function parsePdfOcrCommand(
  command: string | string[],
  cwd: string,
): PdfOcrRequest | { error: string } | null {
  const tokens = Array.isArray(command)
    ? command.flatMap((part) => tokenizeCommand(part))
    : tokenizeCommand(command)
  if (tokens[0]?.toLowerCase() !== 'pdf' || tokens[1]?.toLowerCase() !== 'ocr') return null

  const positional: string[] = []
  let page: number | undefined
  let maxSide: number | undefined
  let json = false
  let force = false
  let out: string | undefined

  for (let i = 2; i < tokens.length; i += 1) {
    const token = tokens[i]!
    if (!token.startsWith('--')) {
      positional.push(token)
      continue
    }
    const eq = token.indexOf('=')
    const name = (eq >= 0 ? token.slice(2, eq) : token.slice(2)).toLowerCase()
    if (name === 'json' || name === 'force') {
      if (eq >= 0) return { error: `--${name} is a switch; it takes no value.` }
      if (name === 'json') json = true
      else force = true
      continue
    }
    const value = eq >= 0 ? token.slice(eq + 1) : tokens[i + 1]
    if (value === undefined || (eq < 0 && value.startsWith('--'))) {
      return { error: `pdf ocr needs a value after --${name}.` }
    }
    if (eq < 0) i += 1
    if (name === 'page') {
      const parsed = Number(value)
      if (!Number.isInteger(parsed) || parsed < 1) return { error: '--page takes a page number from 1.' }
      page = parsed
    } else if (name === 'max-side') {
      const parsed = Number(value)
      if (!Number.isInteger(parsed) || parsed < 320 || parsed > 4096) {
        return { error: '--max-side takes a whole number from 320 to 4096.' }
      }
      maxSide = parsed
    } else if (name === 'out') {
      out = value
    } else {
      return { error: `pdf ocr does not take --${name}.` }
    }
  }

  if (positional.length === 0) return { error: 'pdf ocr needs a .pdf file: `pdf ocr <file> --page n`.' }
  if (positional.length > 1) return { error: 'pdf ocr reads one file at a time.' }
  const file = positional[0]!
  if (extensionOf(file) !== 'pdf') return { error: `${file} is not a .pdf.` }
  if (page === undefined) return { error: 'pdf ocr needs `--page <n>` (1-based).' }

  let target: string | undefined
  if (out) {
    target = resolveLocalPath(out, cwd)
    if (!PDF_OCR_OUT_EXTENSIONS.has(extensionOf(target))) {
      return { error: '--out must name a .txt, .md or .json file.' }
    }
  }

  return {
    file: resolveLocalPath(file, cwd),
    page,
    maxSide: maxSide ?? PDF_OCR_DEFAULT_MAX_SIDE,
    json,
    force,
    ...(target ? { out: target } : {}),
  }
}

/** Why the OCR tool could not answer, in words the reader can act on. */
function ocrFailure(run: CliRun): string {
  const detail = (run.stderr || run.stdout || run.message || '').trim()
  if (/OCR models are not installed/i.test(detail)) {
    return [
      'Local OCR models are not installed, so page OCR cannot run.',
      'Install them with `bun run fetch:ocr-models`, then rebuild the tools (`bun run build:cli-tools`).',
    ].join('\n')
  }
  if (/not built/i.test(run.message ?? '')) {
    return 'This build has no image OCR tool: run `bun run build:cli-tools` and restart.'
  }
  return `The OCR tool failed: ${detail || 'no reason was given.'}`
}

/**
 * `pdf ocr` — the words on one page, read here.
 *
 * The page is drawn by the document engine (pdfium, no window) into a scratch folder, then read by
 * the bundled OCR tool in its own process: this is CPU-bound work and it must not stop a
 * conversation while it runs. The scratch image is removed either way — the answer is the words.
 *
 * **A page that already carries text is not read twice.** Before anything is drawn, the page says
 * what its own text layer holds and whether one picture covers it; a page of prose is answered from
 * that layer (`engine: "text-layer"`), and only a scan — no text at all, or one image across the
 * sheet, which is the scan with a letterhead — goes through the recogniser. `--force` skips the
 * question and reads the pixels anyway.
 */
async function runPdfOcr(
  command: string | string[],
  cliPath: string,
  cwd: string,
): Promise<BrowserCommandResult | null> {
  const parsed = parsePdfOcrCommand(command, cwd)
  if (!parsed) return null
  if ('error' in parsed) return say(parsed.error)
  if (!existsSync(parsed.file)) return say(`No such file: ${parsed.file}`)

  const stats = await pdfPageStats(parsed.file, parsed.page)
  if (stats && !parsed.force && !pageNeedsOcr(stats)) {
    return answerPage(parsed, {
      path: parsed.file,
      page: parsed.page,
      engine: 'text-layer',
      skipped: `the page already carries ${stats.chars} characters of text`,
      textLayerChars: stats.chars,
      imageCoverage: round3(stats.imageCoverage),
      width: Math.round(stats.width),
      height: Math.round(stats.height),
      lineCount: 0,
      text: stats.text,
      lines: [],
    })
  }

  const dir = join(tmpdir(), `craft-pdf-ocr-${process.pid}-${Date.now()}`)
  try {
    const rendered = await runCli(
      cliPath,
      [
        'render',
        parsed.file,
        '--out',
        dir,
        '--page',
        String(parsed.page),
        '--scale',
        String(PDF_OCR_RENDER_SCALE),
      ],
      cwd,
    )
    if (!rendered.ok) return say(withoutPrinter(rendered.result.output))

    const [png] = pagesIn(dir)
    if (!png) {
      return say(`Page ${parsed.page} of ${basename(parsed.file)} was not drawn, so there is nothing to read.`)
    }

    const run = await runCliTool('img-tool', ['text', png, '--max-side', String(parsed.maxSide)], {
      timeoutMs: 5 * 60 * 1000,
    })
    if (!run.ok) return say(ocrFailure(run))

    let answer: { text?: unknown; width?: unknown; height?: unknown; engine?: unknown; lines?: unknown }
    try {
      answer = JSON.parse(run.stdout) as typeof answer
    } catch {
      return say(`The OCR tool answered something that is not JSON: ${run.stdout.slice(0, 200)}`)
    }

    const text = typeof answer.text === 'string' ? answer.text : ''
    const lines = Array.isArray(answer.lines) ? answer.lines : []
    return answerPage(parsed, {
      path: parsed.file,
      page: parsed.page,
      engine: typeof answer.engine === 'string' ? answer.engine : 'local-ocr',
      textLayerChars: stats ? stats.chars : null,
      imageCoverage: stats ? round3(stats.imageCoverage) : null,
      width: typeof answer.width === 'number' ? answer.width : null,
      height: typeof answer.height === 'number' ? answer.height : null,
      lineCount: lines.length,
      text,
      lines,
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const round3 = (value: number): number => Math.round(value * 1000) / 1000

/** One page's answer, wherever its words came from. */
interface PageAnswer {
  text: string
  lines: unknown[]
  skipped?: string
  [field: string]: unknown
}

/** `--out`, `--json` or the words themselves — the same three for a read page and an OCR'd one. */
function answerPage(parsed: PdfOcrRequest, payload: PageAnswer): BrowserCommandResult {
  const { text, lines } = payload
  if (parsed.out) {
    const body =
      extensionOf(parsed.out) === 'json'
        ? `${JSON.stringify(payload, null, 2)}\n`
        : `${text}${text.endsWith('\n') ? '' : '\n'}`
    writeFileSync(parsed.out, body, 'utf8')
    const detail = payload.skipped ? 'its own text layer' : `${lines.length} line(s)`
    return say(
      `Wrote ${basename(parsed.out)} from page ${parsed.page} of ${basename(parsed.file)} (${detail}).`,
    )
  }
  if (parsed.json) return say(JSON.stringify(payload, null, 2))
  if (!text.trim()) {
    return say(
      payload.skipped
        ? `Page ${parsed.page} of ${basename(parsed.file)} has no text.`
        : `No text was recognized on page ${parsed.page} of ${basename(parsed.file)}.`,
    )
  }
  return say(text.trimEnd())
}

/**
 * Run a `office_tool` command.
 *
 * Takes the same `ToolCommandArgs` the pane doors take, so the runtime's tool map stays one shape;
 * the parts it uses are the command and the session's working directory. Every path is resolved
 * first, because the engine is a separate process with a working directory of its own.
 */
/**
 * Which door a file belongs to, by extension — the same four the engine has editors for.
 *
 * A tool that is handed another door's file says so instead of letting the engine answer for a
 * format whose ops it was never given: `apply` on a `.xlsx` from the Word tool would take cell ops
 * as block ops and report a failure nobody could read.
 */
const EXTENSION_DOOR: Record<string, OfficeDomain> = {
  docx: 'docx', doc: 'docx', odt: 'docx', ott: 'docx',
  xlsx: 'xlsx', xlsm: 'xlsx', xlsb: 'xlsx', xls: 'xlsx', ods: 'xlsx', ots: 'xlsx',
  pptx: 'pptx', ppt: 'pptx', odp: 'pptx', otp: 'pptx',
  pdf: 'pdf',
}

/** Commands whose first non-flag argument is the document they act on. `pdf <verb>` is not one. */
const ACTS_ON_A_FILE = new Set([
  'read',
  'apply',
  'check',
  'render',
  'merge',
  'compare',
  'edit-selection',
  'write-range',
  'replace-slide-text',
  'shot',
])

/**
 * The wrong-door refusal, or null when this command belongs to the tool that was called.
 *
 * Two things are checked, and they are different mistakes: the **command** (a workbook command asked
 * of the Word tool) and the **file** (a `.xlsx` handed to the Word tool's `read`). Both answer with
 * the tool that owns the thing, because "no such command" is true and useless.
 */
function doorRefusal(command: string | string[], tool: string | undefined): string | null {
  if (!tool) return null
  const door = officeDomainOf(tool)
  if (!door) return null

  const tokens = Array.isArray(command)
    ? command.flatMap((part) => tokenizeCommand(part))
    : tokenizeCommand((command ?? '').trim())
  const verb = (tokens[0] ?? '').toLowerCase()

  // A workbook is the one door with no `render`, so the generic answer ("docx_tool is the one that
  // does") would send a spreadsheet question to the Word tool. It has an answer of its own.
  if (verb === 'render' && door.domain === 'xlsx') {
    return [
      '`render` is not a workbook command: a sheet has no pages until it is printed, and page layout',
      'is not what a sheet is read for. `read` answers its values, and `sheets` its tabs and ranges.',
    ].join(' ')
  }

  if (!door.commands.includes(verb)) {
    const owner = officeDomainForCommand(verb)
    return [
      `\`${verb || 'that'}\` is not ${door.toolName}'s command — it answers ${door.commands.join(', ')}.`,
      owner ? `${owner.toolName} is the one that does (${owner.docFile}).` : '',
    ]
      .filter(Boolean)
      .join(' ')
  }

  if (door.domain === 'convert' || !ACTS_ON_A_FILE.has(verb)) return null
  const named = tokens.slice(1).find((token) => !token.startsWith('-'))
  const owner = named ? EXTENSION_DOOR[extensionOf(named)] : undefined
  if (!owner || owner === door.domain) return null
  const other = officeDomainOf(`${owner}_tool`)
  return `${named} is a ${owner} file: ${other ? other.toolName : 'another tool'} is the door for it, not ${door.toolName}.`
}

export async function executeOfficeToolCommand(
  args: {
    command: string | string[]
    workspaceRootPath?: string | undefined
    /** The session's own place: bare paths count from the content root it names. */
    sessionId?: string | undefined
    projectId?: string | undefined
    sessionWorkingDirectory?: string | undefined
    /** See `ToolCommandArgs.applyEdit` — `edit-selection` is the one command that reads it. */
    applyEdit?: ToolCommandArgs['applyEdit']
    /** See `ToolCommandArgs.capturePages` — `render` is the one command that reads it. */
    capturePages?: ToolCommandArgs['capturePages']
    /**
     * The door this command arrived through (`docx_tool`, `xlsx_tool`, …). Absent means "no door":
     * the dispatcher then answers whatever it knows, which is what an internal caller and a test
     * want. With a door, the command and the file both have to belong to it.
     */
    tool?: string
  },
): Promise<BrowserCommandResult> {
  const wrongDoor = doorRefusal(args.command, args.tool)
  if (wrongDoor) return say(wrongDoor)

  const cwd = contentRootOf(args) ?? args.workspaceRootPath ?? process.cwd()
  const first = Array.isArray(args.command) ? args.command[0] : tokenizeCommand((args.command ?? '').trim())[0]

  if (!first || ['help', '--help', '-h'].includes(first.toLowerCase())) return say(help())

  const cliPath = resolveGenofficeCli()
  if (!cliPath) {
    // No paths and no build steps: the reader is a person in a conversation, and the only thing it
    // can act on is that this build cannot touch a document. A maintainer has `docs/requirements/office-embed.md`.
    return say('This build has no document engine, so it cannot make or change Word, Excel or PowerPoint files.')
  }

  // `sheets from <doc>` is ours, not the engine's: it turns a document's tables into the workbook
  // `create --from` already knows how to build (see runSheetsFromDocument).
  const fromDocument = await runSheetsFromDocument(args.command, cliPath, cwd)
  if (fromDocument) return fromDocument

  // `pdf ocr` draws one page with the engine and reads it with the bundled local OCR. The editor
  // has its own automatic pass over scanned pages; this door is the explicit, one-page one.
  const pdfOcr = await runPdfOcr(args.command, cliPath, cwd)
  if (pdfOcr) return pdfOcr

  const inEditor = await runEditSelection(args, cwd)
  if (inEditor) return inEditor

  const inWorkbook = await runWriteRange(args, cwd)
  if (inWorkbook) return inWorkbook

  const inDeck = await runReplaceSlideText(args, cwd)
  if (inDeck) return inDeck

  const plan = planOfficeCommand(args.command, cwd)
  if (plan.kind === 'say') return say(plan.output)
  if (plan.kind === 'deck') return runDeck(plan.request, cliPath, cwd)
  if (plan.kind === 'pdf') return runPdfCommand(plan.argv, plan.cwd)

  // The four commands that replace a file the person may be looking at.
  const WRITING_VERBS = new Set(['create', 'apply', 'convert', 'merge'])
  const commandTokens = Array.isArray(args.command)
    ? args.command.flatMap((part) => tokenizeCommand(part))
    : tokenizeCommand(args.command ?? '')
  const refusal = refuseWhenOpen(commandTokens, cwd, WRITING_VERBS.has(commandTokens[0]?.toLowerCase() ?? ''))
  if (refusal) return refusal

  // A page this host can draw is not a print at all: ask, and answer with the picture when it came.
  // Falling through on failure is deliberate — a host that cannot open an editor still has the
  // printed page, and a refusal to *look* at a document is worse than a slower look at it.
  if (plan.captureOnly && !args.capturePages) {
    return say(
      'This host cannot draw a worksheet, and a workbook has no pages to print. ' +
        '`read` answers its values, `sheets` its tabs and ranges.',
    )
  }

  let captureFailure: string | null = null
  if (plan.capture && args.capturePages && plan.list) {
    try {
      const files = await args.capturePages({ ...plan.capture, outDir: plan.list })
      if (files.length) {
        const images = pageImages(files)
        const label = `${basename(plan.capture.path)} page ${plan.capture.page + 1}`
        // When the picture could not ride the reply it is still a path to `Read`.
        const named = files.map((page) => `  ${page}`).join(String.fromCharCode(10))
        return {
          output: images.length ? label : `${label}${String.fromCharCode(10)}${named}`,
          images,
          appendReleaseHint: false,
        }
      }
    } catch (error) {
      captureFailure = error instanceof Error ? error.message : String(error)
      // A workbook has nothing to print, so a failed picture is the whole answer.
      if (plan.captureOnly) {
        return say(`Could not draw ${basename(plan.capture.path)}: ${captureFailure}`)
      }
      // The editor did not draw it. Print it, below — and say so, because the two routes are not
      // the same speed and a caller that cannot tell them apart will keep expecting 2 s.
    } finally {
      if (plan.ephemeral) rmSync(plan.list, { recursive: true, force: true })
    }
  }

  if (plan.needsApp && !canPrintHere()) {
    return say(
      [
        `To produce ${plan.needsApp}, the page is printed first — and this host has no renderer.`,
        'The file is unchanged, and what does not need printing still works: `read` answers its',
        'structure, `check` reports what is wrong, and `convert` writes every text format.',
      ].join('\n'),
    )
  }

  const { ok, result } = await runCli(cliPath, plan.invocation.argv, plan.invocation.cwd)
  if (!ok) return say(withoutPrinter(result.output))
  if (captureFailure) {
    return {
      ...result,
      output: `${result.output}

(This page was printed, not drawn: ${captureFailure})`,
    }
  }

  // The answer to `render` is pictures: the pages ride the reply when the door can show them, and
  // their paths are named either way — a path is what `Read` and the app's preview need.
  // A look, not an output: the pictures ride the reply and the scratch directory goes away.
  if (plan.list && plan.ephemeral) {
    try {
      return { ...result, images: pageImages(pagesIn(plan.list)) }
    } finally {
      rmSync(plan.list, { recursive: true, force: true })
    }
  }

  if (plan.list) {
    const pages = pagesIn(plan.list)
    const images = pageImages(pages)
    const named = /\.png/i.test(result.output)
    const text =
      pages.length && !named
        ? `${result.output}\n\n${pages.length} page image(s) — Read one to look at it:\n${pages.map((page) => `  ${page}`).join('\n')}`
        : result.output
    return images.length ? { ...result, output: text, images } : { ...result, output: text }
  }
  return result
}

/** The same brief the tool description shows, for callers that print it. */
export const OFFICE_TOOL_HELP = help()
