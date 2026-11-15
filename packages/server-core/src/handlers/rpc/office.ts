/**
 * The vendored GenOffice editors, addressed and exported.
 *
 * Three channels, in two families:
 *
 * - `getOrigin` is the same one-channel question drawio asks (`drawio.ts`): the only thing a
 *   renderer cannot work out for itself is the origin the bundle is served at, because its label
 *   carries a hash of the install path.
 * - `exportPdf` / `exportPages` are a **capability of the desktop host**, not a file transform:
 *   printing needs a Chromium, and the editor has to be the top document so its own `@media print`
 *   rules hide the chrome. A hub that runs no browser has no answer here, so the dependency is
 *   optional — the same shape as the poster seam.
 *
 * What the channels *do* own is the boundary: the path is validated with the same rule that lets
 * the app show the file, and the bytes are read here rather than handed in by the caller. A
 * renderer that could name any path would be a way to print files it cannot open.
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import {
  closeDocument,
  documentShownBy,
  isDocumentDirty,
  isDocumentOpen,
  openDocument,
  setDocumentDirty,
} from '@craft-agent/shared/office/open-documents'
import { CLIENT_DOCUMENT_FLUSH, CLIENT_OFFICE_APPLY_EDIT } from '../../transport/capabilities'
import type { OfficeEditRequest } from '@craft-agent/shared/office/open-documents'
import { getWorkspaceAllowedDirs, validateFilePath } from '../utils'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.office.GET_ORIGIN,
  RPC_CHANNELS.office.SET_DOCUMENT_OPEN,
  RPC_CHANNELS.office.SET_DOCUMENT_DIRTY,
  RPC_CHANNELS.office.EXPORT_PDF,
  RPC_CHANNELS.office.EXPORT_PAGES,
  RPC_CHANNELS.office.DECK,
  RPC_CHANNELS.office.WORKBOOK,
  RPC_CHANNELS.office.PDF,
] as const

/** Which editor prints a document, from its extension. The renderer's classification says the same. */
function exportAppFor(path: string): 'docs' | 'sheets' | 'slides' | 'pdf' | null {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'docx' || ext === 'doc' || ext === 'odt') return 'docs'
  if (ext === 'xlsx' || ext === 'xls' || ext === 'xlsm' || ext === 'ods') return 'sheets'
  if (ext === 'pptx' || ext === 'ppt' || ext === 'odp') return 'slides'
  if (ext === 'pdf') return 'pdf'
  return null
}

export function registerOfficeHandlers(server: RpcServer, deps: HandlerDeps): void {
  // Who is editing what. Nothing is written here — this is the registry the document tool asks
  // before it overwrites a file, and it lives in the process that owns the tool so the question
  // and the answer are in the same place.
  server.handle(
    RPC_CHANNELS.office.SET_DOCUMENT_OPEN,
    (ctx, path: string, open: boolean): boolean => {
      if (typeof path !== 'string' || !path) return false
      // The connection is remembered with the document: a frame can only be changed by the client
      // holding it, so "apply this here" is addressed to the one that said it had it open.
      if (open) openDocument(path, ctx.clientId)
      else closeDocument(path)
      return isDocumentOpen(path)
    },
  )

  server.handle(
    RPC_CHANNELS.office.SET_DOCUMENT_DIRTY,
    (_ctx, path: string, dirty: boolean): boolean => {
      if (typeof path !== 'string' || !path) return false
      setDocumentDirty(path, dirty === true)
      return isDocumentDirty(path)
    },
  )

  server.handle(RPC_CHANNELS.office.GET_ORIGIN, async () => {
    if (!deps.officeOrigin) {
      throw new Error(
        'This host cannot serve the editors’ own origin, so there is nowhere to render the document.',
      )
    }
    const origin = deps.officeOrigin()
    if (!origin) {
      throw new Error(
        'The GenOffice editors are not installed in this build. Run: bun scripts/build-office-assets.ts',
      )
    }
    return origin
  })

  /** The validated path and its bytes, or a refusal — shared by both exports. */
  async function source(path: string, ctx: { workspaceId: string | null; webContentsId: number | null }) {
    if (typeof path !== 'string' || !path) throw new Error('A document path is required.')
    const app = exportAppFor(path)
    if (!app) throw new Error(`The app cannot print ${path}: only .docx, .xlsx, .pptx and .pdf.`)

    const workspaceId = ctx.workspaceId ?? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId!)
    const safePath = await validateFilePath(path, getWorkspaceAllowedDirs(workspaceId, { sessionManager: deps.sessionManager }))
    const bytes = await readFile(safePath)
    return { app, path: safePath, bytes: new Uint8Array(bytes) }
  }

  server.handle(RPC_CHANNELS.office.EXPORT_PDF, async (ctx, path: string, outPath?: string) => {
    if (!deps.officeExportPdf) {
      // Not "no rendering process" in general: a hub's rendering process is the launcher this
      // dependency is built from, so its absence means the image has none staged.
      throw new Error(
        'This host cannot print documents: no rendering process is installed (resources/render-host).',
      )
    }
    const input = await source(path, ctx)
    // Default: next to the document, which is where a person looks for it.
    const target = outPath && outPath.trim()
      ? outPath
      : join(dirname(input.path), `${(input.path.split(/[\\/]/).pop() ?? 'document').replace(/\.[^.]+$/, '')}.pdf`)
    return deps.officeExportPdf({ ...input, outPath: target })
  })

  server.handle(RPC_CHANNELS.office.EXPORT_PAGES, async (ctx, path: string, outDir?: string) => {
    if (!deps.officeExportPages) {
      throw new Error(
        'This host cannot draw document pages: no rendering process is installed (resources/render-host).',
      )
    }
    const input = await source(path, ctx)
    const dir = outDir && outDir.trim() ? outDir : join(dirname(input.path), 'craft-export')
    return deps.officeExportPages({ ...input, outDir: dir })
  })

  /**
   * The workbook editor's calls. Same boundary as the deck: the leading path is validated before
   * the sidecar sees it, so a frame cannot name a file the app could not open.
   */
  server.handle(RPC_CHANNELS.office.WORKBOOK, async (ctx, method: string, args: unknown[] = []) => {
    if (!deps.officeWorkbook) {
      throw new Error('This host cannot open a workbook (the sidecar is not installed).')
    }
    if (typeof method !== 'string' || !method) throw new Error('An office method is required.')

    const [first, ...rest] = Array.isArray(args) ? args : []
    if (typeof first === 'string' && /[\\/]|\.(xlsx|xlsm|csv)$/i.test(first)) {
      const workspaceId = ctx.workspaceId ?? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId!)
      const safePath = await validateFilePath(first, getWorkspaceAllowedDirs(workspaceId, { sessionManager: deps.sessionManager }))
      return deps.officeWorkbook(method, [safePath, ...rest])
    }
    return deps.officeWorkbook(method, Array.isArray(args) ? args : [])
  })

  /** The pdf editor's calls: same boundary, the renderer edits bytes and the host writes them. */
  server.handle(RPC_CHANNELS.office.PDF, async (ctx, method: string, args: unknown[] = []) => {
    if (!deps.officePdf) throw new Error('This host cannot write a pdf.')
    if (typeof method !== 'string' || !method) throw new Error('An office method is required.')
    const [first, ...rest] = Array.isArray(args) ? args : []
    if (typeof first === 'string' && /[/]|.pdf$/i.test(first)) {
      const workspaceId = ctx.workspaceId ?? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId!)
      const safePath = await validateFilePath(first, getWorkspaceAllowedDirs(workspaceId, { sessionManager: deps.sessionManager }))
      return deps.officePdf(method, [safePath, ...rest])
    }
    return deps.officePdf(method, Array.isArray(args) ? args : [])
  })

  /**
   * The deck editor's calls, with the same boundary as everything else here: the path in front of
   * the arguments is validated before the host sees it, so a frame cannot name a file the app could
   * not open. The host keeps the deck; this handler only decides which paths may reach it.
   */
  server.handle(RPC_CHANNELS.office.DECK, async (ctx, method: string, args: unknown[] = []) => {
    if (!deps.officeDeck) {
      throw new Error('This host cannot hold a deck (the office engine is not installed).')
    }
    if (typeof method !== 'string' || !method) throw new Error('An office method is required.')

    const [first, ...rest] = Array.isArray(args) ? args : []
    if (typeof first === 'string' && /[\\/]|\.pptx?$/i.test(first)) {
      const workspaceId = ctx.workspaceId ?? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId!)
      const safePath = await validateFilePath(first, getWorkspaceAllowedDirs(workspaceId, { sessionManager: deps.sessionManager }))
      return deps.officeDeck(method, [safePath, ...rest])
    }
    return deps.officeDeck(method, Array.isArray(args) ? args : [])
  })
}

/**
 * Ask the editor showing a document to replace one span of it.
 *
 * Deliberately **not** a file write: the change lands inside the frame, as one step of its own
 * history, so the person can undo it and their caret stays where it was. Only that client can do
 * it, so the call is addressed to the connection that reported the document open.
 *
 * `null` means nothing is showing it — the caller says so, rather than writing the file behind an
 * editor that is not there.
 */
/**
 * Ask the editor showing `path` to save what it holds, and wait for the answer.
 *
 * `null` when nobody is showing it — the file is then already the newest version there is. `ok:
 * false` when the editor refused (a conflict it cannot resolve on its own), which the caller
 * reports rather than reading a file that is knowingly behind the screen.
 */
export async function requestDocumentFlush(
  server: RpcServer,
  path: string,
): Promise<{ ok: boolean; message?: string } | null> {
  const clientId = documentShownBy(path)
  if (!clientId) return null
  try {
    return (await server.invokeClient(clientId, CLIENT_DOCUMENT_FLUSH, { path })) as {
      ok: boolean
      message?: string
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Flush every document an editor is holding unsaved work for.
 *
 * Called before the agent touches anything, so that **every** read in the step — a `Read`, a
 * `Bash cat`, an `office_tool` command, an export — sees the screen rather than the debounce. It
 * costs nothing when nothing is open, which is most of the time.
 *
 * Two documents in the same step is possible (a document and the diagram beside it), so they are
 * asked in parallel: each is a different editor and neither waits on the other.
 */
export async function requestDirtyDocumentFlush(
  server: RpcServer,
  paths: string[],
  timeoutMs = 4000,
): Promise<{ path: string; ok: boolean; message?: string }[]> {
  if (paths.length === 0) return []
  const flush = Promise.all(
    paths.map(async (path) => {
      const result = await requestDocumentFlush(server, path)
      return { path, ok: result === null || result.ok, ...(result?.message ? { message: result.message } : {}) }
    }),
  )
  // A client that never answers must not hold a tool call open: what is on the disk is still a
  // usable answer, just an older one.
  return Promise.race([flush, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs))]).catch(
    () => paths.map((path) => ({ path, ok: false, message: 'the editor did not answer in time' })),
  )
}

export async function requestOfficeEdit(
  server: RpcServer,
  path: string,
  edit: OfficeEditRequest,
): Promise<{ ok: boolean; message?: string } | null> {
  const clientId = documentShownBy(path)
  if (!clientId) return null
  try {
    return (await server.invokeClient(clientId, CLIENT_OFFICE_APPLY_EDIT, { path, edit })) as {
      ok: boolean
      message?: string
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}
