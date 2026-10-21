#!/usr/bin/env bun
/**
 * browser-tool (secondary path)
 *
 * CLI helper for browser automation workflows in Craft Agents.
 *
 * This helper is intentionally thin and deterministic:
 * - It provides command discovery via --help
 * - It emits structured `browser_tool` command templates as JSON
 * - Execution still happens through the session's `browser_tool` in agent turns
 */

type CommandSpec = {
  name: string;
  args?: string;
  description: string;
  example: string;
};

type Io = {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

const COMMANDS: CommandSpec[] = [
  { name: 'help', description: 'Show usage', example: 'browser-tool --help' },
  { name: 'list', description: 'List supported browser_tool commands', example: 'browser-tool list' },
  { name: 'template', args: '<command>', description: 'Print a JSON template for one browser_tool command', example: 'browser-tool template navigate' },
  { name: 'all-templates', description: 'Print JSON templates for all browser_tool commands', example: 'browser-tool all-templates' },
  { name: 'parse-url', args: '<url>', description: 'Parse a URL and print structured fields for debugging', example: 'browser-tool parse-url file:///tmp/report.html' },
];

/**
 * Templates for the in-session `browser_tool` wrapper.
 *
 * Each entry is one `command` string the tool accepts. The old split `browser_*`
 * tools no longer exist, so templates are keyed by browser_tool's own verbs.
 */
const TOOL_TEMPLATES: Record<string, string> = {
  navigate: 'navigate https://example.com',
  snapshot: 'snapshot',
  read: 'read --save notes/my-page.md',
  find: 'find login button',
  click: 'click @e1',
  'click-at': 'click-at 350 200',
  drag: 'drag 100 200 300 400',
  fill: 'fill @e5 user@example.com',
  type: 'type Hello World',
  select: 'select @e3 optionValue',
  screenshot: 'screenshot --annotated',
  console: 'console 50 warn',
  evaluate: 'evaluate document.title',
  wait: 'wait network-idle 8000',
  tabs: 'tabs',
  profiles: 'profiles',
  'tab-new': 'tab-new https://example.com',
  'tab-show': 'tab-show tab-2 --handover',
  'tab-close': 'tab-close tab-2',
  'record-start': 'record-start --tab tab-2 --ttl 30s',
  'record-stop': 'record-stop --tab tab-2',
};

function printHelp(io: Io): void {
  io.log('browser-tool - Browser automation helper for Craft Agents');
  io.log('');
  io.log('Usage:');
  io.log('  bun run browser-tool <command> [args]');
  io.log('  bun run browser-tool --help');
  io.log('');
  io.log('Commands:');
  for (const cmd of COMMANDS) {
    const sig = cmd.args ? `${cmd.name} ${cmd.args}` : cmd.name;
    io.log(`  ${sig.padEnd(28)} ${cmd.description}`);
  }
  io.log('');
  io.log('Notes:');
  io.log('  - Primary execution path is the session\'s browser_tool command wrapper.');
  io.log('  - This CLI is a secondary helper for discovery and templating.');
  io.log('');
  io.log('Examples:');
  for (const cmd of COMMANDS) {
    io.log(`  ${cmd.example}`);
  }
}

function printJson(io: Io, value: unknown): void {
  io.log(JSON.stringify(value, null, 2));
}

function getFileBasename(pathname: string): string | null {
  const decodedPath = decodeURIComponent(pathname || '');
  const normalizedPath = decodedPath.replace(/\/+$/, '');
  if (!normalizedPath) return null;
  return normalizedPath.split('/').filter(Boolean).at(-1) || null;
}

export function parseUrlDetails(rawUrl: string): Record<string, unknown> {
  const parsed = new URL(rawUrl);
  const isFile = parsed.protocol === 'file:';

  return {
    href: parsed.href,
    protocol: parsed.protocol,
    host: parsed.host,
    hostname: parsed.hostname,
    pathname: parsed.pathname,
    search: parsed.search,
    hash: parsed.hash,
    origin: parsed.origin,
    ...(isFile
      ? {
          decodedPath: decodeURIComponent(parsed.pathname || ''),
          basename: getFileBasename(parsed.pathname),
        }
      : {}),
  };
}

export function runBrowserToolCli(argv: string[], io: Io = console): number {
  const args = argv.slice(2);
  const [command = 'help', op] = args;

  if (command === '--help' || command === '-h' || command === 'help') {
    printHelp(io);
    return 0;
  }

  if (command === 'list') {
    printJson(io, { operations: Object.keys(TOOL_TEMPLATES) });
    return 0;
  }

  if (command === 'template') {
    if (!op) {
      io.error('Error: template requires <command>');
      return 1;
    }
    const input = TOOL_TEMPLATES[op];
    if (!input) {
      io.error(`Error: unknown browser_tool command "${op}"`);
      return 1;
    }
    printJson(io, { tool: 'browser_tool', name: op, input: { command: input } });
    return 0;
  }

  if (command === 'all-templates') {
    const templates = Object.entries(TOOL_TEMPLATES).map(([name, input]) => ({
      name,
      input: { command: input },
    }));
    printJson(io, { tool: 'browser_tool', templates });
    return 0;
  }

  if (command === 'parse-url') {
    if (!op) {
      io.error('Error: parse-url requires <url>');
      return 1;
    }

    try {
      printJson(io, parseUrlDetails(op));
      return 0;
    } catch (error) {
      io.error(`Error: invalid URL "${op}"`);
      io.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  io.error(`Error: unknown command "${command}"\n`);
  printHelp(io);
  return 1;
}

if (import.meta.main) {
  process.exit(runBrowserToolCli(process.argv));
}
