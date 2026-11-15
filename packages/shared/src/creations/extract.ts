/**
 * Which tool calls name a document — and where in their arguments it is.
 *
 * **A whitelist, not a heuristic.** A generic "any string that looks like a path" rule reads the
 * `--to pdf` of a conversion as a file called `pdf`, and an `old_string` in an edit as a document.
 * Every entry below is here because a real tool names a real output; a tool that is not named is
 * a tool whose writes this library cannot attribute (a `Bash` heredoc, most obviously), and it is
 * better to show nothing than to guess.
 *
 * Two roles, and the difference matters downstream:
 *
 * - **created** — the argument *is* an output: `Write`'s `file_path`, `--out`, `export --to`.
 * - **modified** — the argument is the document a command operated on (`office_tool apply x.docx`).
 *
 * `explicit` marks the first group. It is what lets a source tree's edits be filtered out while a
 * `--out` into that same tree stays visible: naming an output is a statement about intent, and
 * editing a file in place is not.
 */

/** One path a tool call names, before normalization. */
export interface ArtifactHit {
  /** As written in the argument — `scan.ts` turns it into an absolute path. */
  raw: string
  role: 'created' | 'modified'
  /** The argument named an output rather than a document that was operated on. */
  explicit: boolean
  tool: string
}

/** Tools whose `file_path` is the file they wrote. */
const FILE_PATH_TOOLS: Record<string, 'created' | 'modified'> = {
  Write: 'created',
  write: 'created',
  Edit: 'modified',
  edit: 'modified',
  MultiEdit: 'modified',
  NotebookEdit: 'modified',
}

/**
 * `explicit` means "a tool named this as an output", not "a tool wrote it".
 *
 * The difference is the whole filter. `Write` creates a file, but it also creates `package.json` in
 * a checkout the agent was editing and `tsconfig.json` beside it — files that are *written* without
 * being *delivered*. `--out`, `export --to` and `transform_data`'s `outputFile` are the arguments
 * that only ever hold a destination, so they are the ones allowed to pull a file out of a source
 * tree and into the library.
 */

/**
 * Split a command the way a shell would, without a shell.
 *
 * Quoting is the only feature that matters here: `--out "C:\My Docs\a.pdf"` is one argument, and
 * a naive `split(' ')` would produce two paths that do not exist.
 */
export function splitCommand(command: unknown): string[] {
  const text = Array.isArray(command) ? command.join(' ') : typeof command === 'string' ? command : ''
  if (!text.trim()) return []
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = null
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current) tokens.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current) tokens.push(current)
  return tokens
}

/** Every value of `--out` / `-o`, in both `--out x` and `--out=x` forms. */
export function outFlags(tokens: string[]): string[] {
  const values: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    const equals = /^(?:--out|-o)=(.*)$/.exec(token)
    if (equals) {
      if (equals[1]) values.push(equals[1])
      continue
    }
    if (token === '--out' || token === '-o') {
      const next = tokens[i + 1]
      if (next && !next.startsWith('-')) values.push(next)
    }
  }
  return values
}

/** The first positional after the verb — the document a command operates on. */
export function firstPositional(tokens: string[]): string | null {
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token.startsWith('-')) continue
    return token
  }
  return null
}

/**
 * `office_tool`'s verbs that change their argument in place.
 *
 * Everything else in that command line (`read`, `convert`, `render`, `check`, `compare`, `deck_*`)
 * only *reads* the positional: `convert contract.docx --to pdf` writes a PDF and leaves the Word
 * file alone, so calling the docx modified would put a file in the library that no turn changed.
 */
const OFFICE_IN_PLACE = new Set(['apply', 'pdf'])

export function extractArtifacts(toolName: string, input: unknown): ArtifactHit[] {
  if (!input || typeof input !== 'object') return []
  const args = input as Record<string, unknown>
  const hits: ArtifactHit[] = []

  const filePathRole = FILE_PATH_TOOLS[toolName]
  if (filePathRole) {
    const path = args.file_path ?? args.path ?? args.filename
    if (typeof path === 'string' && path.trim()) {
      hits.push({ raw: path, role: filePathRole, explicit: false, tool: toolName })
    }
    return hits
  }

  // The account door names its output the same way the document tools do. `generate` writes a file;
  // `task`/`cancel`/`channels` name a path they watch, not one they produced, so they are not hits.
  if (toolName === 'media_tool') {
    const tokens = splitCommand(args.command ?? args.args)
    const verb = tokens[0]?.toLowerCase()
    if (verb !== 'generate') return hits
    for (const raw of outFlags(tokens)) {
      hits.push({ raw, role: 'created', explicit: true, tool: toolName })
    }
    return hits
  }

  // The app's own tools take a command line rather than named arguments.
  if (OFFICE_DOC_TOOLS.has(toolName) || toolName === 'drawio_tool' || toolName === 'browser_tool') {
    const tokens = splitCommand(args.command ?? args.args)
    if (!tokens.length) return hits
    const verb = tokens[0]!.toLowerCase()

    for (const raw of outFlags(tokens)) {
      hits.push({ raw, role: 'created', explicit: true, tool: toolName })
    }

    if (toolName === 'drawio_tool') {
      // `export <file> --to <out>`: the output is `--to`, not `--out`.
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i]!
        const target = token === '--to' ? tokens[i + 1] : /^--to=(.*)$/.exec(token)?.[1]
        if (target && !target.startsWith('-')) {
          hits.push({ raw: target, role: 'created', explicit: true, tool: toolName })
        }
      }
      return hits
    }

    if (OFFICE_DOC_TOOLS.has(toolName) && OFFICE_IN_PLACE.has(verb)) {
      const positional = firstPositional(tokens)
      if (positional) hits.push({ raw: positional, role: 'modified', explicit: false, tool: toolName })
    }
    return hits
  }

  // `transform_data` writes relative to the session's `data/` folder, so the path is assembled by
  // the scanner (it knows the session directory) — the raw value here is the relative name.
  if (toolName === 'transform_data') {
    const output = args.outputFile
    if (typeof output === 'string' && output.trim()) {
      hits.push({ raw: `data/${output}`, role: 'created', explicit: true, tool: toolName })
    }
  }

  return hits
}

/** Tools this module understands. Exported for the coverage test, not for routing. */
/** The document doors — one per format, plus conversions (`office-domains.ts`). */
const OFFICE_DOC_TOOLS = new Set(['docx_tool', 'xlsx_tool', 'pptx_tool', 'pdf_tool', 'convert_tool'])

export const ARTIFACT_TOOLS: readonly string[] = [
  ...Object.keys(FILE_PATH_TOOLS),
  ...OFFICE_DOC_TOOLS,
  'drawio_tool',
  'browser_tool',
  'media_tool',
  'transform_data',
]
