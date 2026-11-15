/**
 * The CLI every pane tool shares.
 *
 * One command line over one capability surface (`BrowserPaneFns`), reached through several doors:
 * `browser_tool` for the window's own pages, `media_tool` for accounts, `recording_tool` for frames out
 * of a recording, `drawio_tool` for diagrams. What is *the same* on all of them lives here —
 * tokenizing the command string or array, `--tab` targeting, option and path resolution, the result
 * shape, and the skeleton of running one command.
 *
 * **Nothing here knows any door.** A door is three things — its help text, its command table,
 * and what it says about a command it does not handle — and it hands them to `createCommandRunner`.
 * That is what keeps the dependency one-way: the `*-commands.ts` modules import this module, and it
 * imports none of them.
 *
 * What is *not* here either: batching (only `browser_tool` batches), `evaluate --file`, the settle
 * timings `open` waits on, and every command body.
 */

import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import type { BrowserPaneFns } from './browser-pane.ts';
import { resolveContentRoots, resolveFilePath } from './content-paths.ts';

export interface BrowserCommandImage {
  data: string;
  mimeType: 'image/png' | 'image/jpeg';
  sizeBytes: number;
  /**
   * The file this image is also written to, when it is one — a frame of a capture.
   *
   * A screenshot exists only in the reply; a capture's frames are the record, and the
   * reply is the second copy. The path is what lets a door that shows images by reading
   * them from disk (the PiAgent one) render the frame the capture already wrote.
   */
  path?: string;
}

export interface BrowserCommandResult {
  output: string;
  appendReleaseHint: boolean;
  image?: BrowserCommandImage;
  /**
   * The images this one result carries, when it carries more than one.
   *
   * Only a frame capture does: `screenshot` is a single picture, while a recording is
   * a session of them and the point of the session is that the model can look at what
   * happened.
   */
  images?: BrowserCommandImage[];
}

export interface BrowserPageMetrics {
  url: string;
  title: string;
  viewportWidth: number;
  viewportHeight: number;
  documentWidth: number;
  documentHeight: number;
  scrollX: number;
  scrollY: number;
  maxScrollX: number;
  maxScrollY: number;
  activeElementTag?: string;
  activeElementRole?: string;
  activeElementId?: string;
  activeElementName?: string;
}

async function safeEvaluate<T>(fns: BrowserPaneFns, expression: string): Promise<T | null> {
  try {
    const value = await fns.evaluate(expression);
    return value as T;
  } catch {
    return null;
  }
}

export async function getPageMetrics(fns: BrowserPaneFns): Promise<BrowserPageMetrics | null> {
  return safeEvaluate<BrowserPageMetrics>(
    fns,
    `(() => {
      const doc = document.documentElement;
      const body = document.body;
      const scrollWidth = Math.max(doc?.scrollWidth || 0, body?.scrollWidth || 0, window.innerWidth || 0);
      const scrollHeight = Math.max(doc?.scrollHeight || 0, body?.scrollHeight || 0, window.innerHeight || 0);
      const viewportWidth = window.innerWidth || 0;
      const viewportHeight = window.innerHeight || 0;
      const scrollX = window.scrollX || window.pageXOffset || 0;
      const scrollY = window.scrollY || window.pageYOffset || 0;
      const active = document.activeElement;
      return {
        url: window.location.href,
        title: document.title || '',
        viewportWidth,
        viewportHeight,
        documentWidth: scrollWidth,
        documentHeight: scrollHeight,
        scrollX,
        scrollY,
        maxScrollX: Math.max(0, scrollWidth - viewportWidth),
        maxScrollY: Math.max(0, scrollHeight - viewportHeight),
        activeElementTag: active?.tagName?.toLowerCase() || '',
        activeElementRole: active?.getAttribute?.('role') || '',
        activeElementId: active?.id || '',
        activeElementName: active?.getAttribute?.('name') || active?.getAttribute?.('aria-label') || active?.textContent?.trim?.().slice(0, 80) || '',
      };
    })()`
  );
}

function decodeEscapes(input: string): string {
  // A Windows path is taken **literally**, separators and all.
  //
  // `C:\temp\notes.txt` read as escapes is a tab then a newline — replaced characters, not a path
  // — and it fails much later, at the filesystem, with "no such file or directory" pointing at a
  // string nobody typed. Drive-letter and UNC forms are unambiguous paths; no command wants an
  // escape sequence inside one.
  if (/^[A-Za-z]:[\\/]/.test(input) || input.startsWith('\\\\')) return input;
  return input.replace(/\\(.)/g, (_match, ch: string) => {
    if (ch === 'n') return '\n';
    if (ch === 't') return '\t';
    if (ch === 'r') return '\r';
    if (ch === '"') return '"';
    if (ch === "'") return "'";
    if (ch === '\\') return '\\';
    return `\\${ch}`;
  });
}

/**
 * One token of a command line, and where it came from.
 *
 * The `text` is what a command body reads — shell semantics, so a quoted value loses its quotes and
 * `\n` in a value becomes a newline. The offsets are the characters of the input it was read from
 * (`[start, end)`), which is what {@link commandTextWithout} needs: a command whose argument is
 * **source code** (`evaluate`) cannot be rebuilt from tokens at all, because the quotes that were
 * taken off it were part of the program (see `ctx.rawCommand`).
 */
export interface CommandToken {
  text: string
  start: number
  end: number
}

/**
 * Split a command string into tokens, honouring quotes and escapes.
 *
 * Shared because both doors take the same command line — `--tab <id>`, a quoted value with spaces
 * in it. The error names no tool: it is this parser's, whichever door the command came through.
 */
export function tokenizeCommand(input: string): string[] {
  return tokenizeCommandSpans(input).map((token) => token.text);
}

/**
 * The same split, with each token's place in the input kept.
 *
 * The only caller that needs the places is the one handing a body its **verbatim** text: an
 * expression is source code, and rebuilding it from tokens hands it back mangled.
 */
export function tokenizeCommandSpans(input: string): CommandToken[] {
  const tokens: CommandToken[] = [];
  let current = '';
  let tokenStarted = false;
  /** Where the token being read started, `-1` while there is none. */
  let tokenStart = -1;
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  const pushCurrent = (end: number) => {
    if (!tokenStarted) return;
    tokens.push({ text: decodeEscapes(current), start: tokenStart, end });
    current = '';
    tokenStarted = false;
    tokenStart = -1;
  };

  /** A token begins here, whether or not the character itself is kept (a quote is not). */
  const startToken = (at: number) => {
    if (!tokenStarted) tokenStart = at;
    tokenStarted = true;
  };

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;

    if (escaped) {
      current += `\\${ch}`;
      startToken(i - 1);
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      escaped = true;
      if (!tokenStarted) tokenStart = i;
      continue;
    }

    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      startToken(i);
      continue;
    }

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      startToken(i);
      continue;
    }

    if (!inSingle && !inDouble && /\s/.test(ch)) {
      pushCurrent(i);
      continue;
    }

    current += ch;
    startToken(i);
  }

  if (escaped) {
    current += '\\';
    tokenStarted = true;
  }

  if (inSingle || inDouble) {
    throw new Error('Parse error: unclosed quote in the command.');
  }

  pushCurrent(input.length);
  return tokens;
}

/**
 * The command line as it was typed, minus the tokens `drop` names.
 *
 * Cut characters, not tokens: what is left is the original text, so quotes, semicolons and runs of
 * spaces inside an expression survive. That is what `evaluate` runs, and rebuilding it from
 * tokens is what used to turn `document.title + ' | ' + location.href` into `document.title + | +
 * location.href` — a syntax error that read like the page had failed (measured: 39 of the 45
 * `evaluate` failures across this workspace's sessions were that, all of them quoted).
 *
 * The dropped tokens are replaced by a space rather than nothing, so two arguments that were
 * separated by one cannot be glued together (`--tab tab-2` between two words of an expression).
 */
export function commandTextWithout(input: string, spans: CommandToken[], drop: Set<number>): string {
  const ranges = spans
    .map((span, index) => ({ span, index }))
    .filter(({ index }) => drop.has(index))
    .map(({ span }) => [span.start, span.end] as const)
    .sort((a, b) => a[0] - b[0])

  let out = ''
  let cursor = 0
  for (const [start, end] of ranges) {
    if (start < cursor) continue
    out += `${input.slice(cursor, start)} `
    cursor = end
  }
  return `${out}${input.slice(cursor)}`.trim()
}

/** Read a numeric option (`--interval 200`), bounded, falling back to a default. */
export function numberOption(parts: string[], flag: string, fallback: number, min: number, max: number): number {
  const value = Number(parts[parts.indexOf(flag) + 1]);
  if (parts.indexOf(flag) === -1 || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/**
 * A byte count in the units a person reads, for the replies that report a file's size.
 *
 * Shared between the doors because both report sizes — a screenshot on the window's side, the
 * frames a capture writes on the workspace's — and a second copy is how the two would start
 * disagreeing about what "KB" means.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

/** Read a ratio option, accepting `2%` and `0.02` alike. */
export function ratioOption(parts: string[], flag: string, fallback: number): number {
  const at = parts.indexOf(flag);
  if (at === -1) return fallback;
  const raw = (parts[at + 1] ?? '').trim();
  const value = raw.endsWith('%') ? Number(raw.slice(0, -1)) / 100 : Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(1, value);
}

/** Read a duration option (`--every 2s`, `--every 500ms`, `--every 2`), in ms. */
export function durationOption(parts: string[], flag: string, fallbackMs: number): number {
  const at = parts.indexOf(flag);
  if (at === -1) return fallbackMs;

  const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec((parts[at + 1] ?? '').trim().toLowerCase());
  if (!match) return fallbackMs;

  const value = Number(match[1]);
  const unit = match[2] ?? 's';
  const ms = unit === 'ms' ? value : unit === 'm' ? value * 60_000 : value * 1000;
  return Math.min(600_000, Math.max(100, Math.round(ms)));
}

/**
 * A duration the command **must** be given.
 *
 * `durationOption`'s fallback is the wrong shape where the value is the whole bound: a recording
 * whose length nobody stated has no bound at all, so "absent" and "unreadable" have to be told
 * apart rather than both quietly becoming a default. The ceiling is `durationOption`'s — a
 * recording cannot outlast it however it was asked for.
 */
export function requiredDurationOption(parts: string[], flag: string, example: string): number {
  const at = parts.indexOf(flag);
  if (at === -1) throw new Error(`${flag} is required — how long. Example: ${example}`);

  const raw = (parts[at + 1] ?? '').trim().toLowerCase();
  if (!/^(\d+(?:\.\d+)?)(ms|s|m)?$/.test(raw)) {
    throw new Error(`${flag} needs a duration like 500ms, 30s or 2m. Example: ${example}`);
  }
  return durationOption(parts, flag, 0);
}

/**
 * Read the global `--tab <id>` target off a command, and hand back the command
 * without it.
 *
 * It is lifted out before any command parses its own arguments, because it says
 * *where* rather than *what*: every command shares it, and none of them should
 * have to know about it. A `--tab` with no id is refused here instead of silently
 * acting on some other tab.
 */
function extractTabTarget(parts: string[]): { parts: string[]; tabId: string | null } {
  const at = parts.indexOf('--tab');
  if (at === -1) return { parts, tabId: null };

  const tabId = parts[at + 1]?.trim();
  if (!tabId || tabId.startsWith('--')) {
    throw new Error('--tab needs a tab id. "tabs" lists them. Example: snapshot --tab tab-3');
  }

  return { parts: [...parts.slice(0, at), ...parts.slice(at + 2)], tabId };
}

/**
 * Read the global `--profile <name-or-id>` scope off a command, and hand back the command without it.
 *
 * Lifted out for the same reason as `--tab`: it says *where* rather than *what*. The name is the
 * profile's display name or its id (`profiles` prints both); resolving it to an actual profile is
 * the host's job, because only the host knows the registry.
 */
function extractProfileTarget(parts: string[]): { parts: string[]; profile: string | null } {
  const at = parts.indexOf('--profile');
  if (at === -1) return { parts, profile: null };

  const profile = parts[at + 1]?.trim();
  if (!profile || profile.startsWith('--')) {
    throw new Error('--profile needs a profile name or id. "profiles" lists them. Example: navigate https://example.com --profile Work');
  }

  return { parts: [...parts.slice(0, at), ...parts.slice(at + 2)], profile };
}

/**
 * The absolute path a command's `--file` names.
 *
 * A relative path is counted from the **workspace root**, which is what a path like
 * `scripts/probe.js` is counted from. Deliberately not a second base: the same string
 * meaning two different files is how the wrong script gets injected. `~/…` is expanded;
 * an absolute path is used as it is.
 */
export function resolveLocalPath(filePath: string, workspaceRootPath?: string): string {
  const requested = filePath === '~' || filePath.startsWith('~/') || filePath.startsWith('~\\')
    ? resolve(homedir(), filePath.slice(2))
    : filePath;

  if (isAbsolute(requested)) return requested;

  if (!workspaceRootPath) {
    throw new Error(
      `--file: "${filePath}" is not absolute and there is no workspace to count a relative path from. ` +
      'Pass an absolute path.',
    );
  }

  return resolve(workspaceRootPath, requested);
}

/** What a door needs to know to find the conversation's own files. */
export interface ToolPathContext {
  sessionId?: string;
  workspaceRootPath?: string;
  projectId?: string;
  sessionWorkingDirectory?: string;
}

/** The conversation's content root — the project folder, or its session folder. */
export function contentRootOf(context: ToolPathContext): string | null {
  const roots = resolveContentRoots(context);
  return roots.ok ? roots.roots.contentRoot : null;
}

/**
 * One path from a command, as a real file.
 *
 * An absolute path is taken as it is; a handle (`assets/x`, `session:x`, `project:x`, …) is resolved
 * against the conversation's roots. Without a root — a host that knows neither workspace nor
 * session — a relative path falls back to the workspace-root rule, which is what it always was.
 */
export function resolveToolPath(raw: string, context: ToolPathContext): string {
  if (isAbsolute(raw)) return raw;
  const roots = resolveContentRoots(context);
  if (roots.ok) {
    const resolved = resolveFilePath(raw, roots.roots);
    if (!resolved.ok) throw new Error(resolved.error);
    return resolved.path;
  }
  return resolveLocalPath(raw, context.workspaceRootPath);
}

/** What a door is handed when one of its commands is run. */
import type { OfficeEditRequest } from '../office/open-documents.ts'

export interface ToolCommandArgs {
  command: string | string[]
  fns: BrowserPaneFns
  sessionId: string
  platform?: NodeJS.Platform
  /** Injected by a test so a model call does not reach the network. */
  fetchImpl?: typeof fetch
  /** Where a relative `--file` path is counted from (the workspace root). */
  workspaceRootPath?: string
  /**
   * The workspace project this conversation is bound to, when the host knows it.
   *
   * A door that works on the conversation's own files anchors bare paths to that project; the
   * session folder is the root when there is none.
   */
  projectId?: string
  /**
   * Whether this conversation is bound to a project.
   *
   * Doors whose output is project-scoped (cuts) refuse when this is explicitly `false`;
   * `undefined` keeps the old permissive behaviour for hosts and tests that do not know the
   * binding.
   */
  hasProject?: boolean
  /**
   * The session's own working directory — the project folder when the session is in one.
   *
   * A door that works on the project's own files counts its default path from here rather than
   * from the workspace root.
   */
  sessionWorkingDirectory?: string

  /**
   * The session is in Explore, which is read-only.
   *
   * A door that writes a file directly (rather than through the editor or the plans folder) has no
   * boundary to lean on, so it is told here and refuses its own writes. Reading stays available in
   * every mode — a file nobody may change is still one worth looking at.
   */
  readOnly?: boolean
  /**
   * Replace one span **inside the editor showing a document** — `office_tool`'s `edit-selection`.
   *
   * Not a file write: the change lands as one step of that editor's history, so the person can undo
   * it. The door answers `null` when nothing is showing the document, and the command then says so
   * instead of writing behind an editor that is not there.
   */
  applyEdit?: (path: string, edit: OfficeEditRequest) => Promise<{ ok: boolean; message?: string } | null>

  /**
   * Draw a document's page in its own editor, and answer the PNG files written.
   *
   * `render` used to print the whole file to get one page out of it. A host that can open an editor
   * answers this instead — the same route a poster takes — and a host that cannot leaves it unset,
   * which is the command's cue to print the page as it always did.
   */
  /**
   * Draw an html file in a window nobody sees, and answer the PNG written.
   *
   * The app's own reading policy: a page that is only being *shown* does not run its scripts, so
   * what comes back is what a person would see in an `html-preview` block. Unset on a host with no
   * browser, and `shot` then says so.
   */
  /**
   * Draw a markdown file with the app's own renderer, and answer the PNG written.
   *
   * A `.md` has neither a page nor an editor: what draws it is the `<Markdown>` a reader sees, which
   * lives in the renderer process. Unset on a host with no renderer, and `shot` says so.
   */
  captureMarkdownShot?: (request: { path: string; width: number; height: number; outDir: string }) => Promise<string[]>

  captureWebShot?: (request: { path: string; width: number; height: number; outDir: string }) => Promise<string[]>

  capturePages?: (request: {
    path: string
    page: number
    outDir: string
    /** A workbook's corner: which sheet, and which cell at the top-left. */
    target?: { sheet?: string; range?: string }
  }) => Promise<string[]>
}

/** What a door's command body is handed once the command line has been read. */
export interface ToolCommandContext {
  fns: BrowserPaneFns
  sessionId: string
  workspaceRootPath?: string
  /** Injected by a test so a model call does not reach the network. */
  fetchImpl?: typeof fetch
  /** The workspace project this conversation is bound to, when the host knows it. */
  projectId?: string
  /** The session's own working directory — the project folder when the session is in one. */
  sessionWorkingDirectory?: string
  platform?: NodeJS.Platform
  /**
   * The tab `--tab` named, when the command named one.
   *
   * The option itself is taken off the command line (and used to target the conversation), so
   * this is the only place a body can see *which* tab was meant — which is what a command has to
   * name back to stop the thing it started (`record-stop --tab`).
   */
  tabId?: string
  /**
   * The profile `--profile` named, when the command named one.
   *
   * The raw spelling (`Work`, `bp-…`), and the `fns` handed to the body are already bound to that
   * profile — so a command never resolves it again, and a command that names none works in the
   * profile its conversation is set to.
   */
  profile?: string
  parts: string[]
  cmd: string
  /**
   * The command line as it was typed, with `--tab`/`--profile` taken out and nothing else touched.
   *
   * For a command whose argument is **source code**, and only for one: the tokens in `parts` have
   * been through shell quoting (quotes removed, `\n` decoded), which is right for a value and
   * wrong for a program. `evaluate` reads its expression from here.
   */
  rawCommand: string
}

/**
 * A command body: it answers the commands it owns and returns `null` for the rest.
 *
 * Returning `null` rather than throwing is what lets a door say "not mine" without deciding what
 * to say about it — that wording is the runner's, and it names the *other* tool, because the one
 * thing an agent gets wrong with two bare command tables is `browser_tool apply`.
 */
export type ToolCommandHandler = (
  ctx: ToolCommandContext,
) => Promise<BrowserCommandResult | null>

/** Everything a door has to say about itself. */
export interface ToolCommandSpec {
  /** Its `--help`, and what an empty command prints. */
  help: () => string
  /** Its commands. */
  run: ToolCommandHandler
  /** What to say about a command it does not handle — the message for an unknown command. */
  unknownCommand: (cmd: string) => string
}

/**
 * Build a door's single-command runner.
 *
 * The skeleton is the same on both sides and must stay the same — read the command line, `--help`,
 * target the tab a command names, hand the command to the door, say something useful when the door
 * does not take it — so it is written once and parameterized by the three things that differ.
 * Everything door-specific is a parameter, which is also what keeps this module from importing
 * either door.
 */
export function createCommandRunner(
  spec: ToolCommandSpec,
): (args: ToolCommandArgs) => Promise<BrowserCommandResult> {
  return async (args) => {
    // Array mode: use parts directly, no parsing needed. The two forms are read apart rather than
    // through one ternary, because what each one can answer differs (`span`s only exist for the
    // string form) and a narrowing lost is a `string | string[]` for the rest of the runner.
    const source = Array.isArray(args.command) ? '' : args.command.trim();
    const spans = Array.isArray(args.command) ? null : tokenizeCommandSpans(source);
    const raw = spans ? spans.map((span) => span.text) : [...args.command];
    // The global flags come off the line before any body sees it, and off its **text** here too:
    // a body that runs its argument as code has to be handed the line without them, or it would
    // execute `--tab tab-2` as part of the program (see `ToolCommandContext.rawCommand`).
    const flagTokens = new Set<number>();
    for (const flag of ['--tab', '--profile']) {
      const at = raw.indexOf(flag);
      if (at !== -1) {
        flagTokens.add(at);
        flagTokens.add(at + 1);
      }
    }
    const rawCommand = spans
      ? commandTextWithout(source, spans, flagTokens)
      : raw.filter((_token, index) => !flagTokens.has(index)).join(' ').trim();
    const withoutTab = extractTabTarget(raw);
    const { parts, profile } = extractProfileTarget(withoutTab.parts);
    const { tabId } = withoutTab;
    const cmd = parts[0]?.toLowerCase();

    if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
      return { output: spec.help(), appendReleaseHint: false };
    }

    // `--profile` binds the whole command to one profile: every method below resolves windows and
    // tabs against that profile instead of the profile the conversation is set to. The host owns
    // the registry, so it owns the resolution — a name this command has never heard of is refused
    // there, with the profiles that exist.
    const fns = profile ? args.fns.withProfile?.(profile) : args.fns;
    if (!fns) {
      // `profile` absent means the host itself has no browser runtime: the name in the message
      // has to be the runtime, not a flag the command never used.
      throw new Error(
        profile
          ? `--profile is not supported by this browser host (it cannot resolve "${profile}").`
          : "This door needs the app's browser runtime, and this host has none.",
      );
    }

    // Naming a tab targets it: it becomes the tab this conversation works from — so the rest
    // of the command, and the next one, and the one after the person clicks around, all stay
    // here. It does *not* bring the tab forward (第十二轮): the window is
    // shared with the person, who may be reading another one of its tabs, and a target is not
    // a request to move them. "tab-show <id>" is how a tab is deliberately brought up.
    // "navigate" takes the name itself: a tab that no longer exists is allocated anew
    // rather than failing the command (see `navigate`), so it must not be refused here.
    if (tabId && cmd !== 'navigate') await fns.targetTab(tabId);

    const ctx: ToolCommandContext = {
      fns,
      sessionId: args.sessionId,
      workspaceRootPath: args.workspaceRootPath,
      ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
      ...(args.projectId ? { projectId: args.projectId } : {}),
      ...(args.sessionWorkingDirectory ? { sessionWorkingDirectory: args.sessionWorkingDirectory } : {}),
      platform: args.platform,
      ...(tabId ? { tabId } : {}),
      ...(profile ? { profile } : {}),
      parts,
      cmd,
      rawCommand,
    };

    const result = await spec.run(ctx);
    if (result) return result;

    throw new Error(spec.unknownCommand(cmd));
  };
}
