import { join } from 'path'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import { pushTyped, type RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.projects.GET,
  RPC_CHANNELS.projects.GET_ONE,
  RPC_CHANNELS.projects.LAYERS,
  RPC_CHANNELS.projects.FILES,
  RPC_CHANNELS.projects.CREATE,
  RPC_CHANNELS.projects.UPDATE,
  RPC_CHANNELS.projects.DELETE,
  RPC_CHANNELS.projects.LIST_ASSETS,
  RPC_CHANNELS.projects.UPLOAD_ASSET,
  RPC_CHANNELS.projects.DELETE_ASSET,
] as const

/**
 * Names at the top of a project folder that belong to the app rather than to the author.
 * The same rule the layers report applies (`specs.ts`), so the file tree shows the author's
 * files and not the app's own bookkeeping.
 */
const APP_OWNED_NAMES = new Set(['config.json', 'MEMORY.md', 'assets'])

/**
 * Recursive file tree of a folder, for the session info panel's project files tab.
 *
 * Hidden entries and the app's own top-level names are skipped. Directories that end up empty
 * are dropped, and each level is ordered directories-first then by name — the same shape the
 * session file tree uses (`sessions.ts`), so both render through one view.
 */
async function scanProjectDirectory(dirPath: string): Promise<import('@craft-agent/shared/protocol').SessionFile[]> {
  const { readdir, stat } = await import('fs/promises')
  const entries = await readdir(dirPath, { withFileTypes: true })
  const files: import('@craft-agent/shared/protocol').SessionFile[] = []

  for (const entry of entries) {
    if (entry.name.startsWith('.') || APP_OWNED_NAMES.has(entry.name)) continue

    const fullPath = join(dirPath, entry.name)

    if (entry.isDirectory()) {
      const children = await scanProjectDirectory(fullPath)
      if (children.length > 0) {
        files.push({ name: entry.name, path: fullPath, type: 'directory', children })
      }
    } else if (entry.isFile()) {
      const stats = await stat(fullPath)
      files.push({ name: entry.name, path: fullPath, type: 'file', size: stats.size })
    }
  }

  return files.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

export function registerProjectsHandlers(server: RpcServer, deps: HandlerDeps): void {
  const log = deps.platform.logger

  async function broadcastChanged(workspaceId: string, workspaceRootPath: string): Promise<void> {
    const { loadWorkspaceProjects } = await import('@craft-agent/shared/projects')
    const projects = loadWorkspaceProjects(workspaceRootPath)
    pushTyped(server, RPC_CHANNELS.projects.CHANGED, { to: 'workspace', workspaceId }, workspaceId, projects)
  }

  // List all projects for a workspace
  server.handle(RPC_CHANNELS.projects.GET, async (_ctx, workspaceId: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) {
      log.error(`PROJECTS_GET: Workspace not found: ${workspaceId}`)
      return []
    }
    const { loadWorkspaceProjects } = await import('@craft-agent/shared/projects')
    return loadWorkspaceProjects(workspace.rootPath)
  })

  // Get one project (by id or slug)
  server.handle(RPC_CHANNELS.projects.GET_ONE, async (_ctx, workspaceId: string, projectIdOrSlug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) return null
    const { loadProject, loadProjectById } = await import('@craft-agent/shared/projects')
    return loadProject(workspace.rootPath, projectIdOrSlug)
      ?? loadProjectById(workspace.rootPath, projectIdOrSlug)
  })

  // Read one project's work report — its goal, specs and plans — from its own folder
  server.handle(RPC_CHANNELS.projects.LAYERS, async (_ctx, workspaceId: string, projectSlug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) return null
    const { buildProjectLayers } = await import('@craft-agent/shared/projects')
    return buildProjectLayers(workspace.rootPath, projectSlug)
  })

  // List one project folder's files (recursive tree) for the session info panel
  server.handle(RPC_CHANNELS.projects.FILES, async (_ctx, workspaceId: string, projectSlug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) return []
    const { loadProject } = await import('@craft-agent/shared/projects')
    const project = loadProject(workspace.rootPath, projectSlug)
    if (!project) return []
    try {
      return await scanProjectDirectory(project.folderPath)
    } catch (error) {
      log.error('Failed to get project files:', error)
      return []
    }
  })

  // Create a new project
  server.handle(RPC_CHANNELS.projects.CREATE, async (_ctx, workspaceId: string, input: import('@craft-agent/shared/projects').CreateProjectInput) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const { createProject } = await import('@craft-agent/shared/projects')
    const project = createProject(workspace.rootPath, {
      name: input.name?.trim() || 'New Project',
      description: input.description,
      workingDirectory: input.workingDirectory,
      details: input.details,
      colorTheme: input.colorTheme,
    })
    await broadcastChanged(workspaceId, workspace.rootPath)
    log.info(`Created project: ${project.slug}`)
    return project
  })

  // Update project (partial patch). Slug stays stable.
  server.handle(RPC_CHANNELS.projects.UPDATE, async (
    _ctx,
    workspaceId: string,
    projectSlug: string,
    patch: Partial<Omit<import('@craft-agent/shared/projects').ProjectConfig, 'id' | 'slug' | 'createdAt'>>,
  ) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const { updateProject } = await import('@craft-agent/shared/projects')

    const updated = updateProject(workspace.rootPath, projectSlug, patch)

    await broadcastChanged(workspaceId, workspace.rootPath)
    return updated
  })

  // Delete a project; unbinds projectId from any sessions that referenced it.
  server.handle(RPC_CHANNELS.projects.DELETE, async (_ctx, workspaceId: string, projectSlug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)

    const { loadProject, deleteProject } = await import('@craft-agent/shared/projects')
    const project = loadProject(workspace.rootPath, projectSlug)
    if (!project) {
      log.warn(`PROJECTS_DELETE: project ${projectSlug} not found`)
      return
    }

    const { unbindProjectFromSessions } = await import('@craft-agent/shared/sessions')
    const touched = await unbindProjectFromSessions(workspace.rootPath, project.config.id)
    deleteProject(workspace.rootPath, projectSlug)
    await broadcastChanged(workspaceId, workspace.rootPath)
    log.info(`Deleted project ${projectSlug} (unbound ${touched} sessions)`)
  })

  // List assets in a project
  server.handle(RPC_CHANNELS.projects.LIST_ASSETS, async (_ctx, workspaceId: string, projectSlug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) return []
    const { listProjectAssets } = await import('@craft-agent/shared/projects')
    return listProjectAssets(workspace.rootPath, projectSlug)
  })

  // Upload an asset (base64 / text / sourcePath)
  server.handle(RPC_CHANNELS.projects.UPLOAD_ASSET, async (
    _ctx,
    workspaceId: string,
    projectSlug: string,
    input: import('@craft-agent/shared/projects').UploadProjectAssetInput,
  ) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const { uploadProjectAsset } = await import('@craft-agent/shared/projects')
    const asset = uploadProjectAsset(workspace.rootPath, projectSlug, input)
    await broadcastChanged(workspaceId, workspace.rootPath)
    log.info(`Uploaded asset ${asset.filename} to project ${projectSlug}`)
    return asset
  })

  // Delete an asset by filename
  server.handle(RPC_CHANNELS.projects.DELETE_ASSET, async (
    _ctx,
    workspaceId: string,
    projectSlug: string,
    filename: string,
  ) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const { deleteProjectAsset } = await import('@craft-agent/shared/projects')
    deleteProjectAsset(workspace.rootPath, projectSlug, filename)
    await broadcastChanged(workspaceId, workspace.rootPath)
  })
}
