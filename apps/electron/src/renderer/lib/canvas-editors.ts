/**
 * Which panel, in this window, is showing which canvas.
 *
 * The same hop the office editors make (`applyOfficeEdit`): the server can address the client, but
 * not a component, so the page keeps a table of whatever is mounted and hands the request to the
 * one that knows the path. A window with no matching panel answers "not here" and the caller writes
 * the file instead — which is the honest answer, not a fallback.
 */

import type { CanvasEditorReply, CanvasEditorRequest } from '@craft-agent/shared/canvas/bridge'

export type CanvasEditor = (request: CanvasEditorRequest) => Promise<CanvasEditorReply>

const editors = new Map<string, CanvasEditor>()

/** Normalize so `/a/b.json` and `C:\a\b.json` on Windows name the same file. */
function keyOf(path: string): string {
  const trimmed = path.trim()
  return /^[a-zA-Z]:[\\/]/.test(trimmed) ? trimmed.toLowerCase().replace(/\\/g, '/') : trimmed.replace(/\\/g, '/')
}

export function registerCanvasEditor(path: string, editor: CanvasEditor): () => void {
  const key = keyOf(path)
  editors.set(key, editor)
  return () => {
    if (editors.get(key) === editor) editors.delete(key)
  }
}

/** Hand a request to the panel showing `path`. `null` when nothing in this window is showing it. */
export async function dispatchCanvasRequest(request: CanvasEditorRequest): Promise<CanvasEditorReply | null> {
  const editor = editors.get(keyOf(request.path))
  if (!editor) return null
  return editor(request)
}
