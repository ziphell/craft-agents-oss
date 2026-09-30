/**
 * The writes a conversation already recorded — the events `deriveArtifactLinks`
 * merges into "which conversations touched which artifact".
 *
 * Pure over an already-parsed message array (no disk, no session store): a caller
 * that has a session's messages — the host reads them once per session — narrows
 * them here, and this file is the one place that decides what counts as a write.
 * Kept apart from `derive.ts` because it is a *reading* of one backend's message
 * shape, not the artifact rule itself.
 */

import type { StoredMessage } from '@craft-agent/core/types'
import { isArtifactPath, normalizeArtifactPath } from './derive.ts'
import type { ArtifactWriteEvent } from './types.ts'

/**
 * The tools whose input names a file they authored.
 *
 * `drawio_tool` is deliberately absent: it edits a diagram through an editor, and the
 * `.drawio` itself is written by the agent with Write/Edit — so the write, not the
 * tool that drove the editor, is what the artifact's history is made of.
 */
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

/**
 * Where a write tool keeps its target. The Edit family uses `file_path`, NotebookEdit
 * `notebook_path`; `path` is the last resort so a variant that names it that way is
 * still read. Order matters — the first key present wins.
 */
const TARGET_PATH_KEYS = ['file_path', 'notebook_path', 'path'] as const

/**
 * Every artifact a conversation's messages wrote.
 *
 * `workspaceRootPath` is what turns an absolute target into the relative identity an
 * artifact is known by; a path outside it is not this workspace's artifact and is
 * dropped, as is anything `isArtifactPath` refuses. The record's own timestamp is the
 * event's `at` — the last write in a session is the origin that matters.
 */
export function artifactWriteEventsFromMessages(
  sessionId: string,
  messages: StoredMessage[],
  workspaceRootPath: string,
): ArtifactWriteEvent[] {
  const events: ArtifactWriteEvent[] = []
  for (const message of messages) {
    if (!message.toolName || !WRITE_TOOLS.has(message.toolName)) continue
    const target = targetPathOf(message.toolInput)
    if (!target) continue
    const relativePath = toWorkspaceRelative(target, workspaceRootPath)
    if (!relativePath || !isArtifactPath(relativePath)) continue
    events.push({
      sessionId,
      path: normalizeArtifactPath(relativePath),
      at: message.timestamp ?? 0,
    })
  }
  return events
}

/** The target path a write tool's input names, or null when it names none. */
function targetPathOf(input: Record<string, unknown> | undefined): string | null {
  if (!input) return null
  for (const key of TARGET_PATH_KEYS) {
    const value = input[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

/**
 * A write's target as a workspace-relative POSIX path, or null when it is not inside
 * the workspace.
 *
 * Already-relative is the common case — an agent's paths are workspace-relative and
 * the store keeps them so. An absolute one (a Windows drive path the store never
 * rewrote, or a POSIX path outside the working directory) is made relative only when
 * it sits under the workspace root, and refused otherwise: a file the workspace does
 * not contain is not one of its artifacts.
 */
function toWorkspaceRelative(target: string, workspaceRootPath: string): string | null {
  const path = normalizeArtifactPath(target)
  if (!isAbsolutePath(path)) return escapesWorkspace(path) ? null : path

  const root = normalizeArtifactPath(workspaceRootPath).replace(/\/+$/, '')
  // The root is compared case-insensitively: Windows drive letters and macOS both
  // ignore case there, and a missed match would silently lose the origin.
  if (!path.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return null
  const relativePath = path.slice(root.length + 1)
  return escapesWorkspace(relativePath) ? null : relativePath
}

/** Whether a path is rooted — a POSIX absolute or a Windows drive path. */
function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:\//.test(path)
}

/** Whether a relative path climbs out of the workspace with a `..` segment. */
function escapesWorkspace(path: string): boolean {
  return path.split('/').includes('..')
}
