/**
 * Browser tool detection helpers.
 *
 * Browser overlay activation is driven by the two command wrappers — `browser_tool` and
 * `prototype_tool` — because both can drive a page. Which name denotes which wrapper is
 * `resolveToolName`'s question, answered once in `@craft-agent/shared/agent`.
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

/**
 * Prototype commands that never drive a page: they read or write the prototype's own files, or
 * report on them. Everything else in `prototype_tool` — `open`, `apply`, `clear`, `verify`,
 * `record`, the mocks — acts on a tab, and the overlay says so.
 *
 * `sample-video` belongs here with the rest: it reads a recording out of the filesystem, and the
 * only thing it shares with `record` is the kind of evidence it produces.
 */
const PROTOTYPE_TOOL_OVERLAY_EXCLUDED_COMMANDS = new Set([
  '--help',
  '-h',
  'help',
  'list',
  'create',
  'entry',
  'pages',
  'status',
  'export',
  'contract-compose',
  'contract-export',
  'sample-video',
])

export function getBrowserToolCommandVerb(toolInput: unknown): string {
  if (!toolInput || typeof toolInput !== 'object') return ''

  const command = (toolInput as { command?: unknown }).command
  if (typeof command !== 'string') return ''

  return command.trim().toLowerCase().split(/\s+/)[0] || ''
}

export function shouldActivateBrowserOverlay(toolName: string, toolInput: unknown): boolean {
  const tool = resolveToolName(toolName)
  const isBrowserTool = tool === 'browser'
  const isPrototypeTool = tool === 'prototype'
  if (!isBrowserTool && !isPrototypeTool) return false

  const verb = getBrowserToolCommandVerb(toolInput)
  if (!verb) return false

  return !(isPrototypeTool
    ? PROTOTYPE_TOOL_OVERLAY_EXCLUDED_COMMANDS
    : BROWSER_TOOL_OVERLAY_EXCLUDED_COMMANDS
  ).has(verb)
}

