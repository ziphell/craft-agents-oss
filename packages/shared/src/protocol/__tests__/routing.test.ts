import { describe, test, expect } from 'bun:test'
import { getAllChannelValues, RPC_CHANNELS } from '../channels'
import {
  LOCAL_ONLY_CHANNELS,
  REMOTE_ELIGIBLE_CHANNELS,
  isLocalOnly,
  isRemoteEligible,
} from '../routing'

/**
 * `LOCAL_ONLY` is the only routing list anyone writes by hand; everything else is remote by
 * construction. So the test that matters is no longer "is every channel classified" (it cannot
 * fail any more) but "is the curated list still exactly what we agreed on" — adding or removing
 * a local channel is a decision, and it has to show up in a diff.
 */
const EXPECTED_LOCAL_ONLY = [
  'auth:logout',
  'auth:showDeleteSessionConfirmation',
  'auth:showLogoutConfirmation',
  'badge:draw',
  'badge:draw-windows',
  'badge:refresh',
  'badge:setIcon',
  'debug:log',
  'deeplink:navigate',
  'dialog:openFolder',
  'drawio:getOrigin',
  'file:openDialog',
  'file:readUserAttachment',
  'gitbash:browse',
  'gitbash:check',
  'gitbash:setPath',
  'input:getSendMessageKey',
  'input:getSpellCheck',
  'input:setSendMessageKey',
  'input:setSpellCheck',
  'menu:copy',
  'menu:cut',
  'menu:keyboardShortcuts',
  'menu:maximize',
  'menu:minimize',
  'menu:newChat',
  'menu:newWindow',
  'menu:openSettings',
  'menu:paste',
  'menu:quit',
  'menu:redo',
  'menu:selectAll',
  'menu:toggleDevTools',
  'menu:toggleFocusMode',
  'menu:toggleSidebar',
  'menu:undo',
  'menu:zoomIn',
  'menu:zoomOut',
  'menu:zoomReset',
  'notification:getEnabled',
  'notification:navigate',
  'notification:setEnabled',
  'notification:show',
  'onboarding:startMcpOAuth',
  'power:getKeepAwake',
  'power:setKeepAwake',
  'releaseNotes:get',
  'releaseNotes:getLatestVersion',
  'settings:getNetworkProxy',
  'settings:setNetworkProxy',
  'shell:openFile',
  'shell:openUrl',
  'shell:showInFolder',
  'skills:openEditor',
  'skills:openFinder',
  'system:homeDir',
  'system:isDebugMode',
  'system:versions',
  'theme:appChanged',
  'theme:broadcastPreferences',
  'theme:broadcastWorkspaceTheme',
  'theme:getAllWorkspaceThemes',
  'theme:getApp',
  'theme:getColorTheme',
  'theme:getPresets',
  'theme:getSystemPreference',
  'theme:getWorkspaceColorTheme',
  'theme:loadPreset',
  'theme:preferencesChanged',
  'theme:setColorTheme',
  'theme:setWorkspaceColorTheme',
  'theme:systemChanged',
  'theme:workspaceThemeChanged',
  'update:available',
  'update:check',
  'update:dismiss',
  'update:downloadProgress',
  'update:getDismissed',
  'update:getInfo',
  'update:install',
  'window:cancelClose',
  'window:close',
  'window:closeRequested',
  'window:confirmClose',
  'window:focusState',
  'window:getFocusState',
  'window:getMaximizedState',
  'window:getMode',
  'window:getWorkspace',
  'window:maximizedState',
  'window:openDesignWindow',
  'window:openSessionInNewWindow',
  'window:openWorkspace',
  'window:setTrafficLights',
  'window:switchWorkspace',
  'workspaces:get',
]

describe('channel routing table', () => {
  const all = getAllChannelValues()

  test('every LOCAL_ONLY entry is a real channel', () => {
    for (const channel of LOCAL_ONLY_CHANNELS) {
      expect(all).toContain(channel)
    }
  })

  test('LOCAL_ONLY is exactly this list', () => {
    expect([...LOCAL_ONLY_CHANNELS].sort()).toEqual(EXPECTED_LOCAL_ONLY)
  })

  test('REMOTE_ELIGIBLE is exactly the complement — the sets partition the protocol', () => {
    const expected = all.filter((channel) => !LOCAL_ONLY_CHANNELS.has(channel)).sort()
    expect([...REMOTE_ELIGIBLE_CHANNELS].sort()).toEqual(expected)
    expect(LOCAL_ONLY_CHANNELS.size + REMOTE_ELIGIBLE_CHANNELS.size).toBe(all.length)
  })

  test('isRemoteEligible is the exact complement of isLocalOnly', () => {
    for (const channel of all) {
      expect(isRemoteEligible(channel)).toBe(!isLocalOnly(channel))
    }
  })
})

describe('channel routing behavior', () => {
  test('LOCAL_ONLY and REMOTE_ELIGIBLE have zero intersection', () => {
    const intersection = [...LOCAL_ONLY_CHANNELS].filter((channel) => REMOTE_ELIGIBLE_CHANNELS.has(channel))
    expect(intersection).toEqual([])
  })

  test('all server:* channels are REMOTE_ELIGIBLE', () => {
    const serverChannels = Object.values(RPC_CHANNELS.server)
    expect(serverChannels.length).toBeGreaterThan(0)

    for (const channel of serverChannels) {
      expect(REMOTE_ELIGIBLE_CHANNELS.has(channel)).toBe(true)
    }
  })

  test('no LOCAL_ONLY channel starts with server:', () => {
    for (const channel of LOCAL_ONLY_CHANNELS) {
      if (channel.startsWith('server:')) {
        throw new Error(`server:* channel "${channel}" must be REMOTE_ELIGIBLE, not LOCAL_ONLY`)
      }
    }
  })

  /**
   * A remote window's configuration belongs to the server that runs its work. These were local
   * once, which made a checkbox in a remote window change this machine and leave the hub alone.
   *
   * This is the assertion that still catches a real mistake: a channel quietly moved into
   * LOCAL_ONLY would no longer be answered by the hub.
   */
  test('workspace creation and the agent host\'s settings travel with the workspace server', () => {
    const serverOwned = [
      RPC_CHANNELS.workspaces.CREATE,
      RPC_CHANNELS.workspaces.CHECK_SLUG,
      RPC_CHANNELS.server.REMOVE_WORKSPACE,
      RPC_CHANNELS.server.LIST_DEVICE_TOKENS,
      RPC_CHANNELS.server.CREATE_DEVICE_TOKEN,
      RPC_CHANNELS.server.REMOVE_DEVICE_TOKEN,
      RPC_CHANNELS.server.SET_DEVICE_TOKEN_SCOPE,
      RPC_CHANNELS.onboarding.GET_AUTH_STATE,
      RPC_CHANNELS.onboarding.DEFER_SETUP,
      RPC_CHANNELS.onboarding.VALIDATE_MCP,
      RPC_CHANNELS.settings.GET_SERVER_CONFIG,
      RPC_CHANNELS.settings.SET_SERVER_CONFIG,
      RPC_CHANNELS.settings.GET_SERVER_STATUS,
      RPC_CHANNELS.tools.GET_BROWSER_TOOL_ENABLED,
      RPC_CHANNELS.tools.SET_BROWSER_TOOL_ENABLED,
      RPC_CHANNELS.tools.GET_COMPUTER_USE_ENABLED,
      RPC_CHANNELS.tools.SET_COMPUTER_USE_ENABLED,
      RPC_CHANNELS.tools.GET_ALLOW_REMOTE_DESKTOP_DRIVE,
      RPC_CHANNELS.tools.SET_ALLOW_REMOTE_DESKTOP_DRIVE,
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

    for (const channel of serverOwned) {
      expect(REMOTE_ELIGIBLE_CHANNELS.has(channel)).toBe(true)
    }
  })
})
