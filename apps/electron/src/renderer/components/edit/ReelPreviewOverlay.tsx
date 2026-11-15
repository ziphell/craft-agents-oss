/**
 * A cut opened on its own — the timeline, full screen.
 *
 * The project side panel is one door onto a `.reel`; this is the other, for a cut opened from a
 * file link or a conversation whose panel is not in front. The cut is still a file at a path, so
 * the only thing this component decides is which project folder its `assets/` are relative to.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { reelNameOf } from '@craft-agent/shared/reel/document'
import { EditSurface } from './EditSurface'

interface CutContext {
  /** The folder a cut's `src` paths are relative to. */
  contentRoot: string
  projectSlug?: string
}

/**
 * Which root owns a cut, read from the path itself.
 *
 * Cuts live in a project's `reels/` folder, so the folder two levels above it is the project. A
 * cut somewhere else is still editable — its grandparent is the best root it can have.
 */
export function cutContextOf(filePath: string): CutContext {
  const separator = filePath.includes('\\') ? '\\' : '/'
  const parts = filePath.split(/[\\/]+/)
  const reelsAt = parts.lastIndexOf('reels')
  if (reelsAt >= 2 && parts[reelsAt - 2] === 'projects') {
    return {
      contentRoot: parts.slice(0, reelsAt).join(separator),
      projectSlug: parts[reelsAt - 1],
    }
  }
  return { contentRoot: parts.slice(0, -2).join(separator) || '.' }
}

export function ReelPreviewOverlay({
  isOpen,
  onClose,
  filePath,
  workspaceId,
}: {
  isOpen: boolean
  onClose: () => void
  filePath: string
  /** Passed down by the window: this overlay is drawn outside the shell's own context. */
  workspaceId?: string
}) {
  const { t } = useTranslation()
  const context = React.useMemo(() => cutContextOf(filePath), [filePath])

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-background">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
          {reelNameOf(filePath)}
          <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">.reel</span>
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.close')}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="relative min-h-0 flex-1">
        <EditSurface
          workspaceId={workspaceId ?? ''}
          projectFolder={context.contentRoot}
          projectSlug={context.projectSlug ?? ''}
          path={filePath}
          active
        />
      </div>
    </div>
  )
}
