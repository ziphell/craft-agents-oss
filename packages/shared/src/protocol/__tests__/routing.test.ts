import { describe, test, expect } from 'bun:test'
import { getAllChannelValues, RPC_CHANNELS } from '../channels'
import { LOCAL_ONLY_CHANNELS, REMOTE_ELIGIBLE_CHANNELS } from '../routing'

describe('channel routing exhaustiveness', () => {
  const all = getAllChannelValues()

  test('every channel is classified exactly once', () => {
    for (const ch of all) {
      const inLocal = LOCAL_ONLY_CHANNELS.has(ch)
      const inRemote = REMOTE_ELIGIBLE_CHANNELS.has(ch)

      if (!inLocal && !inRemote) {
        throw new Error(`Channel "${ch}" is not classified in LOCAL_ONLY or REMOTE_ELIGIBLE. Add it to one set in routing.ts.`)
      }
      if (inLocal && inRemote) {
        throw new Error(`Channel "${ch}" is in BOTH LOCAL_ONLY and REMOTE_ELIGIBLE. It must be in exactly one.`)
      }
    }
  })

  test('no extra channels in LOCAL_ONLY', () => {
    for (const ch of LOCAL_ONLY_CHANNELS) {
      expect(all).toContain(ch)
    }
  })

  test('no extra channels in REMOTE_ELIGIBLE', () => {
    for (const ch of REMOTE_ELIGIBLE_CHANNELS) {
      expect(all).toContain(ch)
    }
  })

  test('sets are non-empty', () => {
    expect(LOCAL_ONLY_CHANNELS.size).toBeGreaterThan(0)
    expect(REMOTE_ELIGIBLE_CHANNELS.size).toBeGreaterThan(0)
  })

  test('total classified equals total channels', () => {
    expect(LOCAL_ONLY_CHANNELS.size + REMOTE_ELIGIBLE_CHANNELS.size).toBe(all.length)
  })
})

describe('channel routing behavior', () => {
  test('LOCAL_ONLY and REMOTE_ELIGIBLE have zero intersection', () => {
    const intersection: string[] = []
    for (const ch of LOCAL_ONLY_CHANNELS) {
      if (REMOTE_ELIGIBLE_CHANNELS.has(ch)) {
        intersection.push(ch)
      }
    }
    expect(intersection).toEqual([])
  })

  test('all server:* channels are REMOTE_ELIGIBLE', () => {
    const serverChannels = Object.values(RPC_CHANNELS.server)
    expect(serverChannels.length).toBeGreaterThan(0)

    for (const ch of serverChannels) {
      expect(REMOTE_ELIGIBLE_CHANNELS.has(ch)).toBe(true)
    }
  })

  test('no LOCAL_ONLY channel starts with server:', () => {
    for (const ch of LOCAL_ONLY_CHANNELS) {
      if (ch.startsWith('server:')) {
        throw new Error(`server:* channel "${ch}" must be REMOTE_ELIGIBLE, not LOCAL_ONLY`)
      }
    }
  })

  /**
   * A remote window's configuration belongs to the server that runs its work. These were local
   * once, which made a checkbox in a remote window change this machine and leave the hub alone.
   */
  test('workspace creation and the agent host\'s settings travel with the workspace server', () => {
    const serverOwned = [
      RPC_CHANNELS.workspaces.CREATE,
      RPC_CHANNELS.workspaces.CHECK_SLUG,
      RPC_CHANNELS.server.REMOVE_WORKSPACE,
      RPC_CHANNELS.onboarding.GET_AUTH_STATE,
      RPC_CHANNELS.onboarding.DEFER_SETUP,
      RPC_CHANNELS.onboarding.VALIDATE_MCP,
      RPC_CHANNELS.tools.GET_BROWSER_TOOL_ENABLED,
      RPC_CHANNELS.tools.SET_BROWSER_TOOL_ENABLED,
      RPC_CHANNELS.appearance.GET_RICH_TOOL_DESCRIPTIONS,
      RPC_CHANNELS.appearance.SET_RICH_TOOL_DESCRIPTIONS,
      RPC_CHANNELS.caching.GET_EXTENDED_PROMPT_CACHE,
      RPC_CHANNELS.caching.SET_EXTENDED_PROMPT_CACHE,
      RPC_CHANNELS.caching.GET_ENABLE_1M_CONTEXT,
      RPC_CHANNELS.caching.SET_ENABLE_1M_CONTEXT,
      RPC_CHANNELS.rtk.GET_ENABLED,
      RPC_CHANNELS.rtk.SET_ENABLED,
      RPC_CHANNELS.rtk.GET_STATUS,
      RPC_CHANNELS.rtk.GET_GAIN,
      RPC_CHANNELS.decisions.GET_SETTINGS,
      RPC_CHANNELS.decisions.SET_SETTINGS,
      RPC_CHANNELS.decisions.GET_STATUS,
      RPC_CHANNELS.decisions.SET_API_KEY,
      RPC_CHANNELS.decisions.DELETE_API_KEY,
      RPC_CHANNELS.decisions.TEST,
      RPC_CHANNELS.decisions.PROBE_SERVER,
    ]

    for (const ch of serverOwned) {
      expect(REMOTE_ELIGIBLE_CHANNELS.has(ch)).toBe(true)
    }
  })
})
