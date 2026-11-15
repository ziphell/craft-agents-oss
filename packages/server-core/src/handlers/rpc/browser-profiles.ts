/**
 * Browser profile registry RPC.
 *
 * A profile is a named Chromium session — its own cookies, `localStorage` and logins — and the UI
 * needs two things from this layer: the list, and the ability to add / rename / remove one. Which
 * profile a window or a conversation *works in* is not decided here (see the browser pane and
 * session layers); this is only the registry.
 *
 * `default` is the built-in profile and the one every login lived in before profiles existed, so it
 * cannot be renamed or removed: doing either would strand that session rather than delete it.
 */

import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import {
  DEFAULT_BROWSER_PROFILE_ID,
  generateBrowserProfileId,
  getBrowserProfiles,
  getWorkspaceByNameOrId,
  saveBrowserProfiles,
  type BrowserProfile,
} from '@craft-agent/shared/config'
import { loadSessionHeader } from '@craft-agent/shared/sessions'
import { loadProjectById } from '@craft-agent/shared/projects'
import { loadWorkspaceConfig } from '@craft-agent/shared/workspaces'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.browserProfiles.LIST,
  RPC_CHANNELS.browserProfiles.CREATE,
  RPC_CHANNELS.browserProfiles.RENAME,
  RPC_CHANNELS.browserProfiles.DELETE,
  RPC_CHANNELS.browserProfiles.RESOLVE,
] as const

const MAX_NAME_LENGTH = 64

function normalizedName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : ''
  if (!name) throw new Error('A browser profile needs a name.')
  if (name.length > MAX_NAME_LENGTH) {
    throw new Error(`A browser profile name may be at most ${MAX_NAME_LENGTH} characters.`)
  }
  return name
}

export function registerBrowserProfileHandlers(server: RpcServer, _deps: HandlerDeps): void {
  server.handle(RPC_CHANNELS.browserProfiles.LIST, async (): Promise<BrowserProfile[]> => {
    return getBrowserProfiles()
  })

  server.handle(
    RPC_CHANNELS.browserProfiles.CREATE,
    async (_ctx, name: string): Promise<BrowserProfile> => {
      const profile: BrowserProfile = {
        id: generateBrowserProfileId(),
        name: normalizedName(name),
        createdAt: Date.now(),
      }
      if (!saveBrowserProfiles([...getBrowserProfiles(), profile])) {
        throw new Error('Could not save browser profiles — no config file found.')
      }
      return profile
    },
  )

  server.handle(
    RPC_CHANNELS.browserProfiles.RENAME,
    async (_ctx, id: string, name: string): Promise<void> => {
      if (id === DEFAULT_BROWSER_PROFILE_ID) {
        throw new Error('The default browser profile cannot be renamed.')
      }
      const profiles = getBrowserProfiles()
      const profile = profiles.find((candidate) => candidate.id === id)
      if (!profile) throw new Error(`Browser profile "${id}" not found.`)

      const renamed = profiles.map((candidate) =>
        candidate.id === id ? { ...candidate, name: normalizedName(name) } : candidate,
      )
      if (!saveBrowserProfiles(renamed)) {
        throw new Error('Could not save browser profiles — no config file found.')
      }
    },
  )

  server.handle(
    RPC_CHANNELS.browserProfiles.DELETE,
    async (_ctx, id: string): Promise<void> => {
      if (id === DEFAULT_BROWSER_PROFILE_ID) {
        throw new Error('The default browser profile cannot be removed.')
      }
      const profiles = getBrowserProfiles()
      if (!profiles.some((candidate) => candidate.id === id)) {
        throw new Error(`Browser profile "${id}" not found.`)
      }

      // The registry entry goes; its partition (and that profile's cookies) is left on disk. A
      // conversation that picked it keeps that id as an explicit invalid reference — its old
      // window stays usable, but sending is refused until the person picks an existing profile.
      // Project and workspace defaults fall through to the next level instead of naming it.
      if (!saveBrowserProfiles(profiles.filter((candidate) => candidate.id !== id))) {
        throw new Error('Could not save browser profiles — no config file found.')
      }
    },
  )

  /**
   * Which profile a conversation works in, and what it is inheriting.
   *
   * Read from the session header, project and workspace files rather than from live state, so a
   * conversation that is not loaded still answers: the picker renders for whatever conversation
   * is on screen, and those files are the same source the browser side resolves against.
   */
  server.handle(
    RPC_CHANNELS.browserProfiles.RESOLVE,
    async (ctx, sessionId: string): Promise<{
      sessionProfileId: string | null
      projectProfileId: string | null
      workspaceDefaultProfileId: string | null
      effectiveProfileId: string
    }> => {
      const workspace = ctx.workspaceId ? getWorkspaceByNameOrId(ctx.workspaceId) : null
      if (!workspace) {
        return {
          sessionProfileId: null,
          projectProfileId: null,
          workspaceDefaultProfileId: null,
          effectiveProfileId: DEFAULT_BROWSER_PROFILE_ID,
        }
      }

      const session = loadSessionHeader(workspace.rootPath, sessionId)
      // The conversation's own pick is reported even when that profile was deleted: it is an
      // explicit invalid reference the picker shows (and blocks sending on), not something to
      // silently replace. Project/workspace defaults are inherited, so only those skip ids that
      // no longer exist.
      const known = new Set(getBrowserProfiles().map((profile) => profile.id))
      const existing = (id?: string | null): string | null =>
        id && known.has(id) ? id : null

      const sessionProfileId = session?.browserProfile?.trim() || null
      const projectProfileId = existing(
        session?.projectId
          ? loadProjectById(workspace.rootPath, session.projectId)?.config.browserProfile
          : null,
      )
      const workspaceDefaultProfileId = existing(loadWorkspaceConfig(workspace.rootPath)?.defaults?.browserProfile)
      return {
        sessionProfileId,
        projectProfileId,
        workspaceDefaultProfileId,
        effectiveProfileId:
          sessionProfileId ?? projectProfileId ?? workspaceDefaultProfileId ?? DEFAULT_BROWSER_PROFILE_ID,
      }
    },
  )
}
