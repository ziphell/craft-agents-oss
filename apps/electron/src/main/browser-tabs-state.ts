import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { readJsonFileSync } from '@craft-agent/shared/utils/files'
import { CONFIG_DIR } from '@craft-agent/shared/config/paths'
import { mainLog } from './logger'

/**
 * One page, as it is remembered between runs.
 *
 * Only the page is remembered — deliberately **not** the tab's id. A name (`tab-3`) is the window's
 * to hand out while it is open, and a window that comes back numbers its tabs afresh from `tab-1`,
 * so nothing on disk can make the numbering creep upwards run after run.
 */
export interface SavedBrowserTab {
  url: string
  title: string
}

/** One browser window, as it is remembered between runs. */
export interface SavedBrowserWindowTabs {
  workspaceId: string | null
  /**
   * The browser profile the window was signed into.
   *
   * The pair `(workspaceId, profileId)` is the window: a workspace holds one window per profile in
   * use. Optional because an entry written before profiles existed has none — that is the built-in
   * profile, which is where every window used to be.
   */
  profileId?: string
  tabs: SavedBrowserTab[]
  /** Which of `tabs` was on screen — an index, because the ids are handed out again on restore. */
  activeIndex: number
  /**
   * The content size the window had.
   *
   * Optional, because an entry written before this existed has none. The **position** is deliberately
   * not remembered: where the window opens is the person's (they move, snap and maximise it), so a
   * window whose size comes back still opens where the OS puts it.
   */
  contentSize?: { width: number; height: number }
}

export interface BrowserTabsState {
  windows: SavedBrowserWindowTabs[]
}

/** Where the remembered pages live. The app's own file, beside the window state. */
const BROWSER_TABS_STATE_FILE = join(CONFIG_DIR, 'browser-tabs.json')

export function loadBrowserTabsState(): BrowserTabsState {
  try {
    if (!existsSync(BROWSER_TABS_STATE_FILE)) return { windows: [] }
    const raw = readJsonFileSync<BrowserTabsState>(BROWSER_TABS_STATE_FILE)
    if (!raw || !Array.isArray(raw.windows)) return { windows: [] }
    return raw
  } catch (error) {
    mainLog.warn('[browser-tabs-state] failed to load:', error)
    return { windows: [] }
  }
}

export function saveBrowserTabsState(state: BrowserTabsState): void {
  try {
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true })
    }
    writeFileSync(BROWSER_TABS_STATE_FILE, JSON.stringify(state, null, 2), 'utf-8')
  } catch (error) {
    mainLog.error('[browser-tabs-state] failed to save:', error)
  }
}
