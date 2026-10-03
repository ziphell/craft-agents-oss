/**
 * Browser tool detection helpers.
 *
 * Browser overlay activation is driven by `browser_tool` alone — the one command wrapper that drives
 * a page. Which name denotes that wrapper is `resolveToolName`'s question, answered once in
 * `@craft-agent/shared/agent`.
 */

import { resolveToolName } from '@craft-agent/shared/agent'

const BROWSER_TOOL_OVERLAY_EXCLUDED_COMMANDS = new Set([
  '--help',
  '-h',
  'help',
  'open',
  'release',
  'close',
  'hide',
])

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
