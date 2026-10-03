/**
 * The file-editing chain: one file on disk, and the three answers every editor bound to one would
 * otherwise give for itself.
 *
 * **This is a hook, not a component, and it has no chrome.** The three editors that use it look
 * nothing like each other — a page owns a strip with a formatting toolbar in it, a diagram pane
 * keeps a quiet line, a document in a conversation wants no line at all — so the row, the
 * placeholder, the toolbar and every size belong to whoever draws them. What does *not* belong to
 * them is the answer to these three questions, because answers drift:
 *
 * - **When to write.** A change arrives per keystroke, so the write is debounced, and the write
 *   still pending when the editor closes is made on the way out.
 * - **Whether the write will be allowed.** `onWriteFile` is called and its refusal comes back as
 *   the refusal. Nothing here pre-checks a boundary the host owns, so there is one policy and not
 *   a second guess at it.
 * - **What to do when the file changed underneath.** The editor is not the only writer — an agent
 *   can `Edit` the same file mid-conversation — so a save re-reads first and refuses to overwrite
 *   a version it has not seen; and a change noticed while the editor is open is either *followed*
 *   (nothing has been edited here yet) or put to the person.
 */

import * as React from 'react'
import { usePlatform } from '../../context/PlatformContext'
import { useProjectFilesWatch } from '../../hooks/useProjectFilesWatch'

/** Long enough to survive typing, short enough that nobody closes the app on a pending write. */
const SAVE_DEBOUNCE_MS = 1200

export type SaveState = 'idle' | 'pending' | 'saved' | 'failed'

export interface FileWriter {
  /** The file as last read — what a surface should show. Null until the first read lands. */
  document: string | null
  /** What went wrong reading or writing, in the host's own words. */
  problem: string | null
  /** The document the surface now holds. Debounced into a write. */
  report: (next: string) => void
  saveState: SaveState
  /** The version on disk this editor has not seen. Non-null means the two really disagree. */
  conflict: string | null
  /** Write what this editor holds over the version on disk. */
  keepMine: () => void
  /** Take the version on disk and drop what this editor holds. */
  reloadFromDisk: () => void
  /**
   * Write what is owed, now, instead of waiting out the debounce. Nothing is written when nothing
   * is owed, which is what makes this safe to call for a keystroke.
   */
  flush: () => void
  /**
   * Bumped whenever the file was read again, so a surface that took a copy of what it was given
   * can load it from scratch. The value is meant to be a React `key`.
   */
  reloadToken: number
}

/**
 * Every document that reached the disk — including the one written on the way out — is handed to
 * `onSaved`. A caller showing the same file read-only needs the newest version, and this hook is
 * the only thing holding it, which is why it is a callback rather than something asked for later.
 */
export function useFileWriter(
  src: string,
  onSaved?: (document: string) => void,
): FileWriter {
  const { onReadFile, onWriteFile } = usePlatform()

  const [document, setDocument] = React.useState<string | null>(null)
  const [problem, setProblem] = React.useState<string | null>(null)
  const [saveState, setSaveState] = React.useState<SaveState>('idle')
  const [conflict, setConflict] = React.useState<string | null>(null)
  const [reloadToken, setReloadToken] = React.useState(0)

  /** The version on disk this editor has seen. */
  const seenRef = React.useRef<string | null>(null)
  /** The document this editor was handed — the baseline for "has anyone changed anything yet". */
  const loadedRef = React.useRef<string | null>(null)
  /** The newest document the surface has reported, written or not. */
  const latestRef = React.useRef<string | null>(null)
  /**
   * How many times what is on screen has *differed* from what was loaded.
   *
   * A content question rather than an event count, deliberately: a surface may re-announce the
   * document it was given (drawio does), and counting that as an edit would make every later write
   * from outside a conflict instead of the editor simply following the file.
   */
  const generationRef = React.useRef(0)
  const savingRef = React.useRef(false)
  const conflictRef = React.useRef<string | null>(null)
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  // Held in refs so a write can still be made from the unmount path, where the props of a gone
  // component are no longer reachable — but its refs are.
  const readRef = React.useRef(onReadFile)
  const writeRef = React.useRef(onWriteFile)
  const savedRef = React.useRef(onSaved)
  readRef.current = onReadFile
  writeRef.current = onWriteFile
  savedRef.current = onSaved

  React.useEffect(() => {
    if (!onReadFile) {
      setProblem('This host cannot read files, so there is nothing to edit.')
      return
    }

    let cancelled = false
    seenRef.current = null
    loadedRef.current = null
    latestRef.current = null
    generationRef.current = 0
    conflictRef.current = null
    setDocument(null)
    setProblem(null)
    setConflict(null)
    setSaveState('idle')

    onReadFile(src)
      .then((read) => {
        if (cancelled) return
        seenRef.current = read
        loadedRef.current = read
        latestRef.current = read
        setDocument(read)
      })
      .catch((error: unknown) => {
        if (!cancelled) setProblem(error instanceof Error ? error.message : String(error))
      })

    return () => {
      cancelled = true
    }
  }, [src, onReadFile])

  /**
   * Write until the surface stops reporting changes.
   *
   * The loop is what makes a save racing a change correct: if a newer document arrived while this
   * one was being written, comparing generations says so and the newer one is written too. It ends
   * as soon as the two agree, which is as soon as the person pauses.
   *
   * Only `src` is a dependency — the callbacks are read from refs — so this identity is stable and
   * the unmount flush below can hold on to it.
   */
  const save = React.useCallback(async () => {
    const read = readRef.current
    const write = writeRef.current
    if (savingRef.current || conflictRef.current !== null) return
    if (!read || !write) return

    savingRef.current = true
    try {
      while (true) {
        const generation = generationRef.current
        const wanted = latestRef.current
        if (wanted === null) break

        setSaveState('pending')

        // Read before every write. The file is the source of truth and this is the only moment a
        // competing write can be seen. The last clause is about our own write coming back to us
        // through the watcher: a disk that already holds what we are about to write is not a
        // disagreement.
        const onDisk = await read(src)
        if (seenRef.current !== null && onDisk !== seenRef.current && onDisk !== latestRef.current) {
          conflictRef.current = onDisk
          setConflict(onDisk)
          setSaveState('idle')
          break
        }

        /**
         * The disk already holds this text, so there is **nothing to write** — and a write would be
         * a real event on disk, with a watcher behind it, for no change at all. One question, one
         * place: typing a change and typing it back, ⌘S with nothing owed, and saving what was just
         * saved all end up here rather than in a second copy of this test.
         *
         * Two ways out, because "this text" is a snapshot: if the surface reported something *newer*
         * while this read was happening, that newer document is the one that is owed, so the loop
         * takes it instead of writing a snapshot the disk already has. Only when what we hold is
         * what the disk holds is the file saved, and that is what gets said — the answer the save
         * key shows when nothing was owed.
         */
        if (onDisk === wanted) {
          seenRef.current = onDisk
          if (latestRef.current !== onDisk) continue
          setSaveState('saved')
          break
        }

        await write(src, wanted)
        seenRef.current = wanted
        setSaveState('saved')
        savedRef.current?.(wanted)

        if (generationRef.current === generation) break
      }
    } catch (error) {
      setSaveState('failed')
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      savingRef.current = false
    }
  }, [src])

  const saveRef = React.useRef(save)
  saveRef.current = save

  /**
   * Follow the file while this editor is open.
   *
   * Without this, a write from outside — an agent's `Edit`, most often — is only discovered at the
   * next save, which means the person finds out by being asked a question about something they
   * never saw happen. The event only says *look*; the read below says what changed.
   *
   * What happens next depends on whether anything is at stake: with nothing changed here yet the
   * editor simply follows the file, and once something has changed the two versions really do
   * disagree, so a person decides. Adopting silently would be the wrong call in the second case and
   * asking would be noise in the first.
   */
  const checkForExternalChange = React.useCallback(async () => {
    const read = readRef.current
    if (!read || conflictRef.current !== null) return

    let onDisk: string
    try {
      onDisk = await read(src)
    } catch {
      // Gone or unreadable. A write is where that gets reported, with the write that failed; there
      // is nothing useful to do to an open editor meanwhile.
      return
    }
    if (seenRef.current === null || onDisk === seenRef.current || onDisk === latestRef.current) {
      return
    }

    if (generationRef.current === 0) {
      seenRef.current = onDisk
      loadedRef.current = onDisk
      latestRef.current = onDisk
      setDocument(onDisk)
      setReloadToken((token) => token + 1)
      return
    }

    conflictRef.current = onDisk
    setConflict(onDisk)
    setSaveState('idle')
  }, [src])

  useProjectFilesWatch(() => void checkForExternalChange())

  const report = React.useCallback((next: string) => {
    latestRef.current = next
    // What a surface hands back identical to what it was given is it re-announcing the document,
    // not somebody editing. See the note on `generationRef`.
    if (next !== loadedRef.current) generationRef.current += 1
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    // A pause still gets one look at the disk even when this text is already on it — what to *do*
    // about that is `save`'s question, asked once, after the read. Asking it here as well was the
    // complicated version: it had to be kept in step with `save`'s copy, and it cost the property
    // that a pause re-checks the disk at all.
    timerRef.current = setTimeout(() => void saveRef.current(), SAVE_DEBOUNCE_MS)
  }, [])

  const keepMine = React.useCallback(async () => {
    const wanted = latestRef.current
    const write = writeRef.current
    if (!wanted || !write) return
    conflictRef.current = null
    setConflict(null)
    setSaveState('pending')
    try {
      await write(src, wanted)
      seenRef.current = wanted
      setSaveState('saved')
      savedRef.current?.(wanted)
    } catch (error) {
      setSaveState('failed')
      setProblem(error instanceof Error ? error.message : String(error))
    }
  }, [src])

  const reloadFromDisk = React.useCallback(() => {
    const onDisk = conflictRef.current
    if (onDisk === null) return
    conflictRef.current = null
    setConflict(null)
    setProblem(null)
    setSaveState('idle')
    seenRef.current = onDisk
    latestRef.current = onDisk
    setDocument(onDisk)
    setReloadToken((token) => token + 1)
  }, [])

  React.useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      // Leaving is not a way to lose the last edit: whatever is still pending is written on the
      // way out, and `onSaved` reports it to a caller that is still mounted.
      void saveRef.current()
    },
    [],
  )

  /**
   * Ask to write what is owed, now, instead of waiting out the debounce.
   *
   * Whether anything is owed is **not** decided here: `save` asks it of the disk, which is the only
   * place that can answer it — the same question `report` asks before it arms a write, from the
   * other end. That is also what makes this the retry after a failed write (which is still owed) and
   * what makes it safe to call for a keystroke: a save with nothing behind it writes nothing, and
   * says "saved" because the file is. What this does is call off the pending write, so the same text
   * cannot be written twice.
   *
   * Two callers, one decision: the ⌘S / Ctrl+S binding below, and the page editor's probe, which is
   * inside an iframe and therefore has to forward the keystroke to reach this at all.
   */
  const flush = React.useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    void saveRef.current()
  }, [])

  /**
   * ⌘S / Ctrl+S: write what is owed, and write it now.
   *
   * The key means "this file is saved", and it already is — a pause writes it — so what the key does
   * is skip the pause (`flush`). Two things about the binding itself, both deliberate:
   *
   * - **It is swallowed either way**, even with nothing to write: while a file is open in a window,
   *   this key has no other meaning here.
   * - **It is bound on the window, not on a box.** The key belongs to the window the file is open
   *   in — and a box would be *worse* than useless here, because a key pressed inside an iframe
   *   never reaches this document at all (the frame is a document of its own; its keys do not
   *   bubble). That is why the page editor's probe forwards its own Ctrl/Cmd+S by postMessage
   *   instead of relying on this listener.
   */
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's') return
      event.preventDefault()
      flush()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [flush])

  return {
    document,
    problem,
    report,
    saveState,
    conflict,
    keepMine: () => void keepMine(),
    reloadFromDisk,
    flush,
    reloadToken,
  }
}
