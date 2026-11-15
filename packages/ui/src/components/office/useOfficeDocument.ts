/**
 * The file-editing chain for a **document**, which is bytes rather than text.
 *
 * `editors/useFileWriter` answers the same three questions for text — when to write, whether the
 * write will be allowed, and what to do when the file changed underneath — and this is its sibling,
 * not a second design. The chrome is literally the same: `FileSaveStatus` draws the decision and
 * `FileSaveStateWord` draws the save, wherever the writer reports them.
 *
 * Two things differ, and neither is a shortcut:
 *
 * - **A save is an event, not a stream.** A text editor reports every keystroke and the write is
 *   debounced; a document editor holds its own model and calls `save` when the person presses
 *   ⌘S, handing over the bytes it built. So there is nothing to debounce, and nothing is written
 *   that was not asked for.
 * - **"Has the person edited?" is not knowable.** A text editor can compare what it holds with
 *   what it was given. An office editor's buffer is its own — a shifted paragraph, a moved slide —
 *   and asking it to diff itself against the file would be a guess dressed as an answer. So a
 *   change on disk always **asks**, where the text chain sometimes follows silently. That is
 *   `useFileWriter`'s second branch collapsed into its first: the safe one.
 *
 * The comparison is a SHA-256 of the bytes rather than a string, because the bytes are a zip.
 * `office-guard.ts` in main makes the same comparison as a backstop — a renderer that asked for
 * `overwrite` by mistake still meets the host's own rule.
 */

import * as React from 'react'
import { usePlatform } from '../../context/PlatformContext'
import { useProjectFilesWatch } from '../../hooks/useProjectFilesWatch'
import { sameFilePath } from '../../lib/file-paths'
import { digest } from './digest'
import type { SaveState } from '../editors/useFileWriter'

export interface OfficeDocument {
  /** The document as last read or written — what the frame should be showing. */
  bytes: Uint8Array | null
  /** What went wrong reading or writing, in the host's own words. */
  problem: string | null
  saveState: SaveState
  /** The file on disk is no longer what this document was built from. */
  conflict: boolean
  /** Write this document over the version on disk — the person's answer to the question. */
  keepMine: () => Promise<void>
  /** Take the version on disk and drop this document's copy. */
  reloadFromDisk: () => void
  /** Bumped whenever the document was read again; meant as a React `key`, so the frame remounts. */
  reloadToken: number
  /** The frame asking to save, with the bytes it built. */
  save: (bytes: Uint8Array) => Promise<void>
  /** The frame asking for the document (on open, and after a reload remounts it). */
  read: (path: string) => Promise<Uint8Array>
}

/** SHA-256 in hex, over the bytes as given. */
export function useOfficeDocument(src: string, active = true): OfficeDocument {
  const { onReadFileBinary, onWriteFileBinary, onDocumentOpenChange, onOfficeFileWritten } = usePlatform()

  const [bytes, setBytes] = React.useState<Uint8Array | null>(null)
  const [problem, setProblem] = React.useState<string | null>(null)
  const [saveState, setSaveState] = React.useState<SaveState>('idle')
  const [conflict, setConflict] = React.useState(false)
  const [reloadToken, setReloadToken] = React.useState(0)

  /** The version on disk this document has seen, as a digest. */
  const seenRef = React.useRef<string | null>(null)
  /** The newest bytes this document holds, written or not. */
  const latestRef = React.useRef<Uint8Array | null>(null)
  const conflictRef = React.useRef(false)
  const savingRef = React.useRef(false)
  /** Read from refs so the unmount path and the watcher both reach the current host methods. */
  const readRef = React.useRef(onReadFileBinary)
  const writeRef = React.useRef(onWriteFileBinary)
  readRef.current = onReadFileBinary
  writeRef.current = onWriteFileBinary

  /**
   * Take a document as the one this hook holds.
   *
   * `remount` is false for the first read: the frame is not built yet, so bumping the token there
   * would build it twice — once when the bytes landed and again when the token moved. A reload is
   * the opposite case, and the token is the only way to make an editor discard its own model.
   */
  // Same registry as the text chain: an office editor is the other way a file is "in use", and the
  // agent's document tool refuses to write under either. `active` is part of the key because an
  // off-screen block is not showing anything and must not look like an editor.
  React.useEffect(() => {
    if (!active || !onDocumentOpenChange || !src) return
    onDocumentOpenChange(src, true)
    return () => onDocumentOpenChange(src, false)
  }, [src, active, onDocumentOpenChange])

  const adopt = React.useCallback((next: Uint8Array, seen: string, remount = true) => {
    seenRef.current = seen
    latestRef.current = next
    setBytes(next)
    if (remount) setReloadToken((token) => token + 1)
  }, [])

  // First read: the document arrives once, and `read` hands this very copy to the frame.
  React.useEffect(() => {
    if (!active) return
    const read = onReadFileBinary
    if (!read) {
      setProblem('This host cannot read files, so there is nothing to open.')
      return
    }
    let cancelled = false
    seenRef.current = null
    latestRef.current = null
    conflictRef.current = false
    setBytes(null)
    setProblem(null)
    setConflict(false)
    setSaveState('idle')
    read(src)
      .then(async (next) => {
        if (cancelled) return
        adopt(next, await digest(next), false)
      })
      .catch((error: unknown) => {
        if (!cancelled) setProblem(error instanceof Error ? error.message : String(error))
      })
    return () => {
      cancelled = true
    }
  }, [src, active, onReadFileBinary, adopt])

  /**
   * The frame's `readBytes`: always the copy this hook decided the editor should have.
   *
   * Answering from disk here would reopen whatever is on disk *now* — a second writer's version —
   * while `seenRef` still claims the old one, which is precisely the disagreement this hook exists
   * to make explicit. A reload goes through `adopt` first, and only then asks the frame to remount.
   */
  const read = React.useCallback(async (path: string): Promise<Uint8Array> => {
    if (latestRef.current) return latestRef.current
    const host = readRef.current
    if (!host) throw new Error('This host cannot read files.')
    const next = await host(path)
    adopt(next, await digest(next), false)
    return next
  }, [adopt])

  /**
   * A change on disk, noticed while the document is open.
   *
   * The event only says *look*; the read says what changed — the same division `useFileWriter`
   * relies on. What differs is the answer: an office buffer cannot be compared with the file, so
   * there is no "nothing is at stake, follow it" branch. It asks.
   */
  const checkForExternalChange = React.useCallback(async () => {
    const host = readRef.current
    if (!host || conflictRef.current || seenRef.current === null) return
    let onDisk: Uint8Array
    try {
      onDisk = await host(src)
    } catch {
      // Gone or unreadable: the next save reports that, with the save that failed.
      return
    }
    if ((await digest(onDisk)) === seenRef.current) return
    conflictRef.current = true
    setConflict(true)
  }, [src])

  useProjectFilesWatch(() => void checkForExternalChange())

  /**
   * A save the host made itself (an agent's write, a conversion). This is the case the project
   * watcher cannot see: a document outside the project tree. The event names the file, so only the
   * editor holding that file asks the disk anything.
   */
  const onFileWritten = onOfficeFileWritten
  React.useEffect(() => {
    if (!active || !onFileWritten || !src) return
    return onFileWritten((written) => {
      if (sameFilePath(written, src)) void checkForExternalChange()
    })
  }, [active, onFileWritten, src, checkForExternalChange])

  /**
   * A file outside the project tree is invisible to that watcher. Returning to the window is when a
   * person would look at the document again, so it is also the honest moment to ask whether the copy
   * on disk still matches the one on screen — one read, not a poll.
   */
  React.useEffect(() => {
    if (!active) return
    const check = () => void checkForExternalChange()
    window.addEventListener('focus', check)
    document.addEventListener('visibilitychange', check)
    return () => {
      window.removeEventListener('focus', check)
      document.removeEventListener('visibilitychange', check)
    }
  }, [active, checkForExternalChange])

  const save = React.useCallback(
    async (next: Uint8Array) => {
      const host = readRef.current
      const write = writeRef.current
      if (!host || !write || savingRef.current) return
      latestRef.current = next
      if (conflictRef.current) return

      savingRef.current = true
      setSaveState('pending')
      try {
        // Read before writing: the file is the authority, and this is the only moment a competing
        // write can be seen. Our own newest bytes coming back is not a disagreement.
        const onDisk = await digest(await host(src))
        const ours = await digest(next)
        if (seenRef.current !== null && onDisk !== seenRef.current && onDisk !== ours) {
          conflictRef.current = true
          setConflict(true)
          setSaveState('idle')
          // Thrown, not resolved: the save did not happen, and an editor told otherwise clears its
          // dirty flag and lets the person close the window believing the work is on disk.
          throw new Error('The file changed on disk since it was opened — reload it, or save over it.')
        }
        await write(src, next)
        seenRef.current = ours
        setSaveState('saved')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        setProblem(message)
        setSaveState('failed')
        // The host refuses a save over somebody else's write (office-guard.ts). That refusal is the
        // same decision, said from the other side, so it becomes the same question here. It is still
        // thrown onward: the frame has to keep its dirty flag.
        if (/changed on disk/i.test(message)) {
          conflictRef.current = true
          setConflict(true)
          setSaveState('idle')
        }
        throw error
      } finally {
        savingRef.current = false
      }
    },
    [src],
  )

  const keepMine = React.useCallback(async () => {
    const write = writeRef.current
    const wanted = latestRef.current
    if (!write || !wanted) return
    conflictRef.current = false
    setConflict(false)
    setSaveState('pending')
    try {
      // `overwrite` is the person's answer, carried to the host's own guard rather than worked
      // around it: the file is still checked, and this is what says "yes, over it".
      await write(src, wanted, true)
      seenRef.current = await digest(wanted)
      setSaveState('saved')
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
      setSaveState('failed')
    }
  }, [src])

  const reloadFromDisk = React.useCallback(() => {
    const host = readRef.current
    if (!host) return
    conflictRef.current = false
    setConflict(false)
    setProblem(null)
    setSaveState('idle')
    void host(src)
      .then(async (onDisk) => adopt(onDisk, await digest(onDisk)))
      .catch((error: unknown) => setProblem(error instanceof Error ? error.message : String(error)))
  }, [src, adopt])

  return {
    bytes,
    problem,
    saveState,
    conflict,
    keepMine,
    reloadFromDisk,
    reloadToken,
    save,
    read,
  }
}
