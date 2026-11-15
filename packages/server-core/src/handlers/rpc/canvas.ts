/**
 * Canvases, from the app's side of the wire — the same shape the document editors already use.
 *
 * **The panel showing a canvas owns it.** `OPEN` marks it (through `openDocument`, which the office
 * editors and drawio also use), `CLOSE` unmarks it, and while it is marked:
 *
 * - the panel applies edits and saves them here (`WRITE`) — its own history is the undo stack, so
 *   Ctrl+Z is a local step, not a round trip;
 * - an agent's batch is delivered **to that panel** (`CLIENT_CANVAS_REQUEST`) and becomes one step
 *   of the same history, attributed to the agent. If the panel refuses, the agent is told, and no
 *   file is written behind a screen that is showing something else;
 * - an agent's read asks the panel first (`snapshot`), so it never reads a document that is a second
 *   behind the screen.
 *
 * With nobody showing it there is no editor to ask and no history to join, so a write is just a
 * write — still guarded by `revision`, and still announced (`CHANGED`) so a panel that opens later
 * reads the newest version.
 *
 * What this handler never does is decide what an edit means: `applyCanvasOps` is in shared code and
 * both sides run the same one.
 */

import { existsSync, rmSync } from 'fs'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import { loadProjectById } from '@craft-agent/shared/projects'
import { closeDocument, documentShownBy, openDocument } from '@craft-agent/shared/office'
import {
  canvasEditorBridge,
  canvasFiles,
  canvasPath,
  CanvasWriteConflict,
  setCanvasEditorBridge,
  type CanvasApplyToEditorReply,
  type CanvasDoc,
  type CanvasViewport,
} from '@craft-agent/shared/canvas'
import { pushTyped, type RpcServer } from '@craft-agent/server-core/transport'
import { CLIENT_CANVAS_REQUEST } from '../../transport/capabilities'
import type { HandlerDeps } from '../handler-deps'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.canvas.LIST,
  RPC_CHANNELS.canvas.CREATE,
  RPC_CHANNELS.canvas.OPEN,
  RPC_CHANNELS.canvas.CLOSE,
  RPC_CHANNELS.canvas.READ,
  RPC_CHANNELS.canvas.WRITE,
  RPC_CHANNELS.canvas.VIEWPORT,
  RPC_CHANNELS.canvas.DELETE,
] as const

/** The folder a canvas belongs to. A canvas has no existence outside a project. */
function projectFolder(workspaceId: string, projectId: string): string {
  const workspace = getWorkspaceByNameOrId(workspaceId)
  if (!workspace) throw new Error(`unknown workspace ${workspaceId}`)
  const project = loadProjectById(workspace.rootPath, projectId)
  if (!project) throw new Error(`unknown project ${projectId}`)
  return project.folderPath
}

/** `<project>/canvas.json` — one canvas per project. The old slug is accepted and ignored. */
function fileOf(workspaceId: string, projectId: string, _slug?: string): string {
  return canvasPath(projectFolder(workspaceId, projectId))
}

export function registerCanvasHandlers(server: RpcServer, _deps: HandlerDeps): void {
  // The editor's side of the same decision. Installed here because this is the half of the process
  // that can address a client; the caller only knows the interface (see canvas/bridge.ts).
  setCanvasEditorBridge({
    async apply(request): Promise<CanvasApplyToEditorReply | null> {
      const clientId = documentShownBy(request.path)
      if (!clientId) return null
      try {
        return (await server.invokeClient(clientId, CLIENT_CANVAS_REQUEST, {
          kind: 'apply',
          ...request,
        })) as CanvasApplyToEditorReply
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },
    async history(path, action): Promise<CanvasApplyToEditorReply | null> {
      const clientId = documentShownBy(path)
      if (!clientId) return null
      try {
        return (await server.invokeClient(clientId, CLIENT_CANVAS_REQUEST, { kind: action, path })) as CanvasApplyToEditorReply
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },
    async snapshot(path): Promise<CanvasDoc | null> {
      const clientId = documentShownBy(path)
      if (!clientId) return null
      try {
        const reply = (await server.invokeClient(clientId, CLIENT_CANVAS_REQUEST, { kind: 'snapshot', path })) as {
          ok: boolean
          doc?: CanvasDoc
        }
        return reply.ok && reply.doc ? reply.doc : null
      } catch {
        return null
      }
    },
  })

  const announce = (workspaceId: string, path: string, doc: CanvasDoc, origin: 'user' | 'agent', label: string, ids: string[]) => {
    pushTyped(server, RPC_CHANNELS.canvas.CHANGED, { to: 'workspace', workspaceId }, workspaceId, {
      path,
      revision: doc.revision,
      origin,
      label,
      ids,
      history: { canUndo: false, canRedo: false, depth: 0 },
    })
  }

  server.handle(RPC_CHANNELS.canvas.LIST, async (_ctx, workspaceId: string, projectId: string) => {
    return canvasFiles.list(projectFolder(workspaceId, projectId))
  })

  server.handle(RPC_CHANNELS.canvas.CREATE, async (_ctx, workspaceId: string, projectId: string, name: string) => {
    const created = canvasFiles.create(projectFolder(workspaceId, projectId), name)
    return { slug: created.slug, doc: created.doc }
  })

  server.handle(RPC_CHANNELS.canvas.OPEN, async (ctx, workspaceId: string, projectId: string, _slug?: string) => {
    const opened = canvasFiles.open(projectFolder(workspaceId, projectId))
    // `openDocument` is the app's own "somebody is showing this" count — the same one `office_tool`
    // consults before it edits a document. The client id is what makes a request addressable.
    openDocument(opened.path, ctx.clientId)
    return { slug: 'canvas', doc: opened.doc, openers: 1 }
  })

  server.handle(RPC_CHANNELS.canvas.CLOSE, async (_ctx, workspaceId: string, projectId: string, _slug?: string) => {
    closeDocument(fileOf(workspaceId, projectId))
    return { closed: true }
  })

  server.handle(RPC_CHANNELS.canvas.READ, async (_ctx, workspaceId: string, projectId: string, _slug?: string) => {
    const opened = canvasFiles.open(projectFolder(workspaceId, projectId))
    // The panel's copy is newer than the file while its save is in flight — ask it first.
    const fromEditor = await canvasFileFromEditor(opened.path)
    return fromEditor ?? opened.doc
  })

  server.handle(
    RPC_CHANNELS.canvas.WRITE,
    async (
      _ctx,
      workspaceId: string,
      projectId: string,
      _slug: string | undefined,
      request: { doc: CanvasDoc; expectedRevision: number; ids?: string[]; label?: string },
    ) => {
      const path = canvasFiles.open(projectFolder(workspaceId, projectId)).path
      try {
        const saved = canvasFiles.write(path, { ...request.doc, revision: request.expectedRevision }, request.ids ?? [])
        announce(workspaceId, path, saved.doc, 'user', request.label ?? '编辑', saved.ids)
        return { doc: saved.doc, revision: saved.doc.revision }
      } catch (error) {
        if (error instanceof CanvasWriteConflict) {
          // Somebody else wrote while this panel was working. Answer with what is there so the
          // panel can say so, rather than dropping the person's edit silently.
          announce(workspaceId, path, error.doc, 'agent', '其他人保存了这张画布', [])
          return { conflict: true as const, expectedRevision: error.expectedRevision, actualRevision: error.actualRevision, doc: error.doc }
        }
        throw error
      }
    },
  )

  server.handle(
    RPC_CHANNELS.canvas.VIEWPORT,
    async (_ctx, workspaceId: string, projectId: string, _slug: string | undefined, viewport: Partial<CanvasViewport>) => {
      const path = canvasFiles.open(projectFolder(workspaceId, projectId)).path
      const doc = canvasFiles.writeViewport(path, viewport)
      return { revision: doc.revision }
    },
  )

  server.handle(RPC_CHANNELS.canvas.DELETE, async (_ctx, workspaceId: string, projectId: string, _slug?: string) => {
    const path = fileOf(workspaceId, projectId)
    if (!existsSync(path)) return { deleted: false }
    closeDocument(path)
    rmSync(path, { force: true })
    return { deleted: true }
  })
}

/** The document a panel is holding, when one is; used by reads so the screen wins over the file. */
async function canvasFileFromEditor(path: string): Promise<CanvasDoc | null> {
  const bridge = canvasEditorBridge()
  return bridge ? bridge.snapshot(path) : null
}
