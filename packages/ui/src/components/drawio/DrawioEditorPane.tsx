/**
 * The diagram editor: drawio's own embed surface, bound to one `.drawio` file.
 *
 * What is here is the chrome — the toast over the drawing that says what is happening to the file,
 * and the two states that replace the drawing entirely (loading it, or failing to read it). What the
 * toast *says* comes from `useFileWriter`: when to write, whether the write will be allowed, and what
 * to do when the file changed underneath are answered once for every editor bound to a file, and
 * this is one of them.
 *
 * What is left that is drawio's own: the origin it is served from, the theme, and the frame.
 * The `drawio-preview` block's pencil and the full-size overlay both put this
 * somewhere; neither re-implements any of it.
 */

import { useTranslation } from 'react-i18next'
import { useFileWriter } from '../editors/useFileWriter'
import { FileSaveStatus } from '../editors/FileSaveStatus'
import { DrawioEditorFrame } from './frame'

export interface DrawioEditorPaneProps {
  /** Absolute path of the `.drawio` file being edited. */
  src: string
  /** The app's drawio origin, from `useDrawioOrigin`. */
  origin: string
  dark: boolean
  /** The frame's accessible name; there is no visible title here. */
  title: string
  /**
   * Every document that reached the disk, including the one this pane writes on its way out. A
   * caller that showed the diagram read-only needs the newest document, and the pane is the only
   * thing holding it — which is why this is a callback rather than something the caller asks for
   * afterwards.
   */
  onSaved?: (document: string) => void
}

export function DrawioEditorPane({ src, origin, dark, title, onSaved }: DrawioEditorPaneProps) {
  const { t } = useTranslation()
  const { document, problem, report, saveState, conflict, keepMine, reloadFromDisk, reloadToken } =
    useFileWriter(src, onSaved)

  if (problem) {
    return (
      <div className="flex-1 min-h-0 min-h-[400px] flex items-center justify-center px-6 text-center">
        <span className="text-destructive/70 text-[13px]">{problem}</span>
      </div>
    )
  }

  return (
    <div className="relative flex-1 min-h-0 flex flex-col">
      {document === null ? (
        <div className="flex-1 min-h-0 min-h-[400px] flex items-center justify-center text-muted-foreground text-[13px]">
          {t('common.loading')}
        </div>
      ) : (
        /* Keyed by the reload: the frame takes its document once, when it is mounted, and reading
           the file again is a new document rather than a new value. */
        <div key={reloadToken} className="flex-1 min-h-0 flex flex-col">
          <DrawioEditorFrame
            origin={origin}
            xml={document}
            dark={dark}
            title={title}
            onDocument={report}
          />
        </div>
      )}

      {/* The word in the corner, and the decision in the middle — see `FileSaveStatus`. It used to
          be a strip above the drawing (which pushed the drawing down) and then a chip in its
          corner (which the drawing's own chrome shares). */}
      <FileSaveStatus
        saveState={saveState}
        conflict={conflict !== null}
        onReloadFromDisk={reloadFromDisk}
        onKeepMine={keepMine}
      />
    </div>
  )
}
