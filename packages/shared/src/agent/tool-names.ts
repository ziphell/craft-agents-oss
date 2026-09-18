/**
 * Which pane tool a name is — the one place that decides.
 *
 * Two command wrappers drive the shared window: `browser_tool` (the window's own surface) and
 * `prototype_tool` (a prototype's files and flow). Everything that keys on a wrapper — the
 * overlay, tool display meta, the safe-mode allowlist — asks the question here, so the answer
 * cannot differ between them.
 *
 * A name arrives in three spellings: bare (`browser_tool`), namespaced (`mcp__session__browser_tool`,
 * `mcp__workspace__browser_tool`) and, for the browser, under the split names it shipped before the
 * commands were folded into one wrapper (`browser_snapshot`, …). They all denote the same tool.
 */

/** Names the browser's commands shipped under before they became one `browser_tool`. */
const LEGACY_BROWSER_TOOL_ALIASES = new Set<string>([
  'browser_open',
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_click_at',
  'browser_fill',
  'browser_select',
  'browser_screenshot',
  'browser_screenshot_region',
  'browser_console',
  'browser_window_resize',
  'browser_network',
  'browser_wait',
  'browser_key',
  'browser_downloads',
  'browser_scroll',
  'browser_back',
  'browser_forward',
  'browser_evaluate',
]);

/**
 * Which wrapper a tool name denotes: `'browser'`, `'prototype'`, or `null` for everything else
 * (an unrelated tool, an empty name).
 *
 * A legacy split name answers `'browser'`: it is the same tool under the name it used to have,
 * so a permission check or an icon must not depend on which spelling it appears in.
 * `(?:^|__)` before the name is what lets the namespaced forms through — `mcp__workspace__…` is
 * a namespace we do not enumerate, and a fourth one must not need this file changed.
 */
export function resolveToolName(toolName: string): 'browser' | 'prototype' | null {
  const normalized = toolName.trim().replace(/^(mcp__session__|session__)/, '');
  if (!normalized) return null;

  if (/(?:^|__)browser_tool$/i.test(normalized)) return 'browser';
  if (/(?:^|__)prototype_tool$/i.test(normalized)) return 'prototype';

  return LEGACY_BROWSER_TOOL_ALIASES.has(normalized) ? 'browser' : null;
}
