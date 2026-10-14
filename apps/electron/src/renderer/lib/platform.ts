/**
 * Platform Detection Utilities
 *
 * Centralized platform detection for the renderer process.
 * Use these instead of accessing navigator.platform directly.
 *
 * @example
 * import { isMac, isWindows, PATH_SEP, getPathBasename } from '@/lib/platform'
 *
 * // Platform checks
 * const modifier = isMac ? '⌘' : 'Ctrl'
 *
 * // Path handling
 * const folderName = getPathBasename('/Users/alice/projects') // 'projects'
 */

/** True if running on macOS */
export const isMac =
  typeof navigator !== 'undefined' &&
  navigator.platform.toLowerCase().includes('mac')

/** True if running on Windows */
export const isWindows =
  typeof navigator !== 'undefined' &&
  navigator.platform.toLowerCase().includes('win')

/** True if running on Linux */
export const isLinux =
  typeof navigator !== 'undefined' &&
  navigator.platform.toLowerCase().includes('linux')

/**
 * True when this bundle is running inside the browser-served Web UI
 * (apps/webui), as opposed to the Electron renderer.
 *
 * The webui's Vite config injects `import.meta.env.IS_WEBUI = 'true'` via
 * `define` so we can branch on context (e.g. skip macOS stoplight padding,
 * which is irrelevant inside a regular browser tab).
 */
export const isWebUI: boolean = Boolean(
  (import.meta as { env?: { IS_WEBUI?: unknown } }).env?.IS_WEBUI,
)

/**
 * Get the platform-specific file manager name.
 * macOS → "Finder", Windows → "Explorer", Linux → "File Manager"
 */
export function getFileManagerName(): string {
  if (isMac) return 'Finder'
  if (isWindows) return 'Explorer'
  return 'File Manager'
}

/**
 * Width (CSS px) the app's own caption buttons occupy at the top-right, where the app
 * draws its title bar (`titleBarStyle: 'hidden'`). This was the room Windows'
 * `titleBarOverlay` needed when the OS painted minimize/maximize/close there; the app draws
 * them itself now (`WindowControls`), so it is the room those buttons occupy — everything
 * that stepped around the OS buttons (the TopBar row, full-screen pages' close buttons,
 * the preview header) still steps around these. Zero everywhere else: macOS puts its
 * controls on the left (handled by the stoplight padding), and the Web UI has no caption
 * buttons at all.
 */
export const titleBarCaptionInset = isWindows && !isWebUI ? 138 : 0

/** Native path separator for current OS */
export const PATH_SEP = isWindows ? '\\' : '/'

/**
 * Get the last segment of a path (folder/file name).
 * Handles both Unix (/) and Windows (\) separators based on current OS.
 */
export function getPathBasename(path: string): string {
  return path.split(PATH_SEP).pop() || ''
}
