/**
 * Browser tool detection helpers.
 *
 * Browser overlay activation is driven by `browser_tool` alone — the one command wrapper that drives
 * a page. Which name denotes that wrapper is `resolveToolName`'s question, answered once in
 * `@craft-agent/shared/agent`.
 */

import { resolveToolName } from '@craft-agent/shared/agent'

const BROWSER_TOOL_OVERLAY_EXCLUDED_COMMANDS = new Set(['--help', '-h', 'help'])

/** The commands that are the entry point to a page — see {@link browserToolOpensWindow}. */
const BROWSER_TOOL_WINDOW_OPENING_COMMANDS = new Set(['navigate', 'tab-new'])

export function getBrowserToolCommandVerb(toolInput: unknown): string {
  if (!toolInput || typeof toolInput !== 'object') return ''

  const command = (toolInput as { command?: unknown }).command
  if (typeof command !== 'string') return ''

  return command.trim().toLowerCase().split(/\s+/)[0] || ''
}

export function shouldActivateBrowserOverlay(toolName: string, toolInput: unknown): boolean {
  if (resolveToolName(toolName) !== 'browser') return false

  const verb = getBrowserToolCommandVerb(toolInput)
  if (!verb) return false

  return !BROWSER_TOOL_OVERLAY_EXCLUDED_COMMANDS.has(verb)
}

/**
 * Whether this command is one that can open the workspace's browser window.
 *
 * Only these may be given a window **before** they run, so the control overlay's tab
 * hold is already in place when they take their tab. Every other command either acts on
 * a window that already exists or has no page to act on at all; creating one for it would
 * make a read look like it opened a browser and leave an empty window behind when the
 * command then fails.
 */
export function browserToolOpensWindow(toolInput: unknown): boolean {
  return BROWSER_TOOL_WINDOW_OPENING_COMMANDS.has(getBrowserToolCommandVerb(toolInput))
}
