/**
 * Preload script for browser toolbar windows.
 *
 * Exposes a minimal API for the React BrowserControls component
 * to send navigation actions and receive state updates from the
 * main process BrowserPaneManager.
 */

import { contextBridge, ipcRenderer } from 'electron'
import type { TabBelongsTo } from '@craft-agent/shared/protocol'

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
  EDIT: 'browser-toolbar:edit',
  CANCEL_EDIT: 'browser-toolbar:cancel-edit',
  TABS: 'browser-toolbar:tabs',
  DEVTOOLS: 'browser-toolbar:devtools',
  RECORD: 'browser-toolbar:record',
  RECORD_CHUNK: 'browser-toolbar:record-chunk',
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
   * picking (and keeps moving between the window's tabs while they do), and each
   * pick arrives on the host side as an `add-to-conversation` action. Page clicks
   * are suppressed for as long as the mode is on; `cancelPick`, or Escape in the
   * page, ends it.
   */
  pickElement: (addLabel?: string) => ipcRenderer.invoke(CHANNELS.PICK_ELEMENT, instanceId, addLabel),
  cancelPick: () => ipcRenderer.invoke(CHANNELS.CANCEL_PICK, instanceId),
  /**
   * Turn the window's element editor on — and leave it on.
   *
   * Resolves as soon as the mode is on, not when an edit happens: the person keeps
   * boxing elements and retyping text, and each save travels back as an
   * `edit-requested` action, which the main window writes as one patch. Nothing is
   * written before that, so leaving the mode (`cancelEdit`, or Escape in the page)
   * takes the unsaved edits back. Arming this takes the picker off, and the other way
   * round: one overlay per window.
   *
   * `labels` are the bar's own words — the page has no i18n, and this renderer does.
   */
  startEditing: (labels?: { undo: string; save: string; discard: string }) =>
    ipcRenderer.invoke(CHANNELS.EDIT, instanceId, labels),
  cancelEdit: () => ipcRenderer.invoke(CHANNELS.CANCEL_EDIT, instanceId),
  /**
   * Manage this window's own tabs from the rail: switch to one, close one, add one,
   * or take a locked tab back (`release`). The host owns what a tab is, so nothing
   * about it travels back here except through `onStateUpdate`.
   *
   * `work` belongs to `new` alone, and only when the tab is being opened **for** a piece
   * of work rather than as one more of the person's own: the `+` on a section header,
   * which asks for a tab in that conversation's section (plan §22).
   */
  tabAction: (
    action: 'activate' | 'close' | 'new' | 'release',
    tabId?: string,
    work?: TabBelongsTo | null,
  ) => ipcRenderer.invoke(CHANNELS.TABS, instanceId, action, tabId, work),
  /**
   * Open the developer tools for the tab on screen, or close them if they are up.
   *
   * They belong to the tab rather than the window: switching or closing that tab puts
   * them away, and whether they are up comes back through `onStateUpdate` — the tools
   * can also be closed from their own window, which this side never sees otherwise.
   */
  toggleDevTools: () => ipcRenderer.invoke(CHANNELS.DEVTOOLS, instanceId),
  /**
   * The record button.
   *
   * `start` arms a recording of the tab on screen — the host opens the file, in the
   * person's downloads folder — and answers with what the button should draw. The
   * extension is the container the caller is about to record into (`mp4`, `webm`): the file
   * is named before the picture exists, so the two have to be decided together.
   * The picture is not taken here: right after this, this renderer asks for display
   * media and the host hands it that exact tab, which is the only thing it hands back.
   * `stop` closes the file and answers with where it went.
   */
  startRecording: (extension?: string) => ipcRenderer.invoke(CHANNELS.RECORD, instanceId, 'start', extension),
  stopRecording: () => ipcRenderer.invoke(CHANNELS.RECORD, instanceId, 'stop'),
  /**
   * One encoded chunk of the recording, in the order produced.
   *
   * `send` rather than `invoke`: there is nothing to say back, and a dozen answers to
   * "did you write it" per recording would be a second thing to keep in order. The
   * host appends each one as it arrives, and the stop that follows the last chunk is
   * on the same channel, so it cannot overtake it.
   */
  sendRecordingChunk: (chunk: ArrayBuffer) => ipcRenderer.send(CHANNELS.RECORD_CHUNK, instanceId, chunk),
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
