/**
 * The CLI every pane tool shares.
 *
 * One command line over one capability surface (`BrowserPaneFns`), reached through several doors:
 * `browser_tool` for the window's own pages, `video_tool` for frames out of a recording,
 * `drawio_tool` for diagrams. What is *the same* on all of them lives here — tokenizing the command
 * string or array, `--tab` targeting, option and path resolution, the result shape, and the skeleton
 * of running one command.
 *
 * One more surface rides along, optional: a door that reads something with a model asks for it
 * (`video_tool understand`), and a door that does not never sees it. It is carried here rather than
 * closed over, because the command body is the thing that needs it and this module is what hands
 * the body its context.
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
import type { LlmQueryFn } from './llm-tool.ts';

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
 * Split a command string into tokens, honouring quotes and escapes.
 *
 * Shared because both doors take the same command line — `--tab <id>`, a quoted value with spaces
 * in it. The error names no tool: it is this parser's, whichever door the command came through.
 */
export function tokenizeCommand(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let tokenStarted = false;
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  const pushCurrent = () => {
    if (!tokenStarted) return;
    tokens.push(decodeEscapes(current));
    current = '';
    tokenStarted = false;
  };

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;

    if (escaped) {
      current += `\\${ch}`;
      tokenStarted = true;
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      escaped = true;
      continue;
    }

    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      tokenStarted = true;
      continue;
    }

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      tokenStarted = true;
      continue;
    }

    if (!inSingle && !inDouble && /\s/.test(ch)) {
      pushCurrent();
      continue;
    }

    current += ch;
    tokenStarted = true;
  }

  if (escaped) {
    current += '\\';
    tokenStarted = true;
  }

  if (inSingle || inDouble) {
    throw new Error('Parse error: unclosed quote in the command.');
  }

  pushCurrent();
  return tokens;
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
 * acting on the tab that happened to be on screen.
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

/** What a door is handed when one of its commands is run. */
export interface ToolCommandArgs {
  command: string | string[]
  fns: BrowserPaneFns
  sessionId: string
  platform?: NodeJS.Platform
  /** Where a relative `--file` path is counted from (the workspace root). */
  workspaceRootPath?: string
  /**
   * A model this door may ask, when it needs one.
   *
   * `video_tool understand` reads a recording by asking a vision model about its frames, so its
   * command body needs the same callback `call_llm` uses. Doors that never ask leave it out.
   */
  queryLlm?: LlmQueryFn
}

/** What a door's command body is handed once the command line has been read. */
export interface ToolCommandContext {
  fns: BrowserPaneFns
  sessionId: string
  workspaceRootPath?: string
  platform?: NodeJS.Platform
  queryLlm?: LlmQueryFn
  /**
   * The tab `--tab` named, when the command named one.
   *
   * The option itself is taken off the command line (and used to target the conversation), so
   * this is the only place a body can see *which* tab was meant — which is what a command has to
   * name back to stop the thing it started (`record-stop --tab`).
   */
  tabId?: string
  parts: string[]
  cmd: string
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
    // Array mode: use parts directly, no parsing needed
    const raw = Array.isArray(args.command)
      ? args.command
      : tokenizeCommand(args.command.trim());
    const { parts, tabId } = extractTabTarget(raw);
    const cmd = parts[0]?.toLowerCase();

    if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
      return { output: spec.help(), appendReleaseHint: false };
    }

    const { fns } = args;

    // Naming a tab targets it: it becomes the tab this conversation works from — so the rest
    // of the command, and the next one, and the one after the person clicks around, all stay
    // here. It does *not* bring the tab forward (第十二轮): the window is
    // shared with the person, who may be reading another one of its tabs, and a target is not
    // a request to move them. "tab-show <id>" is how a tab is deliberately brought up.
    if (tabId) await fns.targetTab(tabId);

    const ctx: ToolCommandContext = {
      fns,
      sessionId: args.sessionId,
      workspaceRootPath: args.workspaceRootPath,
      platform: args.platform,
      queryLlm: args.queryLlm,
      ...(tabId ? { tabId } : {}),
      parts,
      cmd,
    };

    const result = await spec.run(ctx);
    if (result) return result;

    throw new Error(spec.unknownCommand(cmd));
  };
}
