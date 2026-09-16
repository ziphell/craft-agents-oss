import type {
  BrowserConsoleArgs,
  BrowserDownloadsArgs,
  BrowserLifecycleActionResult,
  BrowserNetworkArgs,
  BrowserPaneFns,
  BrowserScreenshotRegionArgs,
  BrowserWaitArgs,
} from './browser-tools.ts';
import type { PrototypeWindowDescriptor } from '../prototypes/types.ts';
import type { PrototypePagesChange } from '../prototypes/pages.ts';

export interface BrowserCommandImage {
  data: string;
  mimeType: 'image/png' | 'image/jpeg';
  sizeBytes: number;
}

export interface BrowserCommandResult {
  output: string;
  appendReleaseHint: boolean;
  image?: BrowserCommandImage;
}

interface BrowserPageMetrics {
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

export function getBrowserToolHelp(): string {
  return [
    'browser_tool command help',
    '',
    'Usage:',
    '  --help',
    '  open [--foreground|-f]                         open browser (background by default)',
    '  navigate <url>',
    '  snapshot',
    '  find <query>                                   search elements by keyword (matches role, name, value)',
    '  click <ref> [none|navigation|network-idle] [timeoutMs]',
    '  click-at <x> <y>                               click at pixel coordinates (canvas elements)',
    '  drag <x1> <y1> <x2> <y2>                      drag from (x1,y1) to (x2,y2)',
    '  fill <ref> <value>',
    '  type <text>                                    type into focused element (no ref needed)',
    '  select <ref> <value> [--assert-text <text>] [--assert-value <value>] [--timeout <ms>]',
    '  upload <ref> <path> [path2...]                 attach local file(s) to a file input',
    '  set-clipboard <text>                           write text to page clipboard',
    '  get-clipboard                                  read clipboard text content',
    '  paste <text>                                   set clipboard + trigger Ctrl/Cmd+V',
    '  screenshot [--annotated|-a] [--png]            capture screenshot (JPEG default, --png for lossless)',
    '  screenshot-region <x> <y> <width> <height> [--png]',
    '  screenshot-region --ref <@eN> [--padding <px>] [--png]',
    '  screenshot-region --selector <css-selector> [--padding <px>] [--png]',
    '  console [limit] [level]',
    '  window-resize <width> <height>',
    '  network [limit] [status]',
    '  wait <selector|text|url|network-idle> <value?> [timeoutMs]',
    '  key <key> [modifiers]',
    '  downloads [list|wait] [limit|timeoutMs]',
    '  scroll <up|down|left|right> [amount]',
    '  back',
    '  forward',
    '  evaluate <expression>',
    '  pick [--timeout <ms>]                          ask the user to click an element; returns a stable selector',
    '  prototype-list                                 prototypes in this workspace, their pages, and which is bound',
    '  prototype-create <name> [--no-bind]            create a prototype (a container: it starts with no pages)',
    '  prototype-pages [slug] [--add <name>[=<url>]] [--rename <old>=<new>] [--remove <name>]',
    '                                                 the flow\'s pages, in order. <name>=<url> adds a live page;',
    '                                                 <name> alone places an existing document; --remove deletes a',
    '                                                 document of ours with its page',
    '  prototype-entry <name|none>                    which page the address root opens (none = the page index)',
    '  prototype-target <url> [--page <name>]        point one overlay page at another address',
    '                                                 (same page in another environment; say so, since the',
    '                                                 patches were written against the old one)',
    '  prototype-reference <slug> [--remove]          study another prototype (reference, not a copy)',
    '  prototype-bind <slug|--clear>                  bind (or unbind) this session\'s prototype',
    '  prototype-apply [slug]                         replay prototype patches (survives reload)',
    '  prototype-commit [slug] [--page <name>]        fold the delta layer into what owns it (irreversible)',
    '  prototype-clear [slug]                         remove prototype patches',
    '  prototype-export [slug]                        write dist/extension + dev spec',
    '  prototype-contract-compose [slug] [--service <svc>]   fragments → services/<svc>/openapi.yaml',
    '  prototype-contract-export [slug] [--service <svc>]    dist contract for the backend',
    '  prototype-mock-apply [slug] [--service <svc>]         serve x-mock responses (fetch + XHR)',
    '  prototype-mock-clear                                  stop serving the mock',
    '  prototype-status [slug]                               pages, patches, services, exports, ownership',
    '  prototype-open [slug] [--page <name>]                 open it (the page you are on, else entry, else index)',
    '  focus [windowId]                               focus existing browser window (no new window)',
    '  windows',
    '  release [windowId|all]                         dismiss agent overlay (user keeps browsing)',
    '  close [windowId]                               close & destroy the browser window',
    '  hide [windowId]                                hide the window (keeps state, "open" re-shows)',
    '',
    'Every prototype-* command except list/create/bind/reference defaults to the prototype this',
    'session is bound to, so no slug is needed. Pass one to target a different prototype.',
    'Use "prototype-list" for what exists, each one\'s pages, and how they reference each other.',
    'A page\'s name is its identity: "--page <name>" on the commands, "/<name>" on the address, and',
    '"patches/<name>/" for that page\'s own changes (patches/ at the root applies to every page).',
    '"prototype-entry <name|none>" decides what the address root opens; "/_index" always lists the pages.',
    'Full rules and examples: docs/browser-tools.md.',
    '',
    'Batching (string mode, semicolon-separated, stops after navigation commands):',
    '  fill @e1 user@example.com; fill @e2 password123; click @e3',
    '',
    'Array mode (JSON array input, no batch splitting/tokenization):',
    '  ["evaluate", "var x = 1; var y = 2; x + y"]',
    '  ["paste", "Name\\tAge\\nAlice\\t30"]',
    '',
    'Examples:',
    '  navigate https://example.com',
    '  click @e12',
    '  click-at 350 200',
    '  drag 100 200 300 400',
    '  fill @e5 user@example.com',
    '  type Hello World',
    '  upload @e3 /path/to/file.pdf',
    '  set-clipboard Name\\tAge\\nAlice\\t30',
    '  get-clipboard',
    '  paste Name\\tAge\\nAlice\\t30',
    '  scroll down 800',
    '  evaluate document.title',
    '  pick',
    '  prototype-list',
    '  prototype-create Landing page                  (a container for pages; write cart.html and that is the first)',
    '  prototype-create Rival checkout --no-bind',
    '  prototype-pages --add payment=https://app.example.com/pay   (a live page, in flow order)',
    '  prototype-pages --add cart                     (place an existing cart.html in the flow)',
    '  prototype-entry cart                           (the address root opens cart from now on)',
    '  prototype-target https://staging.example.com/checkout --page cart   (one page, another environment)',
    '  prototype-reference rival-checkout            (study it from the bound prototype)',
    '  prototype-apply                                (targets the bound prototype)',
    '  prototype-open checkout-flow --page orders      (one page of a multi-page prototype)',
    '  prototype-apply checkout-flow                  (explicit target)',
    '  prototype-commit                               (fold what is done; the patch files go away)',
    '  prototype-commit --page cart                   (fold one page of ours only)',
    '  prototype-contract-compose --service checkout-api',
    '  screenshot --annotated',
    '  screenshot --png',
    '  screenshot-region --ref @e9 --padding 12',
    '  screenshot-region --selector div[data-testid="chart"]',
    '  console 100 warn',
    '  window-resize 1280 720',
    '  network 50 failed',
    '  wait network-idle 8000',
    '  key Enter',
    '  downloads wait 15000',
    '  focus',
    '  focus browser-1',
    '  windows',
  ].join('\n');
}

function formatNodeLine(
  node: {
    ref: string;
    role: string;
    name: string;
    value?: string;
    description?: string;
    focused?: boolean;
    checked?: boolean;
    disabled?: boolean;
  },
  options?: { includeState?: boolean },
): string {
  let line = `  ${node.ref} [${node.role}] "${node.name}"`;
  if (node.value !== undefined) line += ` value="${node.value}"`;
  if (options?.includeState !== false) {
    if (node.focused) line += ' (focused)';
    if (node.checked) line += ' (checked)';
    if (node.disabled) line += ' (disabled)';
  }
  if (node.description) line += ` — ${node.description}`;
  return line;
}

function formatBytes(bytes: number): string {
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

function formatPercent(numerator: number, denominator: number): string {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return '0.0%';
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function shortText(text: string, max = 160): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}…`;
}

function statusBucket(status: number): '2xx' | '3xx' | '4xx' | '5xx' | 'other' {
  if (status >= 200 && status < 300) return '2xx';
  if (status >= 300 && status < 400) return '3xx';
  if (status >= 400 && status < 500) return '4xx';
  if (status >= 500 && status < 600) return '5xx';
  return 'other';
}

async function safeEvaluate<T>(fns: BrowserPaneFns, expression: string): Promise<T | null> {
  try {
    const value = await fns.evaluate(expression);
    return value as T;
  } catch {
    return null;
  }
}

async function getPageMetrics(fns: BrowserPaneFns): Promise<BrowserPageMetrics | null> {
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

function describeActive(metrics: BrowserPageMetrics | null): string {
  if (!metrics) return 'unknown';
  const tag = metrics.activeElementTag || 'unknown';
  const id = metrics.activeElementId ? `#${metrics.activeElementId}` : '';
  const role = metrics.activeElementRole ? ` role=${metrics.activeElementRole}` : '';
  const name = metrics.activeElementName ? ` "${shortText(metrics.activeElementName, 60)}"` : '';
  return `${tag}${id}${role}${name}`;
}

const ACTIONABLE_AX_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'checkbox',
  'radio',
  'switch',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'option',
  'slider',
  'spinbutton',
  'listbox',
]);

function countActionableNodes(nodes: Array<{ role: string; disabled?: boolean }>): number {
  return nodes.filter((node) => ACTIONABLE_AX_ROLES.has((node.role || '').toLowerCase()) && !node.disabled).length;
}

function summarizeWindows(windows: Awaited<ReturnType<BrowserPaneFns['listWindows']>>): string {
  const visible = windows.filter((w) => w.isVisible).length;
  const locked = windows.filter((w) => !!w.boundSessionId).length;
  const withOverlay = windows.filter((w) => !!w.agentControlActive).length;
  return `total=${windows.length}, visible=${visible}, locked=${locked}, overlays=${withOverlay}`;
}

/** `checkout-flow — page "orders" (overlay), its own address http://…`: which prototype, which screen, where it lives. */
function describePrototypeAt(prototype: PrototypeWindowDescriptor): string {
  const page = prototype.page
    ? ` — page "${prototype.page}"${prototype.kind ? ` (${prototype.kind})` : ''}`
    : ' — the page index';
  const origin = prototype.origin ? `, its own address ${prototype.origin}` : '';
  return `${prototype.slug}${page}${origin}`;
}

/**
 * The prototype a window is showing, and what that means for the next move.
 *
 * Both addresses are stated because they are two different facts: the `URL` above
 * is the page on screen, this is where the prototype itself lives — for an overlay
 * page they are different addresses, for a page of ours they are the same one.
 * The kind is the decisive part: a document of ours is changed by editing files, an
 * overlay page belongs to a real site and is only ever patched. Without this the
 * agent is looking at an address and guessing.
 */
function describeSnapshotPrototype(
  prototype: PrototypeWindowDescriptor | null | undefined,
): string[] {
  if (!prototype) return [];
  return [
    `Prototype: ${describePrototypeAt(prototype)}`,
    prototype.kind === 'overlay'
      ? "  (the page above is the live site's own page, with this prototype's patches injected — patch it, never edit it in place)"
      : prototype.kind === 'scratch'
        ? '  (the document above is ours: that file rendered with its patches applied — changed by editing files)'
        : "  (the window is on the prototype's own address but not on one of its pages — the page index, or a path the table does not describe)",
  ];
}

function getOpenVisibilitySettleTimeoutMs(override?: number): number {
  if (typeof override === 'number' && Number.isFinite(override)) {
    return Math.max(100, override);
  }
  const envValue = Number(process.env.CRAFT_BROWSER_OPEN_SETTLE_TIMEOUT_MS);
  if (Number.isFinite(envValue) && envValue > 0) {
    return Math.max(100, envValue);
  }
  return 1500;
}

function getOpenVisibilitySettlePollMs(override?: number): number {
  if (typeof override === 'number' && Number.isFinite(override)) {
    return Math.max(25, override);
  }
  const envValue = Number(process.env.CRAFT_BROWSER_OPEN_SETTLE_POLL_MS);
  if (Number.isFinite(envValue) && envValue > 0) {
    return Math.max(25, envValue);
  }
  return 100;
}

async function waitForForegroundOpenVisibility(args: {
  fns: BrowserPaneFns;
  instanceId: string;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<{
  windows: Awaited<ReturnType<BrowserPaneFns['listWindows']>>;
  win: Awaited<ReturnType<BrowserPaneFns['listWindows']>>[number] | undefined;
  settledByWait: boolean;
  usedFocusFallback: boolean;
}> {
  const timeoutMs = getOpenVisibilitySettleTimeoutMs(args.timeoutMs);
  const pollMs = getOpenVisibilitySettlePollMs(args.pollMs);
  const started = Date.now();

  const readWindowState = async () => {
    const windows = await args.fns.listWindows();
    const win = windows.find((w) => w.id === args.instanceId);
    return { windows, win };
  };

  let state = await readWindowState();
  while (Date.now() - started < timeoutMs) {
    if (!state.win || state.win.isVisible) {
      return {
        ...state,
        settledByWait: true,
        usedFocusFallback: false,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    state = await readWindowState();
  }

  let usedFocusFallback = false;
  if (state.win && !state.win.isVisible) {
    try {
      await args.fns.focusWindow(args.instanceId);
      usedFocusFallback = true;
      state = await readWindowState();
    } catch {
      // Keep existing state if focus fallback fails; caller output will surface visibility.
    }
  }

  return {
    ...state,
    settledByWait: false,
    usedFocusFallback,
  };
}

function formatLifecycleResultLine(result: BrowserLifecycleActionResult): string {
  if (result.action === 'noop') {
    return [
      'No window state changed.',
      result.reason ? `Reason: ${result.reason}` : undefined,
      result.requestedInstanceId ? `Requested window: ${result.requestedInstanceId}` : undefined,
    ].filter(Boolean).join(' ');
  }

  const affected = result.affectedIds.length > 0 ? result.affectedIds.join(', ') : 'none';
  const resolved = result.resolvedInstanceId ?? 'none';
  return [
    `Action: ${result.action}`,
    `resolved=${resolved}`,
    `affected=[${affected}]`,
    result.requestedInstanceId ? `requested=${result.requestedInstanceId}` : undefined,
  ].filter(Boolean).join(', ');
}

const NAVIGATION_COMMANDS = new Set([
  'navigate',
  'click',
  'back',
  'forward',
]);

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

function splitBatchCommands(input: string): string[] {
  const commands: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      current += ch;
      escaped = true;
      continue;
    }

    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      continue;
    }

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      continue;
    }

    if (ch === ';' && !inSingle && !inDouble) {
      const trimmed = current.trim();
      if (trimmed.length > 0) commands.push(trimmed);
      current = '';
      continue;
    }

    current += ch;
  }

  if (escaped) {
    current += '\\';
  }

  if (inSingle || inDouble) {
    throw new Error('Parse error: unclosed quote in browser_tool command.');
  }

  const trimmed = current.trim();
  if (trimmed.length > 0) commands.push(trimmed);
  return commands;
}

function tokenizeCommand(input: string): string[] {
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
    throw new Error('Parse error: unclosed quote in browser_tool command.');
  }

  pushCurrent();
  return tokens;
}

interface ParsedSelectCommand {
  ref: string;
  value: string;
  assertText?: string;
  assertValue?: string;
  timeoutMs: number;
}

function parseSelectCommand(parts: string[]): ParsedSelectCommand {
  const ref = parts[1];
  if (!ref) throw new Error('select requires ref and value. Example: select @e3 optionValue');

  const tokens = parts.slice(2);
  const valueTokens: string[] = [];
  let assertText: string | undefined;
  let assertValue: string | undefined;
  let timeoutMs = 2000;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token === '--assert-text') {
      const next = tokens[i + 1];
      if (!next) throw new Error('select --assert-text requires a value. Example: select @e3 CNAME --assert-text Target');
      assertText = next;
      i += 1;
      continue;
    }
    if (token === '--assert-value') {
      const next = tokens[i + 1];
      if (!next) throw new Error('select --assert-value requires a value. Example: select @e3 CNAME --assert-value CNAME');
      assertValue = next;
      i += 1;
      continue;
    }
    if (token === '--timeout') {
      const next = tokens[i + 1];
      if (!next) throw new Error('select --timeout requires milliseconds. Example: select @e3 CNAME --timeout 3000');
      const parsed = Number(next);
      if (Number.isNaN(parsed)) throw new Error(`Invalid select timeout "${next}". Expected a number.`);
      timeoutMs = Math.max(100, parsed);
      i += 1;
      continue;
    }
    valueTokens.push(token);
  }

  const value = valueTokens.join(' ').trim();
  if (!value) throw new Error('select requires ref and value. Example: select @e3 optionValue');

  return { ref, value, assertText, assertValue, timeoutMs };
}

function includesNormalized(haystack: string | undefined, needle: string): boolean {
  const h = (haystack ?? '').trim().toLowerCase();
  const n = needle.trim().toLowerCase();
  if (!h || !n) return false;
  return h.includes(n);
}

async function verifySelectResult(args: {
  fns: BrowserPaneFns;
  ref: string;
  selectedValue: string;
  assertText?: string;
  assertValue?: string;
  timeoutMs: number;
}): Promise<{
  selectedRefMatched: boolean;
  assertTextMatched: boolean;
  assertValueMatched: boolean;
  elapsedMs: number;
}> {
  const { fns, ref, selectedValue, assertText, assertValue, timeoutMs } = args;
  const started = Date.now();
  const pollMs = 120;

  let selectedRefMatched = false;
  let assertTextMatched = false;
  let assertValueMatched = false;

  while (Date.now() - started <= timeoutMs) {
    const snapshot = await fns.snapshot();
    const selectedNode = snapshot.nodes.find((n) => n.ref === ref);

    selectedRefMatched = !!selectedNode
      && (
        includesNormalized(selectedNode.value, selectedValue)
        || includesNormalized(selectedNode.name, selectedValue)
      );

    if (assertText) {
      assertTextMatched = snapshot.nodes.some((n) =>
        includesNormalized(n.name, assertText)
        || includesNormalized(n.value, assertText)
        || includesNormalized(n.description, assertText)
      );
    } else {
      assertTextMatched = true;
    }

    if (assertValue) {
      const selectedNodeMatches = !!selectedNode
        && (
          includesNormalized(selectedNode.value, assertValue)
          || includesNormalized(selectedNode.name, assertValue)
          || includesNormalized(selectedNode.description, assertValue)
        );

      const anyNodeMatches = snapshot.nodes.some((n) =>
        includesNormalized(n.value, assertValue)
        || includesNormalized(n.name, assertValue)
        || includesNormalized(n.description, assertValue)
      );

      assertValueMatched = selectedNodeMatches || anyNodeMatches;
    } else {
      assertValueMatched = true;
    }

    const strongMatch = selectedRefMatched || assertValueMatched;
    const assertionsOk = assertTextMatched && assertValueMatched;
    if (strongMatch && assertionsOk) {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  return {
    selectedRefMatched,
    assertTextMatched,
    assertValueMatched,
    elapsedMs: Date.now() - started,
  };
}


export async function executeBrowserToolCommand(args: {
  command: string | string[];
  fns: BrowserPaneFns;
  sessionId: string;
  platform?: NodeJS.Platform;
}): Promise<BrowserCommandResult> {
  // Array mode: no batch splitting, pass directly to single command execution
  if (Array.isArray(args.command)) {
    if (args.command.length === 0) {
      throw new Error('Missing command. Use "--help" to see supported browser_tool commands.');
    }
    return executeSingleCommand(args);
  }

  // String mode: existing behavior unchanged
  const trimmed = args.command.trim();
  if (!trimmed) {
    throw new Error('Missing command. Use "--help" to see supported browser_tool commands.');
  }

  const commands = splitBatchCommands(trimmed);
  if (commands.length > 1) {
    return executeBatchCommands({ ...args, commands });
  }

  return executeSingleCommand(args);
}

async function executeBatchCommands(args: {
  commands: string[];
  fns: BrowserPaneFns;
  sessionId: string;
  platform?: NodeJS.Platform;
}): Promise<BrowserCommandResult> {
  const outputs: string[] = [];
  let lastImage: BrowserCommandImage | undefined;
  let appendReleaseHint = false;

  for (let i = 0; i < args.commands.length; i++) {
    const command = args.commands[i]!;
    const result = await executeSingleCommand({ ...args, command });

    outputs.push(result.output);
    if (result.image) lastImage = result.image;
    if (result.appendReleaseHint) appendReleaseHint = true;

    const batchCmd = tokenizeCommand(command)[0]?.toLowerCase();
    if (batchCmd && NAVIGATION_COMMANDS.has(batchCmd) && i < args.commands.length - 1) {
      outputs.push(`(stopped batch after "${batchCmd}" — page may have changed, re-snapshot before continuing)`);
      break;
    }
  }

  return {
    output: outputs.join('\n'),
    appendReleaseHint,
    image: lastImage,
  };
}

/** Read a numeric option (`--interval 200`), bounded, falling back to a default. */
function numberOption(parts: string[], flag: string, fallback: number, min: number, max: number): number {
  const value = Number(parts[parts.indexOf(flag) + 1]);
  if (parts.indexOf(flag) === -1 || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Read a ratio option, accepting `2%` and `0.02` alike. */
function ratioOption(parts: string[], flag: string, fallback: number): number {
  const at = parts.indexOf(flag);
  if (at === -1) return fallback;
  const raw = (parts[at + 1] ?? '').trim();
  const value = raw.endsWith('%') ? Number(raw.slice(0, -1)) / 100 : Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(1, value);
}

/** Read a duration option (`--every 2s`, `--every 500ms`, `--every 2`), in ms. */
function durationOption(parts: string[], flag: string, fallbackMs: number): number {
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
 * Resolve which prototype a command targets.
 *
 * An explicit slug always wins, so a bound session can still reach a different
 * prototype for a one-off. Only when no argument is given do we fall back to the
 * session's binding — that fallback is the point of binding, and when there is
 * neither, the error names both ways out.
 *
 * A leading `--` is treated as "no slug" so that flags can follow the command
 * directly (`prototype-contract-compose --service checkout-api`).
 */
function resolvePrototypeSlug(fns: BrowserPaneFns, parts: string[], command: string): string {
  const explicit = parts[1];
  if (explicit && !explicit.startsWith('--')) return explicit;

  const bound = fns.getBoundPrototypeSlug?.();
  if (bound) return bound;

  throw new Error(
    `${command} needs a prototype. Pass one — "${command} <slug>" — or bind this session with ` +
    `"prototype-bind <slug>". "prototype-list" shows what exists.`,
  );
}

async function executeSingleCommand(args: {
  command: string | string[];
  fns: BrowserPaneFns;
  sessionId: string;
  platform?: NodeJS.Platform;
}): Promise<BrowserCommandResult> {
  // Array mode: use parts directly, no parsing needed
  const parts = Array.isArray(args.command)
    ? args.command
    : tokenizeCommand(args.command.trim());
  const cmd = parts[0]?.toLowerCase();

  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    return { output: getBrowserToolHelp(), appendReleaseHint: false };
  }

  const { fns } = args;

  if (cmd === 'open') {
    const foreground = parts.includes('--foreground') || parts.includes('-f');
    const windowsBefore = await fns.listWindows();
    const result = await fns.openPanel({ background: !foreground });

    let windowsAfter = await fns.listWindows();
    let win = windowsAfter.find((w) => w.id === result.instanceId);
    let settledByWait = true;
    let usedFocusFallback = false;

    if (foreground) {
      const visibilityResult = await waitForForegroundOpenVisibility({
        fns,
        instanceId: result.instanceId,
      });
      windowsAfter = visibilityResult.windows;
      win = visibilityResult.win;
      settledByWait = visibilityResult.settledByWait;
      usedFocusFallback = visibilityResult.usedFocusFallback;
    }

    const reused = windowsBefore.some((w) => w.id === result.instanceId);
    const mode = foreground ? 'foreground' : 'background';

    const lines = [
      `Opened in-app browser window in ${mode} (instance: ${result.instanceId})`,
      `Window state: ${reused ? 'reused existing window' : 'created new window'}`,
      `Session windows: ${summarizeWindows(windowsAfter)}`,
    ];
    if (foreground) {
      lines.push(`Visibility settle: ${settledByWait ? 'wait-loop' : 'timeout'}${usedFocusFallback ? ' + focus retry' : ''}`);
    }
    if (win) {
      lines.push(
        `Visible: ${win.isVisible}, ownerType: ${win.ownerType}, boundSessionId: ${win.boundSessionId ?? 'none'}`,
      );
    }

    return { output: lines.join('\n'), appendReleaseHint: true };
  }

  if (cmd === 'navigate') {
    const url = parts.slice(1).join(' ').trim();
    if (!url) throw new Error('navigate requires a URL. Example: navigate https://example.com');

    const before = await getPageMetrics(fns);
    const started = Date.now();
    const result = await fns.navigate(url);
    const elapsedMs = Date.now() - started;
    const after = await getPageMetrics(fns);
    const failed = await fns.getNetworkLogs({ limit: 200, status: 'failed' });

    // Check for security challenge after navigation
    const challenge = await fns.detectChallenge();
    if (challenge.detected) {
      await fns.releaseControl();
      return {
        output: [
          `Security verification detected (${challenge.provider}).`,
          `Signals: ${challenge.signals.join(', ')}`,
          `URL: ${result.url}`,
          '',
          'Browser shown — please complete the verification check.',
          'After verification, run "snapshot" to continue.',
        ].join('\n'),
        appendReleaseHint: false,
      };
    }

    const lines = [
      `Navigated to: ${result.url}`,
      `Title: ${result.title}`,
      `Elapsed: ${elapsedMs}ms`,
      `URL changed: ${before ? before.url !== result.url : 'unknown'}`,
      `Recent failed requests: ${failed.length}`,
    ];
    if (after) {
      lines.push(`Viewport: ${after.viewportWidth}x${after.viewportHeight}, scroll=(${after.scrollX}, ${after.scrollY})`);
    }

    return { output: lines.join('\n'), appendReleaseHint: true };
  }

  if (cmd === 'snapshot') {
    const snapshot = await fns.snapshot();
    const roles = new Map<string, number>();
    let focusedRef: string | null = null;
    let disabledCount = 0;
    for (const node of snapshot.nodes) {
      roles.set(node.role, (roles.get(node.role) ?? 0) + 1);
      if (node.focused && !focusedRef) focusedRef = node.ref;
      if (node.disabled) disabledCount += 1;
    }

    const roleSummary = Array.from(roles.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([role, count]) => `${role}:${count}`)
      .join(', ');

    const lines: string[] = [
      `URL: ${snapshot.url}`,
      `Title: ${snapshot.title}`,
      ...describeSnapshotPrototype(snapshot.prototype),
      `Elements: ${snapshot.nodes.length}${roleSummary ? ` (${roleSummary})` : ''}`,
      `Focused ref: ${focusedRef ?? 'none'}, disabled: ${disabledCount}`,
      '',
      `Elements (${snapshot.nodes.length}):`,
    ];
    for (const node of snapshot.nodes) {
      lines.push(formatNodeLine(node));
    }

    const actionableCount = countActionableNodes(snapshot.nodes);
    const nearEmpty = snapshot.nodes.length === 0 || actionableCount <= 2;

    if (nearEmpty) {
      // Check if sparse/empty snapshot is caused by a security challenge
      const challenge = await fns.detectChallenge();
      if (challenge.detected) {
        await fns.releaseControl();

        // Auto-take screenshot for visual confirmation
        let screenshotImage: BrowserCommandImage | undefined;
        try {
          const screenshotResult = await fns.screenshot({ format: 'jpeg' });
          const buf = screenshotResult.imageBuffer;
          if (buf && buf.length > 0) {
            screenshotImage = {
              data: buf.toString('base64'),
              mimeType: 'image/jpeg',
              sizeBytes: buf.length,
            };
          }
        } catch {
          // Screenshot failure shouldn't block the challenge warning
        }

        const challengeLines = [
          `Security verification detected (${challenge.provider}).`,
          `Signals: ${challenge.signals.join(', ')}`,
          `URL: ${snapshot.url}`,
          ...describeSnapshotPrototype(snapshot.prototype),
          '',
          `Detected only ${actionableCount} actionable element(s) out of ${snapshot.nodes.length} accessibility nodes.`,
          'This is consistent with a security challenge page blocking normal interaction.',
          'Browser shown — please complete the verification check.',
          'After verification, run "snapshot" to continue.',
        ];

        return {
          output: challengeLines.join('\n'),
          appendReleaseHint: false,
          image: screenshotImage,
        };
      }

      if (snapshot.nodes.length === 0) {
        lines.push('');
        lines.push('No accessibility elements were detected on this view.');
        lines.push('This can happen on canvas-heavy/custom UIs. Try: evaluate <js>, click-at <x> <y>, type <text>, screenshot --annotated.');
      }
    }

    return { output: lines.join('\n'), appendReleaseHint: true };
  }

  if (cmd === 'find') {
    const query = parts.slice(1).join(' ').trim();
    if (!query) throw new Error('find requires a search query. Example: find login button');

    const snapshot = await fns.snapshot();
    const queryLower = query.toLowerCase();
    const keywords = queryLower.split(/\s+/).filter(Boolean);

    const scored = snapshot.nodes
      .map((node) => {
        const haystack = [node.role, node.name, node.value, node.description]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!keywords.every((kw) => haystack.includes(kw))) return null;
        let score = 0;
        for (const kw of keywords) {
          if ((node.name ?? '').toLowerCase().includes(kw)) score += 3;
          if ((node.role ?? '').toLowerCase().includes(kw)) score += 2;
          if ((node.value ?? '').toLowerCase().includes(kw)) score += 1;
          if ((node.description ?? '').toLowerCase().includes(kw)) score += 1;
        }
        return { node, score };
      })
      .filter((x): x is { node: typeof snapshot.nodes[number]; score: number } => !!x)
      .sort((a, b) => b.score - a.score);

    if (scored.length === 0) {
      return {
        output: `No elements found matching "${query}" (searched ${snapshot.nodes.length} elements).\nTry a broader search or run "snapshot" to see all elements.`,
        appendReleaseHint: true,
      };
    }

    const lines: string[] = [
      `Found ${scored.length} element(s) matching "${query}" from ${snapshot.nodes.length} scanned elements:`,
    ];
    for (const { node, score } of scored.slice(0, 20)) {
      lines.push(`${formatNodeLine(node, { includeState: false })} (score=${score})`);
    }
    if (scored.length > 20) {
      lines.push(`  ... and ${scored.length - 20} more. Narrow your search.`);
    }
    return { output: lines.join('\n'), appendReleaseHint: true };
  }

  if (cmd === 'click') {
    const ref = parts[1];
    if (!ref) throw new Error('click requires a ref. Example: click @e1');
    const waitForRaw = parts[2] as 'none' | 'navigation' | 'network-idle' | undefined;
    const timeoutRaw = parts[3];
    const waitFor = waitForRaw && ['none', 'navigation', 'network-idle'].includes(waitForRaw)
      ? waitForRaw
      : undefined;
    if (waitForRaw && !waitFor) {
      throw new Error('click waitFor must be one of: none, navigation, network-idle');
    }
    const timeoutMs = timeoutRaw ? Number(timeoutRaw) : undefined;
    if (timeoutRaw && Number.isNaN(timeoutMs)) {
      throw new Error(`Invalid click timeout "${timeoutRaw}". Expected a number.`);
    }

    const before = await getPageMetrics(fns);
    const started = Date.now();
    await fns.click(ref, { waitFor, timeoutMs });
    const elapsedMs = Date.now() - started;
    const after = await getPageMetrics(fns);

    const urlChanged = before && after ? before.url !== after.url : false;

    // Check challenge after click regardless of URL change (same-URL challenges are common)
    const challenge = await fns.detectChallenge();
    if (challenge.detected) {
      await fns.releaseControl();
      return {
        output: [
          `Clicked element ${ref} — security challenge detected (${challenge.provider}).`,
          `URL changed: ${urlChanged}`,
          `Signals: ${challenge.signals.join(', ')}`,
          '',
          'Browser shown — please complete the verification check.',
          'After verification, run "snapshot" to continue.',
        ].join('\n'),
        appendReleaseHint: false,
      };
    }

    const lines = [
      `Clicked element ${ref}${waitFor ? ` (waitFor=${waitFor})` : ''}`,
      `Elapsed: ${elapsedMs}ms`,
      `URL changed: ${urlChanged}`,
      `Active element: ${describeActive(after)}`,
    ];
    if (before && after) {
      lines.push(`Scroll Y: ${Math.round(before.scrollY)} → ${Math.round(after.scrollY)}`);
    }

    return { output: lines.join('\n'), appendReleaseHint: true };
  }

  if (cmd === 'click-at') {
    const xRaw = parts[1];
    const yRaw = parts[2];
    if (!xRaw || !yRaw) throw new Error('click-at requires x and y coordinates. Example: click-at 350 200');
    const x = Number(xRaw);
    const y = Number(yRaw);
    if (Number.isNaN(x) || Number.isNaN(y)) {
      throw new Error('click-at coordinates must be numbers. Example: click-at 350 200');
    }

    const before = await getPageMetrics(fns);
    const started = Date.now();
    await fns.clickAt(x, y);
    const elapsedMs = Date.now() - started;
    const after = await getPageMetrics(fns);

    const lines = [
      `Clicked at coordinates (${x}, ${y})`,
      `Elapsed: ${elapsedMs}ms`,
      `Within viewport: ${before ? x >= 0 && y >= 0 && x <= before.viewportWidth && y <= before.viewportHeight : 'unknown'}`,
      `Active element: ${describeActive(after)}`,
    ];
    if (before && after) {
      lines.push(`Scroll Y: ${Math.round(before.scrollY)} → ${Math.round(after.scrollY)}`);
    }

    return { output: lines.join('\n'), appendReleaseHint: true };
  }

  if (cmd === 'drag') {
    const x1Raw = parts[1];
    const y1Raw = parts[2];
    const x2Raw = parts[3];
    const y2Raw = parts[4];
    if (!x1Raw || !y1Raw || !x2Raw || !y2Raw) {
      throw new Error('drag requires 4 coordinates: x1 y1 x2 y2. Example: drag 100 200 300 400');
    }
    const x1 = Number(x1Raw);
    const y1 = Number(y1Raw);
    const x2 = Number(x2Raw);
    const y2 = Number(y2Raw);
    if (Number.isNaN(x1) || Number.isNaN(y1) || Number.isNaN(x2) || Number.isNaN(y2)) {
      throw new Error('drag coordinates must be numbers. Example: drag 100 200 300 400');
    }

    const before = await getPageMetrics(fns);
    const started = Date.now();
    await fns.drag(x1, y1, x2, y2);
    const elapsedMs = Date.now() - started;
    const after = await getPageMetrics(fns);

    const distance = Math.round(Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2));
    const lines = [
      `Dragged from (${x1}, ${y1}) to (${x2}, ${y2})`,
      `Distance: ${distance}px`,
      `Elapsed: ${elapsedMs}ms`,
      `Active element: ${describeActive(after)}`,
    ];
    if (before && after) {
      lines.push(`Scroll Y: ${Math.round(before.scrollY)} → ${Math.round(after.scrollY)}`);
    }

    return { output: lines.join('\n'), appendReleaseHint: true };
  }

  if (cmd === 'fill') {
    const ref = parts[1];
    const value = parts.slice(2).join(' ');
    if (!ref || value === undefined) throw new Error('fill requires ref and value. Example: fill @e5 hello world');

    const before = await getPageMetrics(fns);
    await fns.fill(ref, value);
    const after = await getPageMetrics(fns);

    return {
      output: [
        `Filled element ${ref} with "${value}"`,
        `Value length: ${value.length} characters`,
        `Active element before: ${describeActive(before)}`,
        `Active element after: ${describeActive(after)}`,
      ].join('\n'),
      appendReleaseHint: true,
    };
  }

  if (cmd === 'type') {
    const text = parts.slice(1).join(' ');
    if (!text) throw new Error('type requires text. Example: type Hello World');

    const before = await getPageMetrics(fns);
    await fns.type(text);
    const after = await getPageMetrics(fns);

    return {
      output: [
        `Typed ${text.length} characters into focused element`,
        `Active element before: ${describeActive(before)}`,
        `Active element after: ${describeActive(after)}`,
      ].join('\n'),
      appendReleaseHint: true,
    };
  }

  if (cmd === 'select') {
    const parsed = parseSelectCommand(parts);
    const { ref, value, assertText, assertValue, timeoutMs } = parsed;

    await fns.select(ref, value);
    const after = await getPageMetrics(fns);
    const verification = await verifySelectResult({
      fns,
      ref,
      selectedValue: value,
      assertText,
      assertValue,
      timeoutMs,
    });

    const warnings: string[] = [];
    if (!verification.selectedRefMatched) {
      warnings.push('selected control did not reflect requested value in accessibility snapshot');
    }
    if (assertText && !verification.assertTextMatched) {
      warnings.push(`assert-text did not match: "${assertText}"`);
    }
    if (assertValue && !verification.assertValueMatched) {
      warnings.push(`assert-value did not match: "${assertValue}"`);
    }

    const verificationStatus = warnings.length === 0 ? 'verified' : 'warning';

    return {
      output: [
        `Selected "${value}" in element ${ref} (${verificationStatus})`,
        `Verification: selectedRefMatched=${verification.selectedRefMatched}, assertTextMatched=${verification.assertTextMatched}, assertValueMatched=${verification.assertValueMatched}`,
        `Verification time: ${verification.elapsedMs}ms (timeout=${timeoutMs}ms)`,
        ...(warnings.length > 0
          ? [
            `Warning: select interaction succeeded but effective form state could not be fully verified.`,
            ...warnings.map((warning) => `- ${warning}`),
            'Tip: retry with --assert-text and/or --assert-value targeting downstream field changes.',
          ]
          : []),
        `Value length: ${value.length} characters`,
        `Active element after: ${describeActive(after)}`,
      ].join('\n'),
      appendReleaseHint: true,
    };
  }

  if (cmd === 'upload') {
    const ref = parts[1];
    const filePaths = parts.slice(2);
    if (!ref || filePaths.length === 0) {
      throw new Error('upload requires ref and file path(s). Example: upload @e3 /path/to/file.pdf');
    }

    await fns.upload(ref, filePaths);
    const after = await getPageMetrics(fns);
    const fileList = filePaths.length === 1
      ? filePaths[0]
      : `${filePaths.length} files:\n${filePaths.map((p) => `  - ${p}`).join('\n')}`;

    return {
      output: [
        `Uploaded ${fileList} to element ${ref}`,
        `Active element after: ${describeActive(after)}`,
      ].join('\n'),
      appendReleaseHint: true,
    };
  }

  if (cmd === 'set-clipboard') {
    const text = parts.slice(1).join(' ');
    if (!text) throw new Error('set-clipboard requires text. Example: set-clipboard Hello World');
    await fns.setClipboard(text);

    const lineCount = text.length === 0 ? 0 : text.split(/\r?\n/).length;
    const tabCount = (text.match(/\t/g) ?? []).length;

    return {
      output: [
        `Clipboard set (${text.length} characters)`,
        `Lines: ${lineCount}, tabs: ${tabCount}`,
      ].join('\n'),
      appendReleaseHint: true,
    };
  }

  if (cmd === 'get-clipboard') {
    const text = await fns.getClipboard();
    if (!text) {
      return { output: '(empty clipboard)', appendReleaseHint: true };
    }

    const lineCount = text.split(/\r?\n/).length;
    const tabCount = (text.match(/\t/g) ?? []).length;
    const preview = text.length > 800 ? `${text.slice(0, 800)}\n... (truncated preview)` : text;

    return {
      output: [
        `Clipboard content (${text.length} chars, ${lineCount} lines, ${tabCount} tabs):`,
        preview,
      ].join('\n'),
      appendReleaseHint: true,
    };
  }

  if (cmd === 'paste') {
    const text = parts.slice(1).join(' ');
    if (!text) throw new Error('paste requires text. Example: paste Hello World');
    await fns.setClipboard(text);
    const platform = args.platform ?? process.platform;
    const isMac = platform === 'darwin';
    await fns.sendKey({ key: 'v', modifiers: [isMac ? 'meta' : 'control'] });

    const lineCount = text.length === 0 ? 0 : text.split(/\r?\n/).length;
    const tabCount = (text.match(/\t/g) ?? []).length;

    return {
      output: [
        `Pasted ${text.length} characters`,
        `Shortcut used: ${isMac ? 'Cmd+V' : 'Ctrl+V'}`,
        `Lines: ${lineCount}, tabs: ${tabCount}`,
      ].join('\n'),
      appendReleaseHint: true,
    };
  }

  if (cmd === 'screenshot') {
    const annotate = parts.includes('--annotated') || parts.includes('-a');
    const usePng = parts.includes('--png');
    const format = usePng ? 'png' as const : 'jpeg' as const;

    const started = Date.now();
    const result = await fns.screenshot({ annotate, format });
    const elapsedMs = Date.now() - started;
    const buf = result.imageBuffer;
    const base64 = buf.toString('base64');
    if (!buf || buf.length === 0 || !base64) {
      throw new Error('Screenshot capture returned empty image data. Try waiting for page load (browser_tool wait network-idle), then retry browser_tool screenshot.');
    }

    const ext = result.imageFormat === 'jpeg' ? 'JPG' : 'PNG';
    const mimeType = result.imageFormat === 'jpeg' ? 'image/jpeg' as const : 'image/png' as const;
    const lines = [
      annotate
        ? `Annotated screenshot captured (${formatBytes(buf.length)} ${ext}) — element refs (@eN) are overlaid on interactive elements`
        : `Screenshot captured (${formatBytes(buf.length)} ${ext})`,
      `Capture time: ${elapsedMs}ms`,
    ];
    const metadata = result.metadata as Record<string, unknown> | undefined;
    const viewport = metadata?.viewport as { width?: number; height?: number; dpr?: number } | undefined;
    if (viewport?.width && viewport?.height) {
      lines.push(`Viewport: ${viewport.width}x${viewport.height} @ DPR ${viewport.dpr ?? 1}`);
    }
    const targets = (metadata?.targets as Array<unknown> | undefined)?.length;
    if (typeof targets === 'number') {
      lines.push(`Annotated targets: ${targets}`);
    }
    if (result.metadata) {
      lines.push('', 'Metadata:', JSON.stringify(result.metadata, null, 2));
    }

    return {
      output: lines.join('\n'),
      appendReleaseHint: true,
      image: {
        data: base64,
        mimeType,
        sizeBytes: buf.length,
      },
    };
  }

  if (cmd === 'screenshot-region') {
    const rest = parts.slice(1);
    if (rest.length === 0) {
      throw new Error('screenshot-region requires either coordinates, --ref, or --selector.');
    }

    const usePng = rest.includes('--png');
    const format = usePng ? 'png' as const : 'jpeg' as const;
    const filteredRest = rest.filter((t) => t !== '--png');

    const parsePadding = (tokens: string[]) => {
      const idx = tokens.findIndex((t) => t === '--padding');
      if (idx === -1) return { padding: undefined as number | undefined, cleaned: tokens };
      const raw = tokens[idx + 1];
      if (!raw) throw new Error('Missing value for --padding');
      const padding = Number(raw);
      if (Number.isNaN(padding)) throw new Error(`Invalid padding "${raw}". Expected a number.`);
      const cleaned = [...tokens.slice(0, idx), ...tokens.slice(idx + 2)];
      return { padding, cleaned };
    };

    const { padding, cleaned } = parsePadding(filteredRest);

    let screenshotArgs: BrowserScreenshotRegionArgs;
    let targetDescription = '';
    if (cleaned[0] === '--ref') {
      const ref = cleaned[1];
      if (!ref) throw new Error('screenshot-region --ref requires a ref value.');
      screenshotArgs = { ref, padding, format };
      targetDescription = `ref ${ref}`;
    } else if (cleaned[0] === '--selector') {
      const selector = cleaned.slice(1).join(' ').trim();
      if (!selector) throw new Error('screenshot-region --selector requires a CSS selector value.');
      screenshotArgs = { selector, padding, format };
      targetDescription = `selector ${selector}`;
    } else {
      if (cleaned.length < 4) {
        throw new Error('screenshot-region coordinates require: x y width height');
      }
      const [xRaw, yRaw, widthRaw, heightRaw] = cleaned;
      const x = Number(xRaw);
      const y = Number(yRaw);
      const width = Number(widthRaw);
      const height = Number(heightRaw);
      if ([x, y, width, height].some((n) => Number.isNaN(n))) {
        throw new Error('screenshot-region coordinates must be numbers.');
      }
      screenshotArgs = { x, y, width, height, padding, format };
      targetDescription = `box (${x}, ${y}, ${width}x${height})`;
    }

    const started = Date.now();
    const result = await fns.screenshotRegion(screenshotArgs);
    const elapsedMs = Date.now() - started;
    const buf = result.imageBuffer;
    const base64 = buf.toString('base64');
    if (!buf || buf.length === 0 || !base64) {
      throw new Error('Region screenshot capture returned empty image data. Try adjusting the region/selector or waiting for page load, then retry browser_tool screenshot-region.');
    }

    const ext = result.imageFormat === 'jpeg' ? 'JPG' : 'PNG';
    const mimeType = result.imageFormat === 'jpeg' ? 'image/jpeg' as const : 'image/png' as const;
    const lines = [
      `Region screenshot captured (${formatBytes(buf.length)} ${ext})`,
      `Target: ${targetDescription}${typeof padding === 'number' ? `, padding=${padding}` : ''}`,
      `Capture time: ${elapsedMs}ms`,
    ];
    if (result.metadata) {
      lines.push('', 'Metadata:', JSON.stringify(result.metadata, null, 2));
    }

    return {
      output: lines.join('\n'),
      appendReleaseHint: true,
      image: {
        data: base64,
        mimeType,
        sizeBytes: buf.length,
      },
    };
  }

  if (cmd === 'console') {
    const limitRaw = parts[1];
    const levelRaw = parts[2];
    const limit = limitRaw ? Number(limitRaw) : undefined;
    if (limitRaw && Number.isNaN(limit)) {
      throw new Error(`Invalid console limit "${limitRaw}". Expected a number.`);
    }
    const level = (levelRaw ?? 'all') as NonNullable<BrowserConsoleArgs['level']>;
    if (!['all', 'log', 'info', 'warn', 'error'].includes(level)) {
      throw new Error(`Invalid console level "${String(levelRaw)}". Use one of: all, log, info, warn, error.`);
    }

    const entries = await fns.getConsoleLogs({ limit, level });
    const levelCounts = entries.reduce<Record<string, number>>((acc, entry) => {
      acc[entry.level] = (acc[entry.level] ?? 0) + 1;
      return acc;
    }, {});

    const lines: string[] = [
      `Console entries (${entries.length}) for level=${level}: log=${levelCounts.log ?? 0}, info=${levelCounts.info ?? 0}, warn=${levelCounts.warn ?? 0}, error=${levelCounts.error ?? 0}`,
    ];

    if (entries.length > 0) {
      lines.push(`Range: ${new Date(entries[0]!.timestamp).toISOString()} → ${new Date(entries[entries.length - 1]!.timestamp).toISOString()}`);
    }

    for (const entry of entries) {
      lines.push(`[${new Date(entry.timestamp).toISOString()}] [${entry.level}] ${entry.message}`);
    }
    return { output: lines.join('\n'), appendReleaseHint: true };
  }

  if (cmd === 'window-resize') {
    const widthRaw = parts[1];
    const heightRaw = parts[2];
    if (!widthRaw || !heightRaw) throw new Error('window-resize requires width and height. Example: window-resize 1280 720');
    const width = Number(widthRaw);
    const height = Number(heightRaw);
    if (Number.isNaN(width) || Number.isNaN(height)) {
      throw new Error('window-resize width and height must be numbers.');
    }

    const resized = await fns.windowResize({ width, height });
    const clamped = resized.width !== width || resized.height !== height;

    return {
      output: [
        `Window resized to ${resized.width}x${resized.height}`,
        `Requested: ${width}x${height}${clamped ? ' (adjusted by platform constraints)' : ''}`,
      ].join('\n'),
      appendReleaseHint: true,
    };
  }

  if (cmd === 'network') {
    const limitRaw = parts[1];
    const statusRaw = parts[2] as BrowserNetworkArgs['status'] | undefined;
    const limit = limitRaw ? Number(limitRaw) : undefined;
    if (limitRaw && Number.isNaN(limit)) {
      throw new Error(`Invalid network limit "${limitRaw}". Expected a number.`);
    }
    const status = statusRaw ?? 'all';
    if (!['all', 'failed', '2xx', '3xx', '4xx', '5xx'].includes(status)) {
      throw new Error(`Invalid network status "${String(statusRaw)}". Use one of: all, failed, 2xx, 3xx, 4xx, 5xx.`);
    }
    const entries = await fns.getNetworkLogs({ limit, status });
    const buckets = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, other: 0 };
    const hostCounts = new Map<string, number>();

    for (const entry of entries) {
      buckets[statusBucket(entry.status)] += 1;
      try {
        const host = new URL(entry.url).hostname;
        hostCounts.set(host, (hostCounts.get(host) ?? 0) + 1);
      } catch {
        // ignore malformed urls
      }
    }

    const failed = buckets['4xx'] + buckets['5xx'] + buckets.other;
    const topHosts = Array.from(hostCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([host, count]) => `${host}(${count})`)
      .join(', ');

    const lines: string[] = [
      `Network entries (${entries.length}) for status=${status}: 2xx=${buckets['2xx']} 3xx=${buckets['3xx']} 4xx=${buckets['4xx']} 5xx=${buckets['5xx']} other=${buckets.other}`,
      `Failed ratio: ${formatPercent(failed, entries.length || 1)}${topHosts ? `, top hosts: ${topHosts}` : ''}`,
    ];

    for (const entry of entries) {
      lines.push(`[${new Date(entry.timestamp).toISOString()}] ${entry.method} ${entry.status} ${entry.resourceType} ${entry.url}`);
    }
    return { output: lines.join('\n'), appendReleaseHint: true };
  }

  if (cmd === 'wait') {
    const kind = parts[1] as BrowserWaitArgs['kind'] | undefined;
    if (!kind || !['selector', 'text', 'url', 'network-idle'].includes(kind)) {
      throw new Error('wait requires kind: selector|text|url|network-idle');
    }

    let value: string | undefined;
    let timeoutMs: number | undefined;
    if (kind === 'network-idle') {
      const timeoutRaw = parts[2];
      timeoutMs = timeoutRaw ? Number(timeoutRaw) : undefined;
      if (timeoutRaw && Number.isNaN(timeoutMs)) {
        throw new Error(`Invalid wait timeout "${timeoutRaw}". Expected a number.`);
      }
    } else {
      value = parts[2];
      if (!value) throw new Error(`wait ${kind} requires a value.`);
      const timeoutRaw = parts[3];
      timeoutMs = timeoutRaw ? Number(timeoutRaw) : undefined;
      if (timeoutRaw && Number.isNaN(timeoutMs)) {
        throw new Error(`Invalid wait timeout "${timeoutRaw}". Expected a number.`);
      }
    }

    const started = Date.now();
    const result = await fns.waitFor({ kind, value, timeoutMs });
    const totalElapsed = Date.now() - started;

    return {
      output: [
        `Wait succeeded (${result.kind}) in ${result.elapsedMs}ms — ${result.detail}`,
        `Configured timeout: ${timeoutMs ?? 'default'}, wall time: ${totalElapsed}ms`,
      ].join('\n'),
      appendReleaseHint: true,
    };
  }

  if (cmd === 'key') {
    const key = parts[1];
    if (!key) throw new Error('key requires key value. Example: key Enter');
    const modifiers = (parts[2] ? parts[2].split('+') : []) as Array<'shift' | 'control' | 'alt' | 'meta'>;
    for (const m of modifiers) {
      if (!['shift', 'control', 'alt', 'meta'].includes(m)) {
        throw new Error(`Invalid key modifier "${m}". Use shift|control|alt|meta`);
      }
    }

    const before = await getPageMetrics(fns);
    await fns.sendKey({ key, modifiers });
    const after = await getPageMetrics(fns);

    return {
      output: [
        `Key sent: ${key}${modifiers.length ? ` (${modifiers.join('+')})` : ''}`,
        `Active element before: ${describeActive(before)}`,
        `Active element after: ${describeActive(after)}`,
      ].join('\n'),
      appendReleaseHint: true,
    };
  }

  if (cmd === 'downloads') {
    const actionRaw = parts[1] as BrowserDownloadsArgs['action'] | undefined;
    const action = actionRaw && ['list', 'wait'].includes(actionRaw) ? actionRaw : 'list';
    const valueRaw = parts[2];
    const valueNum = valueRaw ? Number(valueRaw) : undefined;
    if (valueRaw && Number.isNaN(valueNum)) {
      throw new Error(`Invalid downloads numeric value "${valueRaw}".`);
    }

    const entries = await fns.getDownloads({
      action,
      ...(action === 'wait' ? { timeoutMs: valueNum } : { limit: valueNum }),
    });

    const states = entries.reduce<Record<string, number>>((acc, entry) => {
      acc[entry.state] = (acc[entry.state] ?? 0) + 1;
      return acc;
    }, {});

    const lines: string[] = [
      `Downloads (${entries.length}) action=${action}: started=${states.started ?? 0}, completed=${states.completed ?? 0}, interrupted=${states.interrupted ?? 0}, cancelled=${states.cancelled ?? 0}`,
    ];

    for (const entry of entries) {
      const savePathSuffix = entry.savePath ? ` -> ${entry.savePath}` : '';
      lines.push(
        `[${new Date(entry.timestamp).toISOString()}] [${entry.state}] ${entry.filename} (${formatBytes(entry.bytesReceived)}/${formatBytes(entry.totalBytes)})${savePathSuffix}`,
      );
    }
    return { output: lines.join('\n'), appendReleaseHint: true };
  }

  if (cmd === 'scroll') {
    const direction = parts[1] as 'up' | 'down' | 'left' | 'right' | undefined;
    const amountRaw = parts[2];
    if (!direction || !['up', 'down', 'left', 'right'].includes(direction)) {
      throw new Error('scroll requires direction up|down|left|right. Example: scroll down 800');
    }
    const amount = amountRaw ? Number(amountRaw) : undefined;
    if (amountRaw && Number.isNaN(amount)) {
      throw new Error(`Invalid scroll amount "${amountRaw}". Expected a number.`);
    }

    const requested = amount ?? 500;
    const before = await getPageMetrics(fns);
    await fns.scroll(direction, amount);
    const after = await getPageMetrics(fns);

    if (!before || !after) {
      return { output: `Scrolled ${direction} by ${requested}px`, appendReleaseHint: true };
    }

    const axis = direction === 'left' || direction === 'right' ? 'x' : 'y';
    const beforePos = axis === 'x' ? before.scrollX : before.scrollY;
    const afterPos = axis === 'x' ? after.scrollX : after.scrollY;
    const delta = Math.round(afterPos - beforePos);
    const max = axis === 'x' ? after.maxScrollX : after.maxScrollY;
    const progress = max > 0 ? `${((afterPos / max) * 100).toFixed(1)}%` : '0.0%';
    const atEdge = axis === 'x'
      ? (after.scrollX <= 0 || after.scrollX >= after.maxScrollX)
      : (after.scrollY <= 0 || after.scrollY >= after.maxScrollY);

    const lines = [
      `Scrolled ${direction} by ${requested}px (actual ${delta >= 0 ? '+' : ''}${delta}px)`,
      `${axis.toUpperCase()}: ${Math.round(beforePos)} → ${Math.round(afterPos)} / ${Math.round(max)} (${progress})`,
      `Viewport: ${after.viewportWidth}x${after.viewportHeight}, document: ${after.documentWidth}x${after.documentHeight}`,
      `Reached edge: ${atEdge}`,
    ];

    return { output: lines.join('\n'), appendReleaseHint: true };
  }

  if (cmd === 'back') {
    const before = await getPageMetrics(fns);
    await fns.goBack();
    const after = await getPageMetrics(fns);

    const lines = ['Navigated back'];
    if (before && after) {
      lines.push(`URL: ${before.url} → ${after.url}`);
      lines.push(`Title: ${before.title || '(untitled)'} → ${after.title || '(untitled)'}`);
    }
    return { output: lines.join('\n'), appendReleaseHint: true };
  }

  if (cmd === 'forward') {
    const before = await getPageMetrics(fns);
    await fns.goForward();
    const after = await getPageMetrics(fns);

    const lines = ['Navigated forward'];
    if (before && after) {
      lines.push(`URL: ${before.url} → ${after.url}`);
      lines.push(`Title: ${before.title || '(untitled)'} → ${after.title || '(untitled)'}`);
    }
    return { output: lines.join('\n'), appendReleaseHint: true };
  }

  if (cmd === 'evaluate') {
    const expression = parts.slice(1).join(' ').trim();
    if (!expression) throw new Error('evaluate requires an expression. Example: evaluate document.title');
    const result = await fns.evaluate(expression);
    const type = Array.isArray(result) ? 'array' : (result === null ? 'null' : typeof result);

    let rendered: string;
    if (typeof result === 'string') {
      rendered = result;
    } else {
      try {
        rendered = JSON.stringify(result, null, 2);
      } catch {
        rendered = String(result);
      }
    }

    const wasTruncated = rendered.length > 6000;
    if (wasTruncated) {
      rendered = `${rendered.slice(0, 6000)}\n... (truncated)`;
    }

    return {
      output: [`Evaluate result type: ${type}`, rendered].join('\n'),
      appendReleaseHint: true,
    };
  }

  if (cmd === 'pick') {
    const timeoutIdx = parts.indexOf('--timeout');
    const rawTimeout = timeoutIdx >= 0 ? Number(parts[timeoutIdx + 1]) : NaN;
    const options = Number.isFinite(rawTimeout) && rawTimeout > 0 ? { timeoutMs: rawTimeout } : undefined;

    const picked = await fns.pick(options);
    if (!picked) {
      return {
        output: 'Pick cancelled or timed out — no element was selected.',
        appendReleaseHint: true,
      };
    }

    return {
      output: [
        'Picked element:',
        `  Selector: ${picked.selector}`,
        `  Tag: ${picked.tag || '(unknown)'}`,
        `  Text: ${picked.text || '(empty)'}`,
        `  Rect: x=${picked.rect.x} y=${picked.rect.y} w=${picked.rect.width} h=${picked.rect.height}`,
      ].join('\n'),
      appendReleaseHint: true,
    };
  }

  if (cmd === 'prototype-list') {
    const prototypes = await fns.listPrototypes();
    const bound = fns.getBoundPrototypeSlug?.() ?? null;

    if (prototypes.length === 0) {
      return {
        output: [
          'No prototypes in this workspace yet.',
          'Create one with "prototype-create <name>" — it is a container for pages: a page is either',
          'a document of ours (write cart.html) or a live page of someone else\'s (prototype-pages --add pay=<url>).',
        ].join('\n'),
        appendReleaseHint: false,
      };
    }

    // Which prototypes study each one, derived from the same list — the stored
    // relation is one-way, but "a relation" is only legible if both ends show it.
    const referencedBy = new Map<string, string[]>()
    for (const prototype of prototypes) {
      for (const referenceSlug of prototype.references) {
        referencedBy.set(referenceSlug, [...(referencedBy.get(referenceSlug) ?? []), prototype.slug])
      }
    }

    const lines = [
      `${prototypes.length} prototype${prototypes.length === 1 ? '' : 's'} in this workspace` +
      `${bound ? ` (this session is bound to "${bound}")` : ' (this session is not bound to one)'}:`,
    ];
    for (const prototype of prototypes) {
      const notes: string[] = [];
      if (prototype.slug === bound) notes.push('BOUND');
      // Having no pages is the normal state of a new prototype, so it is said the
      // same way the panel says it — as the thing that decides whether anything
      // can be opened at all.
      if (!prototype.pageAvailable) notes.push('no pages yet');
      notes.push(`${prototype.pages.length} page${prototype.pages.length === 1 ? '' : 's'}`);
      notes.push(`${prototype.patches.total} patch${prototype.patches.total === 1 ? '' : 'es'}`);
      if (prototype.entryPage) notes.push(`entry: ${prototype.entryPage}`);
      if (prototype.references.length > 0) notes.push(`references: ${prototype.references.join(', ')}`);
      const studying = referencedBy.get(prototype.slug)
      if (studying?.length) notes.push(`referenced by: ${studying.join(', ')}`);
      lines.push(`  • ${prototype.slug} — ${notes.join(', ')}`);
      // The pages are the prototype's own shape, and a page's kind decides how it
      // is changed — so they are listed here rather than left for a second command.
      for (const page of prototype.pages) {
        const where = page.kind === 'overlay' ? (page.url ?? 'no address') : (page.file ?? 'document missing');
        lines.push(`      ${page.name} (${page.kind})${page.entry ? ' [entry]' : ''} — ${where}`);
      }
      if (prototype.pageIssues.length > 0) {
        for (const issue of prototype.pageIssues) lines.push(`      ! ${issue}`);
      }
    }

    return { output: lines.join('\n'), appendReleaseHint: false };
  }

  if (cmd === 'prototype-create') {
    // `--no-bind` exists for one reason: creating a *reference* must not steal
    // the session's binding, or every later slug-less command would retarget the
    // page being studied instead of the page being built.
    const noBind = parts.includes('--no-bind');

    // Creation takes a name and nothing else (plan §19.8). A leftover flag from
    // when it also asked for a kind or an address would otherwise be swallowed by
    // the name — and an address silently folded into a slug is not a mistake
    // anyone would find later.
    const unknownFlag = parts.slice(1).find((part) => part.startsWith('--') && part !== '--no-bind');
    if (unknownFlag) {
      throw new Error(
        `prototype-create does not take "${unknownFlag}". It only needs a name — pages come afterwards: ` +
          `write <name>.html for a page of ours, or "prototype-pages --add <name>=<url>" for one that belongs ` +
          `to a real site.`,
      );
    }

    const name = parts
      .slice(1)
      .filter((part) => part !== '--no-bind')
      .join(' ')
      .trim();

    if (!name) {
      throw new Error('prototype-create needs a name. Example: prototype-create Checkout flow');
    }

    // Nothing about the pages is decided here: a page's kind is a fact about that
    // page, and creation is the container (plan §19.8). The address used to be
    // required at this point, which made the container carry a page's fact.
    const created = await fns.createPrototype({ name });
    if (!noBind) await fns.bindPrototype(created.slug);

    const lines = [
      noBind
        ? `Created prototype "${created.slug}" (not bound — this session still targets its own prototype).`
        : `Created prototype "${created.slug}" and bound this session to it.`,
      `  dir: ${created.dir}`,
      '',
      'It has no pages yet — a starting state, not a mistake. A page is one of two things:',
      '  • a document of ours: write cart.html with the file tools, and it is a page.',
      '  • a page that belongs to a real site: prototype-pages --add pay=https://app.example.com/pay',
      '     (study it with the browser tool before writing selectors — the live DOM is the only thing',
      '      that says what they will match).',
      '',
      'Then "prototype-entry cart" if the address root should open one of them (without an entry it lists',
      'them), and "prototype-open" to look at the result.',
    ];

    if (!noBind) lines.push('', 'The prototype-* commands now target it by default.');

    return { output: lines.join('\n'), appendReleaseHint: false };
  }

  // The address is changeable, because the same page lives in several environments
  // and the same patches are meant to be looked at in each of them (target.ts).
  //
  // Deliberately not resolved through `resolvePrototypeSlug`: the only positional
  // argument here *is* the address, and a slug resolver would read it as a
  // prototype. Binding names the prototype instead — which is also the state of
  // any conversation that is working on one.
  if (cmd === 'prototype-target') {
    const url = parts.slice(1).find((part) => !part.startsWith('--'));
    const pageFlag = parts.indexOf('--page');
    const wantedPage = pageFlag >= 0 ? parts[pageFlag + 1] : undefined;

    if (!url) {
      throw new Error(
        'prototype-target needs the address to point at. Example: prototype-target https://staging.example.com/checkout',
      );
    }
    if (pageFlag >= 0 && (!wantedPage || wantedPage.startsWith('--'))) {
      throw new Error(
        'prototype-target --page needs a page name. Example: prototype-target https://staging.example.com/checkout --page cart',
      );
    }

    const slug = fns.getBoundPrototypeSlug?.() ?? null;
    if (!slug) {
      throw new Error(
        `prototype-target changes the address of the prototype this session is bound to, and it is not bound to ` +
          `one. Bind it with "prototype-bind <slug>" — "prototype-list" shows what exists.`,
      );
    }

    const before = await fns.prototypeStatus(slug);
    // Which page moves: the named one, or the entry page when it is a live one,
    // or the first live one — the same rule `pickOverlayPage` applies, so the page
    // this reports is the page the change actually lands on.
    const target = wantedPage
      ? before.pages.find((page) => page.name === wantedPage)
      : before.pages.find((page) => page.entry && page.kind === 'overlay') ??
        before.pages.find((page) => page.kind === 'overlay');

    if (wantedPage && !target) {
      throw new Error(
        `Prototype "${slug}" has no page "${wantedPage}". Pages: ${before.pages.map((page) => page.name).join(', ') || 'none'}`,
      );
    }
    if (!target) {
      throw new Error(
        `Prototype "${slug}" has no page that belongs to a real site, so there is no address to point. ` +
          `Add one with "prototype-pages --add <name>=<url>".`,
      );
    }

    const updated = await fns.setPrototypePageUrl(slug, url, target.name);
    const rows = updated.pages ?? [];
    const after = rows.find((page) => page.name === target.name)?.url;

    const lines = [
      `Prototype "${slug}": page "${target.name}" ${target.url ? 'pointed somewhere else' : 'given an address'}`,
    ];
    if (target.url) lines.push(`  from: ${target.url}`);
    lines.push(`  to:   ${after ?? url}`, '');
    // The two things that go stale silently are named here rather than discovered
    // later as "the patches did nothing".
    lines.push(
      'What follows from this:',
      '  • "prototype-open" goes to the new address, and the next "prototype-export" names it in dev-spec.md and',
      '    scopes the extension to it.',
      '  • Windows already showing the old page keep it until they navigate again — re-open to move them.',
      '  • The patches were written against the old page. Another environment (or the same one after a deploy) may',
      '    not have the same DOM, and a patch that matches nothing looks exactly like a patch that did nothing —',
      '    re-check them on the new address.',
      '  • The page\'s kind is still fixed: this changes where the page is, not what it is.',
    );

    return { output: lines.join('\n'), appendReleaseHint: true };
  }

  // Which page the address root opens (plan §19.3). Its own command rather than a
  // flag on prototype-pages: it is the one change to the table that is about the
  // prototype's front door rather than about the flow.
  //
  // Like prototype-target, its only positional argument is a page name, so it does
  // not go through `resolvePrototypeSlug` — binding names the prototype.
  if (cmd === 'prototype-entry') {
    const value = parts.slice(1).find((part) => !part.startsWith('--'));
    if (!value) {
      throw new Error('prototype-entry needs a page name, or "none". Example: prototype-entry cart');
    }

    const slug = fns.getBoundPrototypeSlug?.() ?? null;
    if (!slug) {
      throw new Error(
        `prototype-entry changes the prototype this session is bound to, and it is not bound to one. ` +
          `Bind it with "prototype-bind <slug>" — "prototype-list" shows what exists.`,
      );
    }

    const result = await fns.setPrototypePages(slug, {
      op: 'entry',
      name: value.toLowerCase() === 'none' ? null : value,
    });

    const lines = [`Prototype "${slug}": ${result.note}.`];
    lines.push(
      ...(result.pages.length === 0
        ? ['  no pages declared yet']
        : result.pages.map(
            (page) =>
              `  ${page.name} (${page.kind})${page.entry ? ' [entry]' : ''} — ${page.url ?? 'a document of ours'}`,
          )),
      '',
      'The generated page index stays reachable at /_index, so configuring an entry never takes the list away.',
      'Re-export to put this in the delivered extension (the toolbar icon opens the entry page).',
    );

    return { output: lines.join('\n'), appendReleaseHint: true };
  }

  // The page table: the flow's *other* real addresses. One list, because the same
  // data feeds "prototype-status", "prototype-open --page", the page name in
  // "snapshot", and the extension's match patterns — a second place to edit it
  // would be a second thing to drift.
  if (cmd === 'prototype-pages') {
    const slug = resolvePrototypeSlug(fns, parts, 'prototype-pages');

    // One change at a time: "add this page and rename that one" is two decisions,
    // and reporting them as one line would hide which one failed.
    const flags = ['--add', '--remove', '--rename'].filter((flag) => parts.includes(flag));
    if (flags.length > 1) {
      throw new Error(`prototype-pages takes one change at a time (got ${flags.join(' and ')}).`);
    }
    const flag = flags[0];
    const value = flag ? parts[parts.indexOf(flag) + 1] : undefined;
    if (flag && (!value || value.startsWith('--'))) {
      throw new Error(
        flag === '--remove'
          ? 'prototype-pages --remove needs a page name. Example: prototype-pages --remove payment'
          : flag === '--rename'
            ? 'prototype-pages --rename needs old=new. Example: prototype-pages --rename cart=basket'
            : 'prototype-pages --add needs a page name, and a url for a live page. Examples: ' +
              'prototype-pages --add payment=https://app.example.com/pay · prototype-pages --add orders',
      );
    }

    let change: PrototypePagesChange | null = null;
    if (flag === '--remove') {
      change = { op: 'remove', name: value! };
    } else if (flag === '--rename') {
      const separator = value!.indexOf('=');
      if (separator <= 0) {
        throw new Error('prototype-pages --rename needs old=new. Example: prototype-pages --rename cart=basket');
      }
      change = { op: 'rename', from: value!.slice(0, separator), to: value!.slice(separator + 1) };
    } else if (flag === '--add') {
      // `name=url` adds a page that belongs to a real site; a bare `name` places
      // one of our documents in the flow order, which is the only thing the table
      // can do about a page that is a file (plan §19.8).
      const separator = value!.indexOf('=');
      change = separator <= 0
        ? { op: 'add', name: value! }
        : { op: 'add', name: value!.slice(0, separator), url: value!.slice(separator + 1) };
    }

    if (change) {
      const result = await fns.setPrototypePages(slug, change);
      const lines = [`Prototype "${slug}": ${result.note}.`];
      lines.push(
        ...(result.pages.length === 0
          ? ['  the table is empty — a document in the prototype directory is still a page']
          : result.pages.map(
              (page) =>
                `  ${page.name} (${page.kind})${page.entry ? ' [entry]' : ''} — ${page.url ?? 'a document of ours'}`,
            )),
        '',
        // The deliverable is a snapshot (§17.4): a page added now is not in the
        // extension someone already loaded, and nothing else would say so.
        'Re-export to put this in the delivered extension: the package is a snapshot of the prototype, so it does',
        'not see this change until it is built again.',
      );
      return { output: lines.join('\n'), appendReleaseHint: true };
    }

    const status = await fns.prototypeStatus(slug);
    if (status.pages.length === 0) {
      return {
        output:
          `Prototype "${slug}": no pages yet. Write one (a top-level <name>.html in ${status.dir}), or add a live ` +
          `page with "prototype-pages --add <name>=<url>".`,
        appendReleaseHint: true,
      };
    }

    const lines = [`Prototype "${slug}": ${status.pages.length} page(s), in flow order`];
    for (const page of status.pages) {
      const where = page.kind === 'overlay' ? (page.url ?? 'no address') : (page.file ?? 'document missing');
      lines.push(`  ${page.name} (${page.kind})${page.entry ? ' [entry]' : ''} — ${where}`);
    }
    lines.push('');
    lines.push(
      status.entryPage
        ? `The address root opens "${status.entryPage}" — change that with "prototype-entry <name|none>".`
        : 'The address root shows the generated page index — "prototype-entry <name>" picks a page instead.',
    );
    lines.push('Change the flow:');
    lines.push('  prototype-pages --add <name>=<url>    add a page that belongs to a real site (we patch it in place)');
    lines.push('  prototype-pages --add <name>          place an existing <name>.html in the flow order');
    lines.push('  prototype-pages --rename <old>=<new>  ·  --remove <name>  (removing a page of ours deletes its document)');
    if (status.pageIssues.length > 0) {
      lines.push('', 'Issues (fix or acknowledge these — they are screens or patches nothing will reach):');
      for (const issue of status.pageIssues) lines.push(`  • ${issue}`);
    }

    return { output: lines.join('\n'), appendReleaseHint: true };
  }

  // References: the subject is the *other* prototype, so the reader cannot also be
  // a positional argument without ambiguity. It is therefore always the bound
  // prototype, and an unbound session gets told how to bind rather than guessing.
  if (cmd === 'prototype-reference') {
    const remove = parts.includes('--remove');
    const referenceSlug = parts.slice(1).find((part) => !part.startsWith('--'));

    if (!referenceSlug) {
      throw new Error(
        'prototype-reference needs the slug of the prototype to study. Example: prototype-reference rival-checkout',
      );
    }

    const reader = fns.getBoundPrototypeSlug?.() ?? null;
    if (!reader) {
      throw new Error(
        `prototype-reference works on the prototype this session is bound to, and it is not bound to one. ` +
        `Bind it with "prototype-bind <slug>". "prototype-list" shows what exists.`,
      );
    }

    const config = remove
      ? await fns.unlinkPrototypeReference(reader, referenceSlug)
      : await fns.linkPrototypeReference(reader, referenceSlug);

    const remaining = config.references ?? [];
    const lines = [
      remove
        ? `"${referenceSlug}" is no longer a reference of "${reader}".`
        : `"${referenceSlug}" is now a reference of "${reader}".`,
    ];

    if (remaining.length > 0) {
      lines.push(`  references: ${remaining.join(', ')}`);
    } else {
      lines.push('  references: none');
    }
    lines.push('');
    lines.push('Its patches were written against a different document: read them for intent, but do NOT copy');
    lines.push(`them into prototypes/${reader}/patches/ — they would not match here, and they would ship inside`);
    lines.push(`this prototype's deliverable without erroring.`);

    return { output: lines.join('\n'), appendReleaseHint: false };
  }

  if (cmd === 'prototype-bind') {
    const explicit = parts[1];
    // `--clear` is the escape hatch: unbind without needing a slug to name.
    if (explicit === '--clear' || explicit === '--none') {
      await fns.bindPrototype(null);
      return { output: 'Unbound this session from its prototype.', appendReleaseHint: false };
    }

    if (!explicit || explicit.startsWith('--')) {
      throw new Error(
        'prototype-bind needs a slug. Example: prototype-bind checkout-flow (or prototype-bind --clear to unbind)',
      );
    }

    // Refuse a slug that does not exist: binding to nothing would silently make
    // every later command fail here instead of at the bind.
    const known = await fns.listPrototypes();
    if (!known.some((prototype) => prototype.slug === explicit)) {
      throw new Error(
        `No prototype "${explicit}" in this workspace. Available: ${known.map((p) => p.slug).join(', ') || '(none)'}`,
      );
    }

    await fns.bindPrototype(explicit);
    return {
      output: `Bound this session to prototype "${explicit}" — prototype-* commands now target it by default.`,
      appendReleaseHint: false,
    };
  }

  if (cmd === 'prototype-apply') {
    const slug = resolvePrototypeSlug(fns, parts, 'prototype-apply');

    const result = await fns.applyPrototype(slug);
    const count = (n: number) => `${n} patch${n === 1 ? '' : 'es'}`;
    const lines: string[] = [];

    // Which page's patches these are is not decoration: a page-scoped patch
    // (`patches/<page>/…`) only ever lands on that page, so "the patch did nothing"
    // and "the patch belongs to another page" have to be distinguishable here.
    if (result.applied > 0) {
      lines.push(
        `Prototype "${result.slug}": applied ${count(result.applied)}` +
          `${result.page ? ` for page "${result.page}"` : ' (the shared patches only — no page of this flow is on screen)'}`,
      );
      lines.push(...result.files.map((file) => `  • ${file}`));
      lines.push('Patches are also registered for future documents, so they survive a page reload.');
    } else if (result.skipped.length > 0) {
      // The rendered page is the normal case for this: it arrives with every
      // patch inlined, so there is genuinely nothing to do.
      lines.push(`Prototype "${result.slug}": nothing to inject — this page already carries all ${count(result.skipped.length)}.`);
    } else {
      lines.push(`Prototype "${result.slug}": nothing to inject — no patch files found (expected patches/{lane}-{nnn}-{name}.{css|js}).`);
    }

    if (result.applied > 0 && result.skipped.length > 0) {
      lines.push(`Left alone, already inlined here: ${result.skipped.join(', ')}.`);
    }
    if (result.skipped.length > 0) {
      lines.push('Inlined means the host rendered it from disk — a patch whose contents changed since then still counts as inlined, so reload the page to pick the change up.');
    }

    // What the patches made of the page (plan §21.1). This is the difference
    // between "the change did nothing" and "the selector is wrong", and between
    // both of those and "the page moved since the patch was written".
    if (result.unmatched && result.unmatched.length > 0) {
      lines.push(
        `Declared targets that matched nothing (and have never matched): ${result.unmatched.join(', ')} — ` +
          `the selectors are wrong, or the page is not the one they were written against.`,
      );
    }
    for (const drift of result.drifted ?? []) {
      const when = drift.lastMatchedAt ? `last matched ${drift.lastMatchedAt}` : 'recorded by an earlier apply';
      const suggestions =
        drift.suggestions.length > 0
          ? ` On the page now: ${drift.suggestions.join(', ')}.`
          : '';
      lines.push(
        `Target "${drift.target}" matched nothing but is on record (${when}) — the page moved rather than the patch ` +
          `being wrong.${suggestions}`,
      );
    }
    if (result.untargeted && result.untargeted.length > 0) {
      lines.push(
        `No "@target" declared, so nothing could check these: ${result.untargeted.join(', ')}. ` +
          `Add a header line '@target <css selector>' and the next apply will say whether it still matches.`,
      );
    }

    return { output: lines.join('\n'), appendReleaseHint: true };
  }

  if (cmd === 'prototype-commit') {
    const slug = resolvePrototypeSlug(fns, parts, 'prototype-commit');

    const pageFlag = parts.indexOf('--page');
    const requestedPage = pageFlag >= 0 ? parts[pageFlag + 1] : undefined;
    if (pageFlag >= 0 && (!requestedPage || requestedPage.startsWith('--'))) {
      throw new Error('prototype-commit --page needs a page name. Example: prototype-commit --page cart');
    }

    const result = await fns.commitPrototype(slug, requestedPage ? { page: requestedPage } : undefined);

    if (result.nothingToCommit) {
      return {
        output:
          `Prototype "${result.slug}": nothing to fold — no patch is waiting to be consolidated. ` +
          `(A page with no document is the one case that is refused rather than empty; run 'prototype-status' if you expected something here.)`,
        appendReleaseHint: true,
      };
    }

    const lines: string[] = [`Prototype "${result.slug}": committed.`];
    for (const scope of result.scopes) {
      lines.push(`${scope.page ? `page "${scope.page}" (${scope.kind})` : 'the shared patches'}:`);
      for (const file of scope.wrote) lines.push(`  wrote ${file}`);
      for (const file of scope.folded) lines.push(`  folded patches/${file}`);
      for (const file of scope.promoted) lines.push(`  promoted patches/${file} (now a script the page loads)`);
      for (const file of scope.deleted) lines.push(`  deleted patches/${file}`);
      if (scope.unverified.length > 0) {
        lines.push(
          `  not checked: ${scope.unverified.map((file) => `patches/${file}`).join(', ')} — no "@target", ` +
            `so nothing verified what they matched.`,
        );
      }
      for (const refusal of scope.refused) {
        lines.push(`  left alone: patches/${refusal.file} — ${refusal.reason}`);
      }
    }
    lines.push(
      'The folded patches no longer exist as files; what they changed lives in the file named above. ' +
        'Write new patches as usual — the layer starts empty, and the next commit folds those.',
    );

    return { output: lines.join('\n'), appendReleaseHint: true };
  }

  if (cmd === 'prototype-record') {
    const action = parts[1] ?? 'start';

    if (action === 'stop') {
      // The action name comes first, so the slug is the *second* argument here —
      // `resolvePrototypeSlug` reads the first and would take "stop" for one.
      const explicit = parts[2];
      const slug =
        explicit && !explicit.startsWith('--') ? explicit : fns.getBoundPrototypeSlug?.();
      if (!slug) {
        throw new Error(
          'No prototype to keep the frames in: this session is not bound to one. Pass a slug ' +
            '("prototype-record stop <slug>"), or bind this session first ("prototype-bind <slug>").',
        );
      }

      const result = await fns.stopPrototypeFrames(slug);
      if (!result) {
        return { output: 'No frame capture was running in this window.', appendReleaseHint: true };
      }

      const lines = [
        `Stopped: ${result.frames} frame${result.frames === 1 ? '' : 's'} written to ${result.dir}`,
        ...result.files.map((file) => `  • ${file}`),
      ];
      if (result.truncated) {
        lines.push('The capture hit its frame ceiling, so this is a sample — later changes were not recorded.');
      }
      lines.push('Cite these from a finding (evidence: frames/<session>/frame-0001.jpg).');

      return { output: lines.join('\n'), appendReleaseHint: true };
    }

    if (action === 'import') {
      const path = parts[2];
      if (!path || path.startsWith('--')) {
        throw new Error(
          'Which recording? "prototype-record import <path>" — the video to sample frames out of.',
        );
      }

      const slug = fns.getBoundPrototypeSlug?.();
      if (!slug) {
        throw new Error(
          'No prototype to keep the frames in: this session is not bound to one. Bind it first ' +
            '("prototype-bind <slug>").',
        );
      }

      const result = await fns.importPrototypeVideo({
        slug,
        path,
        mode: parts.includes('--changes') ? 'changes' : 'timeline',
        everyMs: durationOption(parts, '--every', 2000),
        maxFrames: numberOption(parts, '--max', 40, 1, 400),
      });

      if (!result) {
        return { output: 'Nothing was sampled: the recording could not be read.', appendReleaseHint: true };
      }

      const lines = [
        `Sampled ${result.frames} frame${result.frames === 1 ? '' : 's'} out of ${result.video} ` +
          `(${Math.round(result.durationMs / 1000)}s long) into research/frames/${result.session}/`,
        ...result.files.map((file) => `  • ${file}`),
      ];
      if (result.truncated) {
        lines.push('The capture hit its frame ceiling, so this is a sample of the recording.');
      }
      lines.push('Cite these from a finding (evidence: frames/<session>/frame-0001.jpg).');

      return { output: lines.join('\n'), appendReleaseHint: true };
    }

    if (action !== 'start') {
      throw new Error(
        `Unknown "prototype-record ${action}". Use "prototype-record start" or "prototype-record stop".`,
      );
    }

    const started = await fns.startPrototypeFrames({
      intervalMs: numberOption(parts, '--interval', 400, 50, 10_000),
      threshold: ratioOption(parts, '--threshold', 0.005),
      maxFrames: numberOption(parts, '--max', 60, 1, 600),
    });

    return {
      output: [
        `Recording frames of this window: the screen is compared every ${started.intervalMs} ms and kept when more`,
        `than ${(started.threshold * 100).toFixed(1)}% of it changed (at most ${started.maxFrames} frames).`,
        'Interact with the page, then run "prototype-record stop" to write them under research/frames/.',
      ].join('\n'),
      appendReleaseHint: true,
    };
  }

  if (cmd === 'prototype-verify') {
    const slug = resolvePrototypeSlug(fns, parts, 'prototype-verify');
    const result = await fns.verifyPrototype(slug);

    const lines = [
      `Acceptance — ${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped`,
      result.page
        ? `Page checks ran against ${result.page}.`
        : 'No page was open, so page checks were skipped.',
      '',
      ...result.results.map(
        (entry) => `${entry.status.toUpperCase().padEnd(4)} ${entry.requirementId} ${entry.target} — ${entry.detail}`,
      ),
      '',
      `Written to ${result.reportPath}`,
    ];

    return { output: lines.join('\n'), appendReleaseHint: true };
  }

  if (cmd === 'prototype-project') {
    const slug = resolvePrototypeSlug(fns, parts, 'prototype-project');
    const explicit = parts[1] && !parts[1].startsWith('--') ? parts[2] : parts[1];
    // `--clear` and no argument both mean "no project": the edge is optional, and
    // removing it is the same kind of edit as setting it.
    const projectSlug =
      parts.includes('--clear') || !explicit || explicit.startsWith('--') ? null : explicit;

    const result = await fns.setPrototypeProject({ slug, projectSlug });

    return {
      output: result.projectSlug
        ? `Prototype "${result.slug}" now belongs to project "${result.projectSlug}". It stays where it is — the edge is not a container.`
        : `Prototype "${result.slug}" no longer belongs to a project.`,
      appendReleaseHint: true,
    };
  }

  if (cmd === 'prototype-clear') {
    const slug = resolvePrototypeSlug(fns, parts, 'prototype-clear');

    const result = await fns.clearPrototype(slug);
    const lines = [
      `Prototype "${result.slug}": removed ${result.removed.length} patch${result.removed.length === 1 ? '' : 'es'}`,
    ];
    if (result.removed.length > 0) {
      lines.push(...result.removed.map((key) => `  • ${key}`));
    }
    lines.push('Reload the page to drop their effects from the current document.');

    return { output: lines.join('\n'), appendReleaseHint: true };
  }

  if (cmd === 'prototype-export') {
    const slug = resolvePrototypeSlug(fns, parts, 'prototype-export');

    const result = await fns.exportPrototype(slug);
    const status = await fns.prototypeStatus(slug);
    const livePages = status.pages.filter((page) => page.kind === 'overlay').length;
    const ourPages = status.pages.length - livePages;

    const lines = [
      `Prototype "${result.slug}": exported ${result.pageCount} page(s) and ${result.applied} patch` +
        `${result.applied === 1 ? '' : 'es'} (build ${result.version})`,
      `  Extension: ${result.extensionDir}`,
      `  Spec: ${result.specPath}`,
      '',
    ];
    // The folder is one deliverable either way, but what it *does* differs by the
    // pages it covers, and so does what to tell the agent to verify: a live page
    // gets patched in a real browser, a page of ours is shipped inside the package.
    lines.push('The folder is the deliverable: a loadable Chrome extension. Hand it over as it is; the README in it');
    lines.push('says where it applies, which responses are faked, and which build it is.');
    if (livePages > 0) {
      lines.push(
        `Loading it (chrome://extensions → Developer mode → Load unpacked) puts its patches on the ${livePages} live`,
        'page(s) it covers — nothing to click, and they survive a reload. After a re-export the recipient presses',
        'Reload on the extension.',
      );
    }
    if (ourPages > 0) {
      lines.push(
        `The ${ourPages} page(s) of ours ship inside the package: the recipient opens Options (or the toolbar icon),`,
        'which shows the page index. To check that side here first:',
      );
    }
    if (result.pageUrl) lines.push(`  browser_tool navigate ${result.pageUrl}`);
    if (result.warnings.length > 0) {
      lines.push(
        '',
        'The document had to be adapted for the extension (behaviour is unchanged):',
        ...result.warnings.map((warning) => `  - ${warning}`),
      );
    }

    return { output: lines.join('\n'), appendReleaseHint: true };
  }

  if (cmd === 'prototype-contract-compose') {
    const slug = resolvePrototypeSlug(fns, parts, 'prototype-contract-compose');
    const serviceIdx = parts.indexOf('--service');
    const service = serviceIdx >= 0 ? parts[serviceIdx + 1] : undefined;

    const result = await fns.composeContract({ slug, service });
    const lines = [
      `Prototype "${slug}" service "${result.service}": composed ${result.endpoints} endpoint${result.endpoints === 1 ? '' : 's'}`,
      'Wrote services/<service>/openapi.yaml from the paths/ fragments.',
    ];
    if (result.conflicts.length > 0) {
      lines.push(`Duplicate path${result.conflicts.length === 1 ? '' : 's'} (last fragment in file-name order won): ${result.conflicts.join(', ')}`);
    }
    if (result.missingFixtures.length > 0) {
      lines.push(`x-mock fixtures referenced but missing: ${result.missingFixtures.join(', ')}`);
    }

    return { output: lines.join('\n'), appendReleaseHint: true };
  }

  if (cmd === 'prototype-contract-export') {
    const slug = resolvePrototypeSlug(fns, parts, 'prototype-contract-export');
    const serviceIdx = parts.indexOf('--service');
    const service = serviceIdx >= 0 ? parts[serviceIdx + 1] : undefined;

    const result = await fns.exportContract({ slug, service });
    const lines = [
      `Prototype "${slug}" service "${result.service}": exported contract with ${result.endpoints} endpoint${result.endpoints === 1 ? '' : 's'}`,
      `  openapi.yaml: ${result.openapiPath}`,
      `  contract.md:  ${result.docPath}`,
      `  fixtures:     ${result.fixtures} → ${result.fixturesDir}`,
    ];
    if (result.missingFixtures.length > 0) {
      lines.push(`Missing fixtures: ${result.missingFixtures.join(', ')}`);
    }

    return { output: lines.join('\n'), appendReleaseHint: true };
  }

  if (cmd === 'prototype-mock-apply') {
    const slug = resolvePrototypeSlug(fns, parts, 'prototype-mock-apply');
    const serviceIdx = parts.indexOf('--service');
    const service = serviceIdx >= 0 ? parts[serviceIdx + 1] : undefined;

    const result = await fns.applyMock({ slug, service });
    const lines = [
      `Prototype "${slug}" service "${result.service}": serving ${result.routes} mock route${result.routes === 1 ? '' : 's'} at the network layer`,
      'Covers fetch and XHR alike — the app does not need to point anywhere else.',
    ];
    if (result.unmocked.length > 0) {
      lines.push(`Unmocked endpoints (${result.unmocked.length}): ${result.unmocked.join(', ')}`);
    }
    if (result.missingFixtures.length > 0) {
      lines.push(`Skipped — x-mock fixtures not found: ${result.missingFixtures.join(', ')}`);
    }

    return { output: lines.join('\n'), appendReleaseHint: true };
  }

  if (cmd === 'prototype-mock-clear') {
    await fns.clearMock();
    return {
      output: 'Mock cleared — requests fall through to the real network again.',
      appendReleaseHint: true,
    };
  }

  if (cmd === 'prototype-status') {
    const slug = resolvePrototypeSlug(fns, parts, 'prototype-status');

    const status = await fns.prototypeStatus(slug);
    // Reference slugs are stored bare, so resolving what each one *is* takes the
    // workspace list. Worth the extra read: "references: rival-checkout" is not
    // actionable until you know whether that is an overlay or another scratch.
    const all = await fns.listPrototypes();
    const bySlug = new Map(all.map((prototype) => [prototype.slug, prototype]));

    const laneSummary = Object.entries(status.patches.byLane)
      .map(([lane, count]) => `${lane}: ${count}`)
      .join(', ');

    const lines = [
      `Prototype "${status.slug}"`,
      `  dir:        ${status.dir}`,
      `  openable:   ${status.pageAvailable ? 'yes' : 'no pages yet — nothing to open'}`,
    ];

    // The prototype is a flow, so its screens are listed the way its patches are:
    // as the facts an agent needs before it decides what to change. A page of ours
    // is a document in the directory, a live page is a URL on the real site — and
    // the kind decides how each one is changed.
    if (status.pages.length === 0) {
      lines.push('  pages:      none yet');
    } else {
      status.pages.forEach((page, index) => {
        const entryMark = page.entry ? ' [entry]' : '';
        const where = page.kind === 'overlay'
          ? `— ${page.url ?? 'no address'}`
          : `— ${page.file ?? 'document missing'}`;
        lines.push(`  ${index === 0 ? 'pages:' : '      '}      ${page.name} (${page.kind})${entryMark} ${where}`);
      });
      lines.push(
        `  root:       ${status.entryPage ? `opens "${status.entryPage}"` : 'shows the generated page index'}`,
      );
    }

    if (status.pageIssues.length > 0) {
      // Anything dropped rather than guessed at, a document that is gone, a patch
      // directory nothing reaches: in every case the flow is missing a screen (or a
      // change is reaching nowhere), and this is the only place that says which.
      lines.push(`  page issues: ${status.pageIssues.length}`);
      for (const issue of status.pageIssues) {
        lines.push(`    • ${issue}`);
      }
    }

    if (status.references.length === 0) {
      lines.push('  references: none');
    } else {
      status.references.forEach((referenceSlug, index) => {
        const reference = bySlug.get(referenceSlug);
        const described = reference
          ? `${reference.pages.length} page(s)${reference.entryPage ? `, entry "${reference.entryPage}"` : ''}`
          : 'MISSING — no prototype with that slug'
        lines.push(`  ${index === 0 ? 'references:' : '          '}    ${referenceSlug} (${described})`);
      });
    }

    const referencedBy = all
      .filter((prototype) => prototype.references.includes(status.slug))
      .map((prototype) => prototype.slug);
    if (referencedBy.length > 0) {
      lines.push(`  referenced by: ${referencedBy.join(', ')}`);
    }

    lines.push(
      `  patches:    ${status.patches.total}${laneSummary ? ` (${laneSummary})` : ''}` +
        `${status.patches.total > 0 ? ` — ${status.patches.scoped} page-scoped, ${status.patches.total - status.patches.scoped} shared` : ''}`,
    );

    if (status.services.length === 0) {
      lines.push('  services:   none');
    } else {
      for (const service of status.services) {
        lines.push(
          `  service ${service.slug}: ${service.endpoints} endpoints, ${service.mockedEndpoints} mocked, ` +
          `${service.fragments} fragments, ${service.fixtures} fixtures`,
        );
        if (service.missingFixtures.length > 0) {
          lines.push(`    missing fixtures: ${service.missingFixtures.join(', ')}`);
        }
      }
    }

    lines.push(`  dist:       ${status.distFiles.length > 0 ? status.distFiles.join(', ') : 'empty'}`);

    if (status.ownership.violations.length === 0) {
      lines.push(`  ownership:  OK (${status.ownership.inspected} files)`);
    } else {
      lines.push(`  ownership:  ${status.ownership.violations.length} violation(s)`);
      for (const violation of status.ownership.violations) {
        lines.push(`    • ${violation.path} — ${violation.reason}`);
      }
    }

    return { output: lines.join('\n'), appendReleaseHint: true };
  }

  if (cmd === 'prototype-open') {
    const slug = resolvePrototypeSlug(fns, parts, 'prototype-open');

    const pageFlagIndex = parts.indexOf('--page');
    let requestedPage = pageFlagIndex >= 0 ? parts[pageFlagIndex + 1] : undefined;
    if (pageFlagIndex >= 0 && (!requestedPage || requestedPage.startsWith('--'))) {
      throw new Error('prototype-open --page needs a page name. Example: prototype-open checkout-flow --page orders');
    }

    const entry = await fns.prototypeEntry({ slug });

    // With more than one page, "open the prototype" no longer has a single
    // meaning, so an unqualified open starts from the page the bound window is
    // already on (plan §19.6) and falls back to the entry page — which itself
    // falls back to the generated index. A window that cannot be read is not a
    // reason to refuse the open; it just means there is no current page to prefer.
    if (!requestedPage) {
      try {
        const snapshot = await fns.snapshot();
        const window = snapshot.prototype;
        if (window?.slug === slug && window.page) requestedPage = window.page;
      } catch {
        // No browser window to ask — the entry page is the answer.
      }
    }

    // `--page` names a later screen; the list comes from the prototype's own
    // status, which is also what tells the agent which names exist.
    let url = entry.url;
    let openedPage: { name: string; kind: string } | null = null;
    if (requestedPage) {
      const status = await fns.prototypeStatus(slug);
      const page = status.pages.find((candidate) => candidate.name === requestedPage);
      if (!page) {
        const names = status.pages.map((candidate) => candidate.name).join(', ') || 'none';
        throw new Error(`Prototype "${slug}" has no page "${requestedPage}". Pages: ${names}`);
      }
      if (!page.url) {
        throw new Error(
          `Page "${requestedPage}" of "${slug}" has no address${
            page.kind === 'scratch' ? ' — its document is missing' : ' — nothing is serving this prototype\'s pages'
          }.`,
        );
      }
      url = page.url;
      openedPage = { name: page.name, kind: page.kind };
    }

    const result = await fns.navigate(url);

    // A live page is the site's own, which knows nothing about the prototype until
    // the patches land in it — opening the address and stopping there would show
    // the target page, not the prototype. A page of ours is rendered by the host
    // with its patches already inlined, so it needs nothing here.
    const opensLivePage = openedPage ? openedPage.kind === 'overlay' : entry.injectPatches;
    const applied = opensLivePage ? await fns.applyPrototype(slug) : null;

    // `entry.url` is the address we *asked* for — for a live page, the address
    // recorded on the prototype. Real sites redirect away from it all the time (a
    // sign-in wall is the usual reason), and the page on screen now is the one the
    // patches just landed on. So read where the window actually is instead of
    // reporting the request as if it were the result: the live URL comes from the
    // document itself, never from the prototype's config.
    const live = await getPageMetrics(fns);

    const target = openedPage
      ? `page "${openedPage.name}" (${openedPage.kind})`
      : entry.page
        ? `entry page "${entry.page}"`
        : 'the page index (no entry page is set)';
    const lines = [
      opensLivePage
        ? `Prototype "${slug}": opened ${target} — the live page it changes — and replayed its patches into it:`
        : `Prototype "${slug}": opened ${target} with every patch applied:`,
      `  ${url}`,
    ];
    if (live?.url && live.url !== url) lines.push(`  landed on: ${live.url}`);
    if (!openedPage && !entry.injectPatches && entry.path) lines.push(`  base: ${entry.path}`);
    lines.push(`  Title: ${result.title || '(untitled)'}`);
    if (applied && applied.applied > 0) {
      lines.push(`Replayed ${applied.applied} patch${applied.applied === 1 ? '' : 'es'}: ${applied.files.join(', ')}`);
    }
    lines.push('Edit and re-apply from here: patches added since this render still land on it.');

    return { output: lines.join('\n'), appendReleaseHint: true };
  }

  if (cmd === 'focus') {
    const instanceId = parts[1];
    const result = await fns.focusWindow(instanceId);
    const windows = await fns.listWindows();
    const target = windows.find((w) => w.id === result.instanceId);

    const lines = [
      `Focused browser window ${result.instanceId}`,
      `Title: ${result.title || 'New Tab'}`,
      `URL: ${result.url || 'about:blank'}`,
      `Session windows: ${summarizeWindows(windows)}`,
    ];
    if (target) {
      const lockState = target.boundSessionId ? `locked-session(${target.boundSessionId})` : 'unlocked';
      lines.push(`Lock state: ${lockState}, visible: ${target.isVisible}`);
    }

    return {
      output: lines.join('\n'),
      appendReleaseHint: true,
    };
  }

  if (cmd === 'windows') {
    const windows = await fns.listWindows();
    const available = windows.filter((w) => !w.boundSessionId || w.boundSessionId === args.sessionId).length;
    const lines: string[] = [`Browser windows (${windows.length}) — ${summarizeWindows(windows)}, availableToSession=${available}`];

    for (const w of windows) {
      const lockState = w.boundSessionId ? `locked-session(${w.boundSessionId})` : 'unlocked';
      const availableToSession = !w.boundSessionId || w.boundSessionId === args.sessionId;
      lines.push(
        '',
        `- ${w.id}`,
        `  title: ${w.title || 'New Tab'}`,
        `  url: ${w.url || 'about:blank'}`,
        ...(w.prototype
          ? [`  prototype: ${describePrototypeAt(w.prototype)}`]
          : []),
        `  visible: ${w.isVisible}`,
        `  ownerType: ${w.ownerType}`,
        `  ownerSessionId: ${w.ownerSessionId ?? 'none'}`,
        `  boundSessionId: ${w.boundSessionId ?? 'none'}`,
        `  lockState: ${lockState}`,
        `  availableToSession: ${availableToSession}`,
        `  agentControlActive: ${!!w.agentControlActive}`,
      );
    }

    return { output: lines.join('\n'), appendReleaseHint: false };
  }

  if (cmd === 'release') {
    const targetArg = parts[1];
    if (parts.length > 2) {
      throw new Error('release accepts at most one optional argument: [windowId|all]');
    }

    const before = await fns.listWindows();
    const activeOverlays = before.filter((w) => !!w.agentControlActive).length;
    const lifecycle = await fns.releaseControl(targetArg);
    const after = await fns.listWindows();
    const activeAfter = after.filter((w) => !!w.agentControlActive).length;

    const title = lifecycle.action === 'released'
      ? 'Browser control released. Agent overlay dismissed.'
      : 'No browser overlay was released.';

    return {
      output: [
        title,
        formatLifecycleResultLine(lifecycle),
        `Overlays active: ${activeOverlays} → ${activeAfter}`,
      ].join('\n'),
      appendReleaseHint: false,
    };
  }

  if (cmd === 'close') {
    const targetArg = parts[1];
    if (parts.length > 2) {
      throw new Error('close accepts at most one optional argument: [windowId]');
    }

    const before = await fns.listWindows();
    const lifecycle = await fns.closeWindow(targetArg);
    const after = await fns.listWindows();

    const title = lifecycle.action === 'closed'
      ? 'Browser window closed and destroyed.'
      : 'No browser window was closed.';

    return {
      output: [
        title,
        formatLifecycleResultLine(lifecycle),
        `Session windows: ${summarizeWindows(before)} → ${summarizeWindows(after)}`,
      ].join('\n'),
      appendReleaseHint: false,
    };
  }

  if (cmd === 'hide') {
    const targetArg = parts[1];
    if (parts.length > 2) {
      throw new Error('hide accepts at most one optional argument: [windowId]');
    }

    const before = await fns.listWindows();
    const lifecycle = await fns.hideWindow(targetArg);
    const after = await fns.listWindows();

    const title = lifecycle.action === 'hidden'
      ? 'Browser window hidden. Use "open" to show it again.'
      : 'No browser window was hidden.';

    return {
      output: [
        title,
        formatLifecycleResultLine(lifecycle),
        `Session windows: ${summarizeWindows(before)} → ${summarizeWindows(after)}`,
      ].join('\n'),
      appendReleaseHint: false,
    };
  }

  throw new Error(`Unknown browser_tool command "${cmd}". Use "--help" to see supported commands.`);
}
