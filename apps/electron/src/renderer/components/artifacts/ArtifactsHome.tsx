/**
 * ArtifactsHome
 *
 * Workspace-scoped artifact list: the navigator slot's content while the
 * Artifacts item is active. One row per artifact — its drawn preview, its title
 * (the file's name), and a status dot. An artifact's own page is the content
 * column beside it. The path is deliberately not shown: a file's name is what
 * somebody picks it by, and the location is one hover action away.
 *
 * The list is an **inbox**: newest first is the order that answers "what just
 * changed", and it is already the order `deriveArtifactEntries` hands over — so
 * this sorts nothing. The status dot is a placeholder: what "needs me" means is a
 * later pass, and a list that guessed at it now would say something wrong.
 *
 * A row's actions come from the file's place on disk: "open folder" hands the
 * absolute path to the shell, resolved from the active workspace root the same
 * way the artifact page resolves it. There is no root without a workspace, so the
 * actions are simply absent then rather than pointing nowhere.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, FolderOpen, Workflow } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { ScrollArea } from '@/components/ui/scroll-area'
import { EntityRow } from '@/components/ui/entity-row'
import { EntityListEmptyScreen } from '@/components/ui/entity-list-empty'
import { useMenuComponents } from '@/components/ui/menu-context'
import { useActiveWorkspace } from '@/context/AppShellContext'
import { ArtifactThumbnail } from './ArtifactThumbnail'
import { artifactAbsolutePath, type ArtifactEntry } from '@craft-agent/shared/artifacts'

export interface ArtifactsHomeProps {
  artifacts: ArtifactEntry[]
  /** The active workspace, which the host needs to find the file it draws a preview from. */
  workspaceId?: string | null
  /** Opens the artifact's own page. */
  onArtifactClick: (relativePath: string) => void
  selectedPath?: string | null
  className?: string
}

export function ArtifactsHome({
  artifacts,
  workspaceId,
  onArtifactClick,
  selectedPath,
  className,
}: ArtifactsHomeProps) {
  const { t } = useTranslation()
  const workspace = useActiveWorkspace()
  const rootPath = workspace?.rootPath ?? null

  // "Copy path" copies the artifact's identity — its workspace-relative path — not
  // the machine-specific absolute one, so it stays meaningful in a conversation.
  const copyPath = React.useCallback(
    async (relativePath: string) => {
      await navigator.clipboard.writeText(relativePath)
      toast.success(t('toast.pathCopied'))
    },
    [t],
  )

  if (artifacts.length === 0) {
    return (
      <div className={cn('flex flex-col flex-1 min-h-0', className)}>
        <EntityListEmptyScreen
          icon={<Workflow />}
          title={t('artifacts.emptyTitle')}
          description={t('artifacts.emptyDescription')}
        />
      </div>
    )
  }

  return (
    <div className={cn('flex flex-col flex-1 min-h-0', className)}>
      <ScrollArea className="flex-1">
        <div className="pb-2" data-list-role="artifacts">
          <div className="pt-1">
            {/* Each row leads with the artifact's drawn preview when there is a workspace to
                draw it from; the preview falls back to the row's own icon on its own, so a
                list without one never looks broken. */}
            {artifacts.map((artifact, index) => {
              const absolutePath = rootPath ? artifactAbsolutePath(rootPath, artifact.path) : null
              return (
                <EntityRow
                  key={artifact.path}
                  showSeparator={index > 0}
                  isSelected={selectedPath === artifact.path}
                  onMouseDown={(e: React.MouseEvent) => {
                    if (e.button === 0) onArtifactClick(artifact.path)
                  }}
                  leading={
                    workspaceId ? (
                      <ArtifactThumbnail
                        workspaceId={workspaceId}
                        relativePath={artifact.path}
                        mtimeMs={artifact.mtimeMs}
                      />
                    ) : undefined
                  }
                  icon={<Workflow className="h-3.5 w-3.5 text-foreground/60" />}
                  title={artifact.title}
                  // The actions belong on the title's own line, not floating at the row's
                  // corner: `titleTrailing` is what the `…` button swaps with on hover, so
                  // the button lands right-aligned and centred on the title. The dot is the
                  // placeholder it shows the rest of the time.
                  titleTrailing={<StatusDot />}
                  menuContent={
                    absolutePath ? (
                      <ArtifactMenu
                        onOpenFolder={() => window.electronAPI.showInFolder(absolutePath)}
                        onCopyPath={() => copyPath(artifact.path)}
                      />
                    ) : undefined
                  }
                />
              )
            })}
          </div>
        </div>
      </ScrollArea>
    </div>
  )
}

/**
 * A row's menu: the same two actions as the hover cluster, drawn for the `…`
 * button and the right-click menu. Built from the menu primitives in context
 * (SourceMenu's pattern) so it renders identically in both surfaces.
 */
function ArtifactMenu({ onOpenFolder, onCopyPath }: { onOpenFolder: () => void; onCopyPath: () => void }) {
  const { t } = useTranslation()
  const { MenuItem } = useMenuComponents()

  return (
    <>
      <MenuItem onClick={onOpenFolder}>
        <FolderOpen className="h-3.5 w-3.5" />
        <span className="flex-1">{t('artifacts.openFolder')}</span>
      </MenuItem>
      <MenuItem onClick={onCopyPath}>
        <Copy className="h-3.5 w-3.5" />
        <span className="flex-1">{t('artifacts.copyPath')}</span>
      </MenuItem>
    </>
  )
}

/**
 * The status area — a dot for now.
 *
 * The real "needs me" rule is a later pass; until it exists this is deliberately
 * inert rather than a guess, so nothing in the list reads as a claim it cannot back.
 */
function StatusDot() {
  return <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-foreground/20" aria-hidden="true" />
}
