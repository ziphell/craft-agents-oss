/**
 * What is happening to the file, and where each part of it is said.
 *
 * **The save is a word in the window's header**, immediately left of the actions. Chrome is the
 * only place it can go: the surface being edited is *content* — a source's first lines, a page's
 * top-right corner, the drawing's own toolbar — so anything floating there covers something. It is
 * reported up from wherever the writing happens (`useReportFileSaveState`) and drawn once, by
 * `FileSaveStateWord`, which is the only thing that decides how a save reads: writing, written for
 * three seconds, or failed.
 *
 * **A file that changed underneath is a decision**, and a decision is not quiet and not in a corner:
 * it is a toast over the middle of the surface, where the eye already is, and it takes clicks — the
 * two buttons are the whole reason it exists. Nothing but a decision may take a click out of the
 * content.
 *
 * Two shapes are worth not repeating: a **row above the document** (it pushed the text down every
 * time a save started, which is exactly when somebody has just begun typing) and a **word in the
 * surface's corner** (measured against the three surfaces: it sat on the source, on the page, and on
 * drawio's toolbar).
 */

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'
import type { SaveState } from './useFileWriter'

/** How long "Saved" stays up. It is the one thing here that has already happened. */
const SAVED_VISIBLE_MS = 3000

/**
 * Where a surface says what is happening to the file, and where the chrome reads it.
 *
 * One provider per window, rendered by whatever owns both the header and the content — which is
 * `PreviewOverlay`, the only component in a position to put one in the other.
 */
interface FileSaveSlot {
  saveState: SaveState | null
  setSaveState: (state: SaveState | null) => void
}

const FileSaveSlotContext = createContext<FileSaveSlot | null>(null)

export function FileSaveSlotProvider({ children }: { children: ReactNode }) {
  const [saveState, setSaveState] = useState<SaveState | null>(null)
  const value = useMemo(() => ({ saveState, setSaveState }), [saveState])
  return <FileSaveSlotContext.Provider value={value}>{children}</FileSaveSlotContext.Provider>
}

/**
 * Report the writer's state to the window, when there is a window to report to.
 *
 * A reader with no provider above it — a `.md` block inside a conversation — simply has nowhere to
 * put this, and says nothing: the word belongs to the chrome that shows the file's name.
 */
function useReportFileSaveState(saveState: SaveState) {
  const slot = useContext(FileSaveSlotContext)
  useEffect(() => {
    slot?.setSaveState(saveState)
  }, [slot, saveState])
  // A pane that goes away (another file, or the window closing) leaves nothing behind.
  useEffect(() => () => slot?.setSaveState(null), [slot])
}

/**
 * The save as a word, in the header's actions — rendered once, by the window chrome.
 *
 * Nothing is drawn when there is nothing to say, and nothing is drawn where no writer is reporting.
 */
export function FileSaveStateWord() {
  const { t } = useTranslation()
  const slot = useContext(FileSaveSlotContext)
  const saveState = slot?.saveState ?? null

  /**
   * Whether "Saved" is still up.
   *
   * Keyed on the state *becoming* `saved`: the word retires itself after three seconds, and a
   * re-render for any other reason must not restart that count — only the next save may. A save
   * that has already been announced therefore stays announced exactly once.
   */
  const [savedVisible, setSavedVisible] = useState(false)
  useEffect(() => {
    if (saveState !== 'saved') {
      setSavedVisible(false)
      return
    }
    setSavedVisible(true)
    const timer = setTimeout(() => setSavedVisible(false), SAVED_VISIBLE_MS)
    return () => clearTimeout(timer)
  }, [saveState])

  const word =
    saveState === 'pending'
      ? t('common.saving')
      : saveState === 'saved' && savedVisible
        ? t('preview.saved')
        : saveState === 'failed'
          ? t('common.error')
          : null

  if (word === null) return null

  return (
    <span
      className={cn(
        'select-none whitespace-nowrap text-[12px] pointer-events-none',
        'text-muted-foreground',
        saveState === 'failed' && 'text-destructive/80',
      )}
    >
      {word}
    </span>
  )
}

export interface FileSaveStatusProps {
  /** Where the writer is: writing, written, or failed. The word itself is the header's. */
  saveState: SaveState
  /** Whether the file changed on disk under edits of our own — the one thing here that is a decision. */
  conflict: boolean
  onReloadFromDisk: () => void
  onKeepMine: () => void
}

/** The decision, over the middle of the surface being edited. */
export function FileSaveStatus({
  saveState,
  conflict,
  onReloadFromDisk,
  onKeepMine,
}: FileSaveStatusProps) {
  const { t } = useTranslation()
  useReportFileSaveState(saveState)

  if (!conflict) return null

  return (
    <div
      className={cn(
        'absolute top-2 left-1/2 -translate-x-1/2 z-10 max-w-[70%] flex items-center gap-2 px-2 py-0.5',
        'rounded-[6px] text-[12px] whitespace-nowrap',
        'bg-background/85 backdrop-blur-sm shadow-minimal text-muted-foreground',
      )}
      role="status"
      aria-live="polite"
    >
      <span className="truncate">{t('preview.fileChangedOnDisk')}</span>
      <button
        type="button"
        onClick={onReloadFromDisk}
        className="px-2 py-0.5 rounded-[6px] text-[12px] bg-background shadow-minimal text-muted-foreground hover:text-foreground shrink-0"
      >
        {t('preview.reloadFromDisk')}
      </button>
      <button
        type="button"
        onClick={onKeepMine}
        className="px-2 py-0.5 rounded-[6px] text-[12px] bg-background shadow-minimal hover:bg-background/80 shrink-0"
      >
        {t('preview.keepMyChanges')}
      </button>
    </div>
  )
}
