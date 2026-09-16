/**
 * Preload script for browser toolbar windows.
 *
 * Exposes a minimal API for the React BrowserControls component
 * to send navigation actions and receive state updates from the
 * main process BrowserPaneManager.
 */

import { contextBridge, ipcRenderer } from 'electron'

const CHANNELS = {
  NAVIGATE: 'browser-toolbar:navigate',
  GO_BACK: 'browser-toolbar:go-back',
  GO_FORWARD: 'browser-toolbar:go-forward',
  RELOAD: 'browser-toolbar:reload',
  STOP: 'browser-toolbar:stop',
  MENU_GEOMETRY: 'browser-toolbar:menu-geometry',
  FORCE_CLOSE_MENU: 'browser-toolbar:force-close-menu',
  HIDE: 'browser-toolbar:hide',
  DESTROY: 'browser-toolbar:destroy',
  STATE_UPDATE: 'browser-toolbar:state-update',
  PICK_ELEMENT: 'browser-toolbar:pick-element',
  CANCEL_PICK: 'browser-toolbar:cancel-pick',
  APPLY_PROTOTYPE: 'browser-toolbar:apply-prototype',
  TABS: 'browser-toolbar:tabs',
} as const

// Instance ID is passed via query parameter by BrowserPaneManager
const instanceId = new URLSearchParams(location.search).get('instanceId') || ''

contextBridge.exposeInMainWorld('browserToolbar', {
  instanceId,
  navigate: (url: string) => ipcRenderer.invoke(CHANNELS.NAVIGATE, instanceId, url),
  goBack: () => ipcRenderer.invoke(CHANNELS.GO_BACK, instanceId),
  goForward: () => ipcRenderer.invoke(CHANNELS.GO_FORWARD, instanceId),
  reload: () => ipcRenderer.invoke(CHANNELS.RELOAD, instanceId),
  stop: () => ipcRenderer.invoke(CHANNELS.STOP, instanceId),
  setMenuGeometry: (open: boolean, height = 0) => ipcRenderer.invoke(CHANNELS.MENU_GEOMETRY, instanceId, open, height),
  hideWindow: () => ipcRenderer.invoke(CHANNELS.HIDE, instanceId),
  closeWindowEntirely: () => ipcRenderer.invoke(CHANNELS.DESTROY, instanceId),
  /**
   * Turn the window's element picker on — and leave it on.
   *
   * Resolves as soon as the mode is on, not when a pick happens: the user keeps
   * picking (and keeps moving between the window's pages while they do), and each
   * pick arrives on the host side as an `add-to-conversation` action. Page clicks
   * are suppressed for as long as the mode is on; `cancelPick`, or Escape in the
   * page, ends it.
   */
  pickElement: (addLabel?: string) => ipcRenderer.invoke(CHANNELS.PICK_ELEMENT, instanceId, addLabel),
  cancelPick: () => ipcRenderer.invoke(CHANNELS.CANCEL_PICK, instanceId),
  /** Ask the host to replay this session's prototype patches into this window. */
  applyPrototype: () => ipcRenderer.invoke(CHANNELS.APPLY_PROTOTYPE, instanceId),
  /**
   * Manage this window's own pages from the strip: switch to one, close one, add
   * one. The host owns what a page is, so nothing about it travels back here
   * except through `onStateUpdate`.
   */
  tabAction: (action: 'activate' | 'close' | 'new', tabId?: string) =>
    ipcRenderer.invoke(CHANNELS.TABS, instanceId, action, tabId),
  onStateUpdate: (callback: (state: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: unknown) => callback(state)
    ipcRenderer.on(CHANNELS.STATE_UPDATE, handler)
    return () => { ipcRenderer.removeListener(CHANNELS.STATE_UPDATE, handler) }
  },
  onForceCloseMenu: (callback: (payload: { reason?: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: { reason?: string }) => callback(payload)
    ipcRenderer.on(CHANNELS.FORCE_CLOSE_MENU, handler)
    return () => { ipcRenderer.removeListener(CHANNELS.FORCE_CLOSE_MENU, handler) }
  },
})
