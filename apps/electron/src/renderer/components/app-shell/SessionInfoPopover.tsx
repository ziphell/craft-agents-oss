import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerTrigger } from '@/components/ui/drawer'
import { Input } from '@/components/ui/input'
import { useAppShellContext, useSession } from '@/context/AppShellContext'
import { cn } from '@/lib/utils'
import { getFileManagerName } from '@/lib/platform'
import { SessionFilesSection } from '../right-sidebar/SessionFilesSection'
// A type, so it is erased: the barrel reaches node fs, and a value imported from it could not be
// bundled for the renderer.
import type { LoadedProject } from '@craft-agent/shared/projects/types'

interface SessionInfoPopoverProps {
  sessionId: string
  sessionFolderPath?: string
  trigger: React.ReactElement
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
  sideOffset?: number
  contentClassName?: string
  presentation?: 'popover' | 'drawer'
}

const DEFAULT_POPOVER_CONTENT_CLASS = 'w-[360px] h-[460px] min-w-[200px] max-w-[420px] overflow-hidden rounded-[8px] bg-background text-foreground shadow-modal-small p-0'
const DEFAULT_DRAWER_CONTENT_CLASS = [
  'data-[vaul-drawer-direction=bottom]:inset-x-2',
  'data-[vaul-drawer-direction=bottom]:bottom-2',
  'data-[vaul-drawer-direction=bottom]:mt-0',
  'data-[vaul-drawer-direction=bottom]:max-h-[min(82vh,42rem)]',
  'overflow-hidden rounded-[14px] border border-border/60 bg-background shadow-modal-small',
].join(' ')

export function SessionInfoPopover({
  sessionId,
  sessionFolderPath,
  trigger,
  side = 'top',
  align = 'end',
  sideOffset = 6,
  contentClassName,
  presentation = 'popover',
}: SessionInfoPopoverProps) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)

  const handleOpenChange = React.useCallback((nextOpen: boolean) => {
    setOpen(nextOpen)

    if (!nextOpen) {
      requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent('craft:focus-input', {
          detail: { sessionId },
        }))
      })
    }
  }, [sessionId])

  if (presentation === 'drawer') {
    return (
      <Drawer open={open} onOpenChange={handleOpenChange} direction="bottom">
        <DrawerTrigger asChild>
          {trigger}
        </DrawerTrigger>
        <DrawerContent
          className={cn(DEFAULT_DRAWER_CONTENT_CLASS, contentClassName)}
          onOpenAutoFocus={(e) => {
            e.preventDefault()
          }}
        >
          <DrawerHeader className="border-b border-border/50 px-4 py-3 group-data-[vaul-drawer-direction=bottom]/drawer-content:text-left">
            <DrawerTitle className="text-sm font-medium">{t('chat.sessionInfo')}</DrawerTitle>
          </DrawerHeader>
          <div className="flex-1 min-h-0 overflow-hidden">
            <SessionInfoPopoverContent sessionId={sessionId} sessionFolderPath={sessionFolderPath} />
          </div>
        </DrawerContent>
      </Drawer>
    )
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        {trigger}
      </PopoverTrigger>
      <PopoverContent
        className={contentClassName ?? DEFAULT_POPOVER_CONTENT_CLASS}
        side={side}
        align={align}
        sideOffset={sideOffset}
        onOpenAutoFocus={(e) => {
          e.preventDefault()
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault()
        }}
      >
        <SessionInfoPopoverContent sessionId={sessionId} sessionFolderPath={sessionFolderPath} />
      </PopoverContent>
    </Popover>
  )
}

function SessionInfoPopoverContent({ sessionId, sessionFolderPath }: { sessionId: string; sessionFolderPath?: string }) {
  const { t } = useTranslation()
  const session = useSession(sessionId)
  const { onRenameSession } = useAppShellContext()
  const [name, setName] = React.useState('')
  const renameTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const fileManagerName = getFileManagerName()

  // The project this conversation belongs to (undefined = unbound). When it resolves, the panel
  // gains a second tab: the project's own folder beside the session's.
  const workspaceId = session?.workspaceId
  const projectId = session?.projectId
  const [project, setProject] = React.useState<LoadedProject | null>(null)
  const [tab, setTab] = React.useState<'session' | 'project'>('session')

  React.useEffect(() => {
    setName(session?.name || '')
  }, [session?.name])

  // A different conversation means starting back on its session files.
  React.useEffect(() => {
    setTab('session')
  }, [sessionId])

  // Resolve the bound project (id → config + folder paths). Failing to resolve simply means no
  // project tab — the panel stays a plain session-files view.
  React.useEffect(() => {
    if (!workspaceId || !projectId) {
      setProject(null)
      return
    }
    let cancelled = false
    window.electronAPI.getProject(workspaceId, projectId)
      .then((result) => {
        if (!cancelled) setProject((result as LoadedProject | null) ?? null)
      })
      .catch(() => {
        if (!cancelled) setProject(null)
      })
    return () => {
      cancelled = true
    }
  }, [workspaceId, projectId])

  React.useEffect(() => {
    return () => {
      if (renameTimeoutRef.current) {
        clearTimeout(renameTimeoutRef.current)
      }
    }
  }, [])

  const handleNameChange = React.useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const newName = e.target.value
    setName(newName)

    if (renameTimeoutRef.current) {
      clearTimeout(renameTimeoutRef.current)
    }

    renameTimeoutRef.current = setTimeout(() => {
      const trimmed = newName.trim()
      if (trimmed) {
        onRenameSession(sessionId, trimmed)
      }
    }, 500)
  }, [onRenameSession, sessionId])

  const revealFolderPath = tab === 'session' ? sessionFolderPath : project?.folderPath

  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="shrink-0 p-3 border-b border-border/50">
        <label className="text-xs font-medium text-muted-foreground block mb-1.5 select-none">
          {t("chat.title")}
        </label>
        <div className="rounded-lg bg-foreground-2 has-[:focus]:bg-background shadow-minimal transition-colors">
          <Input
            value={name}
            onChange={handleNameChange}
            placeholder={t("chat.titlePlaceholder")}
            className="h-9 py-2 text-sm border-0 shadow-none bg-transparent focus-visible:ring-0"
          />
        </div>
      </div>
      {project ? (
        <>
          <div className="shrink-0 flex items-center justify-between gap-2 border-b border-border/50 px-2 select-none">
            <div className="flex items-center gap-1">
              <InfoTabButton active={tab === 'session'} onClick={() => setTab('session')}>
                {t("chat.sessionFiles")}
              </InfoTabButton>
              <InfoTabButton active={tab === 'project'} onClick={() => setTab('project')}>
                {t("chat.projectFiles")}
              </InfoTabButton>
            </div>
            {revealFolderPath && (
              <button
                type="button"
                // eslint-disable-next-line craft-links/no-direct-file-open -- directories can't be previewed in-app
                onClick={() => window.electronAPI.openFile(revealFolderPath)}
                className="shrink-0 text-xs text-foreground/50 hover:text-foreground/80 hover:underline underline-offset-2 transition-colors"
              >
                {t("chat.viewInFileManager", { fileManager: fileManagerName })}
              </button>
            )}
          </div>
          <div className="flex-1 min-h-0 overflow-hidden">
            {tab === 'session' ? (
              <SessionFilesSection
                sessionId={sessionId}
                sessionFolderPath={sessionFolderPath}
                hideHeader
                className="h-full min-h-0"
              />
            ) : (
              <SessionFilesSection
                projectFolder={{
                  workspaceId: project.workspaceId,
                  projectSlug: project.config.slug,
                  folderPath: project.folderPath,
                }}
                hideHeader
                className="h-full min-h-0"
              />
            )}
          </div>
        </>
      ) : (
        <div className="flex-1 min-h-0 overflow-hidden">
          <SessionFilesSection
            sessionId={sessionId}
            sessionFolderPath={sessionFolderPath}
            hideHeader={false}
            className="h-full min-h-0"
          />
        </div>
      )}
    </div>
  )
}

function InfoTabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'px-2.5 py-1.5 text-xs rounded-t-md border-b-2 transition-colors',
        active
          ? 'border-foreground/80 text-foreground'
          : 'border-transparent text-foreground/60 hover:text-foreground/80'
      )}
    >
      {children}
    </button>
  )
}
