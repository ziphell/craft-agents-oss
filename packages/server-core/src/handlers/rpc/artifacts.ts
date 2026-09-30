/**
 * Artifacts RPC — the app's own read of the files it and an agent co-edit.
 *
 * The library has no store of its own: an artifact is a file on disk, so the one thing
 * a caller cannot work out for itself is the answer to "which files, and how new". That
 * is a walk of the workspace (`scanArtifactFiles`) and a pure decision about it
 * (`deriveArtifactEntries`) — the same two the renderer would run, held here because
 * only the host has the disk. Nothing is written and nothing is pushed: a caller re-reads.
 *
 * `artifacts:origins` is the other direction of the same link. It answers out of the
 * conversations' own history (see `artifacts-origins.ts`), so neither side of the link
 * is a record of its own.
 *
 * `artifacts:thumbnail` is the one that has to *draw*: a preview is the file turned
 * into a picture by the bundled drawio engine (`artifacts-thumbnails.ts`), which is
 * expensive and can legitimately be unavailable. It answers with null rather than an
 * error — the row it feeds shows its icon either way.
 */

import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import type { ArtifactEntry, ArtifactOrigin, ArtifactThumbnail } from '@craft-agent/shared/artifacts'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.artifacts.LIST,
  RPC_CHANNELS.artifacts.ORIGINS,
  RPC_CHANNELS.artifacts.THUMBNAIL,
] as const

export function registerArtifactsHandlers(server: RpcServer, deps: HandlerDeps): void {
  const log = deps.platform.logger

  // Every artifact in a workspace, newest first. The walk keeps the pure half renderer-safe
  // (`@craft-agent/shared/artifacts` has no `node:fs`), which is why the scan is imported
  // from its own subpath rather than through the barrel.
  server.handle(RPC_CHANNELS.artifacts.LIST, async (_ctx, workspaceId: string): Promise<ArtifactEntry[]> => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) {
      log.error(`ARTIFACTS_LIST: Workspace not found: ${workspaceId}`)
      return []
    }
    const { scanArtifactFiles } = await import('@craft-agent/shared/artifacts/scan')
    const { deriveArtifactEntries } = await import('@craft-agent/shared/artifacts')
    return deriveArtifactEntries(scanArtifactFiles(workspace.rootPath))
  })

  // The conversations that wrote one artifact. Derived from the sessions' own history and
  // cached in memory (`artifacts-origins.ts`); nothing is stored, so this answers "who
  // touched this file" without a second record that could disagree with the sessions.
  server.handle(RPC_CHANNELS.artifacts.ORIGINS, async (_ctx, workspaceId: string, relativePath: string): Promise<ArtifactOrigin[]> => {
    if (typeof relativePath !== 'string' || relativePath.length === 0) return []
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) {
      log.error(`ARTIFACTS_ORIGINS: Workspace not found: ${workspaceId}`)
      return []
    }
    const { artifactOriginsForWorkspace } = await import('./artifacts-origins')
    return artifactOriginsForWorkspace(workspace.rootPath, relativePath)
  })

  // A small drawn preview of one artifact, or null. Drawing is the app's own engine in a
  // hidden window, so a host without one — a headless server — has no preview to give; it
  // says so with null rather than an error, because the row that asked shows its icon either
  // way. The file is read here, not in the renderer: the bytes have to come from the disk
  // the workspace is on, which is this host's.
  server.handle(
    RPC_CHANNELS.artifacts.THUMBNAIL,
    async (_ctx, workspaceId: string, relativePath: string): Promise<ArtifactThumbnail | null> => {
      if (typeof relativePath !== 'string' || relativePath.length === 0) return null
      const workspace = getWorkspaceByNameOrId(workspaceId)
      if (!workspace) {
        log.error(`ARTIFACTS_THUMBNAIL: Workspace not found: ${workspaceId}`)
        return null
      }
      const browserPaneManager = deps.browserPaneManager
      if (!browserPaneManager) return null

      const { artifactThumbnailForFile } = await import('./artifacts-thumbnails')
      return artifactThumbnailForFile({
        filePath: absoluteArtifactPath(workspace.rootPath, relativePath),
        render: (xml) => browserPaneManager.renderDrawio({ xml, format: 'svg' }),
      })
    },
  )
}

/** A workspace-relative POSIX path as an absolute one, with the separator the root itself uses. */
function absoluteArtifactPath(rootPath: string, relativePath: string): string {
  const separator = rootPath.includes('\\') ? '\\' : '/'
  return `${rootPath}${separator}${relativePath.split('/').join(separator)}`
}
