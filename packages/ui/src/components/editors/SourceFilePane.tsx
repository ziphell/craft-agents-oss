/**
 * A file, edited as its own text — the whole surface, with nothing drawn for it.
 *
 * **Nothing here knows what format the file is.** It reads the bytes, shows them, writes them back, and reports
 * whether that is going well; the language is a string the caller passes because the caller is the one that knows
 * the path. Today that is HTML's source face — `HtmlDesignEditor` edits what a person *sees* and patches one span of
 * the source, which is right for moving a heading and impossible for a `<style>` block, an attribute, a script tag,
 * a comment that is out of date — but the same file, written by the same chain (`useSourceDraft`), is all this
 * component ever needed. Markdown has its own pane (`MarkdownEditorPane`) because it has three faces to arrange;
 * this one is the one-face case.
 *
 * Deliberately not a reading face: whoever asks for the source wants the text. A caller that has a rendering of its
 * own puts that beside this one and switches between them.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { usePlatform } from '../../context/PlatformContext'
import { useSourceDraft } from './useSourceDraft'
import { FileSaveStatus } from './FileSaveStatus'
import { SourceText } from './SourceText'

export interface SourceFilePaneProps {
  /** Absolute path of the file. */
  src: string
  /**
   * What to colour it as: a shiki language id, or a file name whose extension says it (`notes.md` works).
   *
   * Required, and not defaulted: which language a file is written in is something the caller knows from the path,
   * and a component that guessed would be wrong silently. What shiki does not know is shown as plain text.
   */
  language: string
  /** The column's padding and width, from the caller — the same box the reading face gets. */
  className?: string
  placeholder?: string
  /** Every document that reached the disk, including the one written on the way out. */
  onSaved?: (document: string) => void
}

export function SourceFilePane({
  src,
  language,
  className,
  placeholder,
  onSaved,
}: SourceFilePaneProps) {
  const { t } = useTranslation()
  const { onWriteFile } = usePlatform()
  const { draft, change, problem, saveState, conflict, keepMine, reloadFromDisk, reloadToken } =
    useSourceDraft(src, onSaved)

  return (
    <div className="relative flex-1 min-h-0 flex flex-col">
      {problem ? (
        <div className="flex-1 min-h-[400px] flex items-center justify-center px-6 text-center">
          <span className="text-destructive/70 text-[13px]">{problem}</span>
        </div>
      ) : draft === null ? (
        <div className="flex-1 min-h-[400px] flex items-center justify-center text-muted-foreground text-[13px]">
          {t('common.loading')}
        </div>
      ) : (
        /* Keyed by the reload: reading the file again is a new document, and the editor should come
           up at the top of the new text. The box is absolutely positioned for the same reason it is
           in `MarkdownEditorPane` — an editor in this chain is sized by the pane's *used* height,
           not by its own content. */
        <div key={reloadToken} className="relative flex-1 min-h-0 flex flex-col">
          <div className="absolute inset-0 flex flex-col">
            <SourceText
              value={draft}
              language={language}
              onChange={change}
              readOnly={!onWriteFile}
              autoFocus
              className={className}
              placeholder={placeholder}
            />
          </div>
        </div>
      )}

      {/* What is happening to the file, in the corner — including the question a second writer
          raises, which is answered the same way here as in the page editor. */}
      <FileSaveStatus
        saveState={saveState}
        conflict={conflict !== null}
        onReloadFromDisk={reloadFromDisk}
        onKeepMine={keepMine}
      />
    </div>
  )
}
