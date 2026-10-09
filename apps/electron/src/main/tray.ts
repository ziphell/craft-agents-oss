/**
 * The tray — the app when no window is showing.
 *
 * Closing a window puts it away rather than destroying it (see the `close`
 * handler in window-manager), so the app stays alive with nothing on screen.
 * The tray is the one surface that is always there: it brings a window back, and
 * it is the only way to quit on Windows/Linux, where the native menu is hidden.
 *
 * Main-process only: no RPC, no renderer. The menu is rebuilt each time it is
 * opened, so it always reflects the windows and workspaces that exist now — there
 * is no config file and nothing to keep in sync (see docs/tray-plan.md).
 */

import { Tray, Menu, app, nativeImage, nativeTheme, type MenuItemConstructorOptions } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { i18n } from '@craft-agent/shared/i18n'
import { getWorkspaces } from '@craft-agent/shared/config'
import { mainLog } from './logger'
import type { WindowManager } from './window-manager'

/** There is one tray per process — a second `new Tray` would stack a second icon. */
let tray: Tray | null = null

/** Keeps the macOS menu-bar icon in step with the system appearance. */
let themeListener: (() => void) | null = null

/** A file under the bundled resources (packaged: dist/resources, dev: ../resources). */
function resourcePath(...parts: string[]): string | null {
  const candidates = [
    join(__dirname, 'resources', ...parts),
    join(__dirname, '../resources', ...parts),
  ]
  return candidates.find(existsSync) ?? null
}

/**
 * The tray image.
 *
 * macOS gets one of **two monochrome icons** — black on a light menu bar, white on
 * a dark one — because the colored app icon looks wrong up there. They are a pair
 * rather than a template image on purpose: the mark keeps its own weight instead of
 * being reinterpreted as a silhouette. Each ships at 1x and 2x (`tray-black.png`
 * beside `tray-black@2x.png`, which Electron picks up on its own).
 *
 * Windows/Linux get the app's own mark, **cropped to its content**: the app icon
 * carries transparent padding for its own reasons, and shrinking that padding along
 * with the mark left the tray icon noticeably smaller than the icons beside it.
 */
function trayImage(): Electron.NativeImage {
  if (process.platform === 'darwin') {
    const name = nativeTheme.shouldUseDarkColors ? 'tray-white.png' : 'tray-black.png'
    const monochrome = resourcePath('craft-logos', name)
    if (monochrome) return nativeImage.createFromPath(monochrome)
    mainLog.warn(`[tray] ${name} not found — falling back to the app icon`)
  }

  // Prepared from the app icon with the padding trimmed (16px + a 32px @2x). Not
  // resized here, so the 2x representation survives for denser display scaling.
  const prepared = resourcePath('craft-logos', 'tray-app.png')
  if (prepared) return nativeImage.createFromPath(prepared)

  const appIcon = resourcePath('icon.png')
  if (!appIcon) {
    mainLog.warn('[tray] app icon not found — the tray will show an empty icon')
    return nativeImage.createEmpty()
  }
  return nativeImage.createFromPath(appIcon).resize({ width: 16, height: 16 })
}

/**
 * The workspace a new window should open for when nothing is open any more: the
 * last one that was used, else the first that exists.
 */
function fallbackWorkspaceId(windowManager: WindowManager): string | undefined {
  return windowManager.getLastActiveWorkspaceId() ?? getWorkspaces()[0]?.id
}

/**
 * The menu, built fresh so it always matches what is open.
 *
 * It lists **workspaces**, not windows: a workspace's window is its home, and any
 * extra window is a temporary view the person is using right now — not the tray's
 * business (see docs/tray-plan.md §3.3).
 */
function buildMenu(windowManager: WindowManager): Menu {
  const workspaces = getWorkspaces()
  const items: MenuItemConstructorOptions[] = []

  // One entry per workspace: show its window, or open one if it has none.
  for (const workspace of workspaces) {
    items.push({
      label: workspace.name,
      click: () => windowManager.focusOrCreateWindow(workspace.id),
    })
  }
  if (workspaces.length > 0) items.push({ type: 'separator' })

  items.push({
    label: i18n.t('menu.newWindow'),
    click: () => {
      const workspaceId = fallbackWorkspaceId(windowManager)
      if (workspaceId) windowManager.createWindow({ workspaceId })
    },
  })

  items.push({ type: 'separator' })
  items.push({ label: i18n.t('menu.quitCraftAgents'), click: () => app.quit() })

  return Menu.buildFromTemplate(items)
}

/**
 * Create the tray, once. Subsequent calls are a no-op (the app is single-instance,
 * but this is the belt to that suspenders — see docs/tray-plan.md §3.6).
 *
 * @returns whether a tray is now present. The caller only makes the app resident
 *   when there is a way back to it — a tray that could not be created means closing
 *   a window must still quit, or the app would sit invisible.
 */
export function createTray(windowManager: WindowManager): boolean {
  if (tray) return true

  try {
    tray = new Tray(trayImage())
  } catch (error) {
    // A tray that could not be created must not take the app down with it — the
    // windows are still usable, only the always-there surface is missing.
    mainLog.error('[tray] failed to create the tray:', error)
    tray = null
    return false
  }

  tray.setToolTip(app.getName())

  // The macOS menu bar can flip between light and dark while the app is running, so
  // the black/white icon has to follow it.
  if (process.platform === 'darwin') {
    themeListener = () => {
      if (tray && !tray.isDestroyed()) tray.setImage(trayImage())
    }
    nativeTheme.on('updated', themeListener)
  }

  const openMenu = () => {
    if (tray && !tray.isDestroyed()) tray.popUpContextMenu(buildMenu(windowManager))
  }
  const raiseApp = () => {
    const workspaceId = fallbackWorkspaceId(windowManager)
    if (workspaceId) windowManager.raiseOrCreateWindow(workspaceId)
  }

  if (process.platform === 'darwin') {
    // A macOS status item's click *is* its menu — that is where the app is reached.
    tray.on('click', openMenu)
  } else {
    // Windows/Linux: left-click brings the app back, the menu is the right button.
    tray.on('click', raiseApp)
  }
  tray.on('right-click', openMenu)

  mainLog.info('[tray] created')
  return true
}

/**
 * Take the tray icon down. Windows leaves an icon behind until the mouse passes
 * over it if it is not destroyed, so this has to run on the way out.
 */
export function destroyTray(): void {
  if (themeListener) {
    nativeTheme.removeListener('updated', themeListener)
    themeListener = null
  }
  if (tray && !tray.isDestroyed()) tray.destroy()
  tray = null
}
