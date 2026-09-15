import type {
  BrowserConsoleArgs,
  BrowserDownloadsArgs,
  BrowserLifecycleActionResult,
  BrowserNetworkArgs,
  BrowserPaneFns,
  BrowserScreenshotRegionArgs,
  BrowserWaitArgs,
} from './browser-tools.ts';

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
    '  prototype-list                                 prototypes in this workspace, and which one is bound',
    '  prototype-create <name>                        create a prototype and bind this session to it',
    '  prototype-bind <slug|--clear>                  bind (or unbind) this session\'s prototype',
    '  prototype-apply [slug]                         replay prototype patches (survives reload)',
    '  prototype-clear [slug]                         remove prototype patches',
    '  prototype-export [slug]                        write dist HTML + dev spec',
    '  prototype-contract-compose [slug] [--service <svc>]   fragments → services/<svc>/openapi.yaml',
    '  prototype-contract-export [slug] [--service <svc>]    dist contract for the backend',
    '  prototype-mock-apply [slug] [--service <svc>]         serve x-mock responses (fetch + XHR)',
    '  prototype-mock-clear                                  stop serving the mock',
    '  prototype-status [slug]                               patches, services, exports, ownership',
    '  prototype-open [slug]                                 open the exported page (or base.html)',
    '  focus [windowId]                               focus existing browser window (no new window)',
    '  windows',
    '  release [windowId|all]                         dismiss agent overlay (user keeps browsing)',
    '  close [windowId]                               close & destroy the browser window',
    '  hide [windowId]                                hide the window (keeps state, "open" re-shows)',
    '',
    'Every prototype-* command except list/create/bind defaults to the prototype this session is',
    'bound to, so no slug is needed. Pass one to target a different prototype.',
    'Use "prototype-list" to see what exists and which one is bound.',
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
    '  prototype-create Checkout flow',
    '  prototype-apply                                (targets the bound prototype)',
    '  prototype-apply checkout-flow                  (explicit target)',
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
          'Create one with "prototype-create <name>", then open the running product and use "Capture base" to capture its rendered page.',
        ].join('\n'),
        appendReleaseHint: false,
      };
    }

    const lines = [
      `${prototypes.length} prototype${prototypes.length === 1 ? '' : 's'} in this workspace` +
      `${bound ? ` (this session is bound to "${bound}")` : ' (this session is not bound to one)'}:`,
    ];
    for (const prototype of prototypes) {
      const notes: string[] = [];
      if (prototype.slug === bound) notes.push('BOUND');
      if (!prototype.baseHtmlPresent) notes.push('no base.html');
      notes.push(`${prototype.patches.total} patch${prototype.patches.total === 1 ? '' : 'es'}`);
      lines.push(`  • ${prototype.slug} — ${notes.join(', ')}`);
    }

    return { output: lines.join('\n'), appendReleaseHint: false };
  }

  if (cmd === 'prototype-create') {
    const name = parts.slice(1).join(' ').trim();
    if (!name) {
      throw new Error('prototype-create needs a name. Example: prototype-create Checkout flow');
    }

    // Creating binds the session in the same step: the point of creating one from
    // a conversation is to work on it, and an unbound create would force the very
    // slug-passing this binding exists to remove.
    const created = await fns.createPrototype(name);
    await fns.bindPrototype(created.slug);

    return {
      output: [
        `Created prototype "${created.slug}" and bound this session to it.`,
        `  dir:  ${created.dir}`,
        `  base: ${created.baseHtmlPath} (starter page)`,
        '',
        'The prototype-* commands now target it by default.',
        'To start from the real product instead, open it in a browser window and have the user press "Capture base".',
      ].join('\n'),
      appendReleaseHint: false,
    };
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
    const lines = [
      `Prototype "${result.slug}": applied ${result.applied} patch${result.applied === 1 ? '' : 'es'}`,
    ];
    if (result.files.length > 0) {
      lines.push(...result.files.map((file) => `  • ${file}`));
    } else {
      lines.push('  (no patch files found — expected patches/{lane}-{nnn}-{slug}.{css|js})');
    }
    lines.push('Patches are also registered for future documents, so they survive a page reload.');

    return { output: lines.join('\n'), appendReleaseHint: true };
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
    return {
      output: [
        `Prototype "${result.slug}": exported ${result.applied} patch${result.applied === 1 ? '' : 'es'}`,
        `  HTML: ${result.htmlPath}`,
        `  Spec: ${result.specPath}`,
        '',
        'The HTML is self-contained — open it to verify it runs standalone:',
        `  browser_tool navigate ${result.htmlUrl}`,
      ].join('\n'),
      appendReleaseHint: true,
    };
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
    const laneSummary = Object.entries(status.patches.byLane)
      .map(([lane, count]) => `${lane}: ${count}`)
      .join(', ');

    const lines = [
      `Prototype "${status.slug}"`,
      `  dir:        ${status.dir}`,
      `  base.html:  ${status.baseHtmlPresent ? 'present' : 'MISSING — nothing to apply patches to'}`,
      `  patches:    ${status.patches.total}${laneSummary ? ` (${laneSummary})` : ''}`,
    ];

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

    const entry = await fns.prototypeEntry({ slug });
    const result = await fns.navigate(entry.url);

    return {
      output: [
        `Prototype "${slug}": opened ${entry.kind === 'export' ? 'the exported deliverable' : 'base.html'}`,
        `  ${entry.path}`,
        `  Title: ${result.title || '(untitled)'}`,
        entry.kind === 'base'
          ? '  Note: this is the un-exported page — patches are replayed separately with prototype-apply.'
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
      appendReleaseHint: true,
    };
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
