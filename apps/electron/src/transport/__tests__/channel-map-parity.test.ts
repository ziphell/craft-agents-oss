import { describe, it, expect } from 'bun:test'
import type { ElectronAPI } from '../../shared/types'
import { CHANNEL_MAP } from '../channel-map'

type AnyFn = (...args: any[]) => any

type FunctionKeys<T> = {
  [K in keyof T]-?: Extract<T[K], AnyFn> extends never ? never : K
}[keyof T] & string

type BrowserPaneKeys = `browserPane.${FunctionKeys<ElectronAPI['browserPane']>}`
type BrowserProfileKeys = `browserProfiles.${FunctionKeys<ElectronAPI['browserProfiles']>}`

// Methods excluded from CHANNEL_MAP because they are implemented directly in the preload
// (no IPC round-trip to the main process). Each reads local state or orchestrates client-side.
type ApiToChannelMapKeys = Exclude<
  FunctionKeys<ElectronAPI>,
  | 'performOAuth'
  | 'getTransportConnectionState'
  | 'getRuntimeEnvironment'
  | 'onTransportConnectionStateChanged'
  | 'reconnectTransport'
  | 'isChannelAvailable'
  | 'getSystemWarnings' // reads env var set at startup — no IPC needed
  | 'relaunchApp' // direct IPC to main process — not through WS RPC
  | 'getClientMode' // direct IPC to main process — this window's connection
  | 'saveRemoteConnection' // direct IPC to main process — saved server list
  | 'removeRemoteConnection' // direct IPC to main process — saved server list
  | 'setDefaultRemoteConnection' // direct IPC to main process — launch behaviour
  | 'connectToRemoteConnection' // direct IPC to main process — opens a window
  | 'testClientModeConnection' // direct IPC to main process — tests a server not routed through WS
  | 'listRemoteDirectories' // direct IPC — browses a saved server that may not be this window's
  | 'getRemoteHomeDir' // direct IPC — that same server's home directory
  | 'listRemoteWorkspaces' // direct IPC — the server's workspaces for the dropdown
  | 'getRemoteConnectionStatuses' // direct IPC — app-level link state, not the window's
  | 'setWindowTitle' // direct IPC — per-window title, not a WS call
  | 'onRemoteTargetChanged' // preload-local listener — the edited server target
  | 'checkRemoteWorkspaceSlug' // direct IPC — workspace creation targeted at that server
  | 'createRemoteWorkspace' // direct IPC — registered on that server, not through the window
  | 'openRemoteWindow' // direct IPC to main process — opens a window, not a WS call
  | 'openLocalWindow' // direct IPC to main process — opens a window, not a WS call
  | 'switchRemoteWorkspace' // direct IPC + a rebuilt hub connection, not a channel-map call
  | 'switchRemoteServer' // direct IPC + a rebuilt hub connection, not a channel-map call
  | 'switchLocalWorkspace' // direct IPC + a released hub connection, not a channel-map call
  | 'getWebContentsId' // preload-local — current window identity, no IPC round-trip
  | 'getClientIdentity' // preload-local — stable device identity, no IPC round-trip
  | 'transferSessionToWorkspace' // direct IPC to main process — orchestrated remote transfer
  | 'onTransferProgress' // direct IPC listener — chunk upload progress
  | 'changeLanguage' // direct IPC to main process — syncs i18n language
  | 'getFilePath' // renderer-local — webUtils.getPathForFile, no IPC round-trip
  | 'saveDesignExport' // direct IPC to main — saves a hub-produced file, no WS payload
> | BrowserPaneKeys
  | BrowserProfileKeys
type ChannelMapKeys = keyof typeof CHANNEL_MAP & string

type AssertNever<T extends never> = true

// Compile-time guardrails: if these fail, CHANNEL_MAP and ElectronAPI drifted.
const _missingFromMap: AssertNever<Exclude<ApiToChannelMapKeys, ChannelMapKeys>> = true
const _extraInMap: AssertNever<Exclude<ChannelMapKeys, ApiToChannelMapKeys>> = true

void _missingFromMap
void _extraInMap

describe('CHANNEL_MAP runtime contract', () => {
  it('has valid entry kinds and channels', () => {
    for (const [method, entry] of Object.entries(CHANNEL_MAP)) {
      expect(typeof method).toBe('string')
      expect(entry.type === 'invoke' || entry.type === 'listener').toBe(true)
      expect(typeof entry.channel).toBe('string')
      expect(entry.channel.length).toBeGreaterThan(0)

      if (entry.type === 'listener') {
        expect((entry as any).transform).toBeUndefined()
      }
    }
  })

  it('contains at least one listener and one invoke entry', () => {
    const values = Object.values(CHANNEL_MAP)
    expect(values.some((entry) => entry.type === 'listener')).toBe(true)
    expect(values.some((entry) => entry.type === 'invoke')).toBe(true)
  })
})
