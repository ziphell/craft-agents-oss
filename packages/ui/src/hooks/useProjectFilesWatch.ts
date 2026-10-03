/**
 * Tells a component when the workspace's project files tree changed on disk.
 *
 * The event carries a workspace id and whichever file `fs.watch` happened to name, and both
 * are dropped here on purpose. The name is relative, is sometimes spelled with the platform's
 * separator and is null when the watcher does not know — so matching a path against it would
 * be a guess. And it does not have to be a guess: the caller answers the event by *reading the
 * file*, which is the authority the whole workbench is built on. This says "something
 * changed"; the disk says what.
 *
 * The watcher itself is app-wide and owned elsewhere (`AppShell`), so subscribing is all
 * this does. On a host without one the hook does nothing and a component reads once and stays.
 *
 * The probe is on the project tree rather than on one file, so it is only a signal for
 * files that live there — the diagram editor and the HTML editor both need it, which is why
 * it sits here rather than beside either of them. A spec is a file in the project folder now,
 * which is why the probe moved with it.
 */

import * as React from 'react'
import { usePlatform } from '../context/PlatformContext'

/**
 * Run `onChange` whenever the project files tree changes on disk.
 *
 * `onChange` may be called more often than it finds anything new — a write anyone made
 * anywhere in the tree reaches every listener — so it should compare before it acts, not
 * assume the change was its own file.
 */
export function useProjectFilesWatch(onChange: () => void): void {
  const { onProjectFilesChanged } = usePlatform()

  const changeRef = React.useRef(onChange)
  changeRef.current = onChange

  React.useEffect(() => {
    if (!onProjectFilesChanged) return
    return onProjectFilesChanged(() => changeRef.current())
  }, [onProjectFilesChanged])
}
