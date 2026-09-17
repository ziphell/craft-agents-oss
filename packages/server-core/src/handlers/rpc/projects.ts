import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import { pushTyped, type RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.projects.GET,
  RPC_CHANNELS.projects.GET_ONE,
  RPC_CHANNELS.projects.CREATE,
  RPC_CHANNELS.projects.UPDATE,
  RPC_CHANNELS.projects.DELETE,
  RPC_CHANNELS.projects.LIST_ASSETS,
  RPC_CHANNELS.projects.UPLOAD_ASSET,
  RPC_CHANNELS.projects.DELETE_ASSET,
] as const

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
    patch: Partial<Omit<import('@craft-agent/shared/projects').ProjectConfig, 'id' | 'slug' | 'createdAt' | 'prototypeSlugs'>> & {
      /** The whole new set of prototypes this project is worked on with (§15.1.3); the field is routed to its validated writer. */
      prototypeSlugs?: string[];
    },
  ) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const { updateProject } = await import('@craft-agent/shared/projects')

    // `prototypeSlugs` is the set of prototypes a project is worked on with (§15.1.3), and
    // it is not a plain field: only one thing may write it and it drops the slugs that no
    // longer resolve, so the field is routed to that writer instead of being merged like
    // the rest. The caller sends the whole set — ticking the last prototype off sends an
    // empty list, which is the clear, so nothing has to travel as `null`.
    const { prototypeSlugs, ...rest } = patch
    let updated = updateProject(workspace.rootPath, projectSlug, rest)
    if (Object.prototype.hasOwnProperty.call(patch, 'prototypeSlugs')) {
      const { setProjectPrototypes } = await import('@craft-agent/shared/prototypes')
      updated = setProjectPrototypes(workspace.rootPath, projectSlug, prototypeSlugs ?? [])
    }

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
