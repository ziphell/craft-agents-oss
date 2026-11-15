import { release } from 'os'
import { windowLog } from './logger'

/**
 * The OS material a window can be backed with, or `undefined` where the platform has none.
 *
 * One answer for every window that wants a translucent shell — the workspace's and the
 * browser's alike — so the two are the same grey rather than two greys an update apart. The
 * callers then do the same three things with it: set `backgroundMaterial`, drop the opaque
 * `backgroundColor` (it would cover the material), and draw their chrome as the half-tint
 * (`html[data-theme-override]::before` in the app, `browser-chrome-surface` in the browser
 * window) that lets it through.
 *
 * - Windows 11 (build 22000+): Mica
 * - Windows 10 1809+ (build 17763+): Acrylic
 * - anything older, and Linux: nothing
 */
export function getWindowsBackgroundMaterial(): 'mica' | 'acrylic' | undefined {
  if (process.platform !== 'win32') return undefined

  // os.release() returns "10.0.xxxxx" where xxxxx is the build number
  const buildNumber = parseInt(release().split('.')[2] || '0', 10)

  if (buildNumber >= 22000) {
    windowLog.info('Windows 11 detected (build ' + buildNumber + '), using Mica')
    return 'mica'
  } else if (buildNumber >= 17763) {
    windowLog.info('Windows 10 1809+ detected (build ' + buildNumber + '), using Acrylic')
    return 'acrylic'
  }

  windowLog.info('Older Windows detected (build ' + buildNumber + '), no transparency')
  return undefined
}
