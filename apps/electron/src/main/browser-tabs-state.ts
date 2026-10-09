import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { readJsonFileSync } from '@craft-agent/shared/utils/files'
import { CONFIG_DIR } from '@craft-agent/shared/config/paths'
import { mainLog } from './logger'

/** One page, as it is remembered between runs. */
export interface SavedBrowserTab {
  /** The tab's id — reused on restore so a name a message quoted still finds it. */
  id: string
  url: string
  title: string
}

/** One workspace's browser window, as it is remembered between runs. */
export interface SavedBrowserWindowTabs {
  workspaceId: string | null
  tabs: SavedBrowserTab[]
  activeTabId: string
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
