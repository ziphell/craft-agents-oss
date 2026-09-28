import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Command as CommandPrimitive } from 'cmdk'
import { Check, FlaskConical, X } from 'lucide-react'
import { Icon_Folder } from '@craft-agent/ui'

import { ServerDirectoryBrowser } from '@/components/ServerDirectoryBrowser'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { PATH_SEP, getPathBasename } from '@/lib/platform'
import { navigate, routes } from '@/lib/navigate'
import { useWorkingDirectoryState, derivePrototypeChoices } from './use-working-directory-state'

/**
 * Format a path for display with the home directory shortened, e.g.
 * "in Workspace/kanban-view". Returns "" for an empty path.
 */
export function formatPathForDisplay(path: string | undefined, homeDir: string): string {
  if (!path) return ''
  let displayPath = path
  if (homeDir && path.startsWith(homeDir)) {
    const relativePath = path.slice(homeDir.length)
    // Remove leading separator if present, show root separator if empty
    displayPath = relativePath.startsWith(PATH_SEP)
      ? relativePath.slice(1)
      : (relativePath || PATH_SEP)
  }
  return `in ${displayPath}`
}

/** State handed to {@link WorkingDirectorySelectorProps.renderTrigger}. */
export interface WorkingDirectoryTriggerState {
  /** Whether the popover is currently open. */
  open: boolean
  /** A non-session-root folder is selected. */
  hasFolder: boolean
  /** Basename of the selected folder, or undefined when nothing is selected. */
  folderName: string | undefined
  /** Whether this conversation works in a prototype rather than in a folder. */
  hasPrototype: boolean
  /** Prototype this conversation works in, when it does. */
  prototypeSlug: string | undefined
  /** The raw selected path (for tooltips / path display). */
  workingDirectory: string | undefined
  /** Home directory, for shortening displayed paths. */
  homeDir: string
  /** Current git branch of the selected folder, or null. */
  gitBranch: string | null
}

export interface WorkingDirectorySelectorProps {
  workingDirectory?: string
  onWorkingDirectoryChange: (path: string) => void
  /** Session root, offered as the "Reset" target. Undefined disables reset. */
  sessionFolderPath?: string
  workspaceId?: string
  /** Prototype this conversation works in, when it works in one. */
  prototypeSlug?: string
  /** Called when a prototype is picked. Absent hides the prototype list. */
  onPrototypeChange?: (slug: string | null) => void
  /**
   * Renders the popover trigger. The returned element is wrapped in
   * `<PopoverTrigger asChild>`, so it must forward a ref (a DOM element or a
   * ref-forwarding component).
   */
  renderTrigger: (state: WorkingDirectoryTriggerState) => React.ReactElement
  /** Popover side/align — defaults match the chat input badge. */
  side?: 'top' | 'bottom' | 'left' | 'right'
  align?: 'start' | 'center' | 'end'
  sideOffset?: number
}

/**
 * WorkingDirectorySelector — trigger-agnostic picker for **where a conversation
 * works**: a folder, or a prototype's own folder — the two are one choice, so they
 * share one list.
 *
 * Owns the state machine ({@link useWorkingDirectoryState}), the Radix popover with
 * its cmdk list, and the ServerDirectoryBrowser. The trigger itself is supplied by the
 * consumer via `renderTrigger` so the same picker backs both the chat input badge and
 * the Tasks editor field.
 */
export function WorkingDirectorySelector({
  workingDirectory,
  onWorkingDirectoryChange,
  sessionFolderPath,
  workspaceId,
  prototypeSlug,
  onPrototypeChange,
  renderTrigger,
  side = 'top',
  align = 'start',
  sideOffset = 8,
}: WorkingDirectorySelectorProps) {
  const { t } = useTranslation()
  const [popoverOpen, setPopoverOpen] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const closePopover = React.useCallback(() => setPopoverOpen(false), [])

  const {
    homeDir,
    gitBranch,
    filter,
    setFilter,
    sortedRecent: filteredRecent,
    prototypes: allPrototypes,
    hasPrototype,
    hasFolder,
    folderName,
    showReset,
    showFilter,
    handleSelectRecent,
    handleReset,
    handleRemoveRecent,
    handleChooseFolder,
    handleSelectPrototype,
    serverBrowser: {
      showServerBrowser,
      serverBrowserMode,
      cancelServerBrowser,
      confirmServerBrowser,
    },
  } = useWorkingDirectoryState({
    workingDirectory,
    onWorkingDirectoryChange,
    sessionFolderPath,
    workspaceId,
    prototypeSlug,
    onPrototypeChange,
    isOpen: popoverOpen,
    onClose: closePopover,
  })

  // The bound one is already pinned above with its check, so it is not offered twice.
  const otherPrototypes = React.useMemo(
    () => derivePrototypeChoices(allPrototypes, prototypeSlug, filter),
    [allPrototypes, prototypeSlug, filter],
  )

  // Autofocus the filter input on popover open. Lives in the consumer (not
  // the hook) because the compact drawer surface has no autofocus.
  React.useEffect(() => {
    if (popoverOpen && showFilter) {
      const timer = setTimeout(() => {
        inputRef.current?.focus()
      }, 0)
      return () => clearTimeout(timer)
    }
  }, [popoverOpen, showFilter])

  // Styles matching todo-filter-menu.tsx for consistency
  const MENU_CONTAINER_STYLE = 'min-w-[200px] max-w-[400px] overflow-hidden rounded-[8px] bg-background text-foreground shadow-modal-small p-0'
  const MENU_LIST_STYLE = 'max-h-[200px] overflow-y-auto p-1 [&_[cmdk-list-sizer]]:space-y-px'
  const MENU_ITEM_STYLE = 'flex cursor-pointer select-none items-center gap-2 rounded-[6px] px-3 py-1.5 text-[13px] outline-none'

  return (
    <>
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverTrigger asChild>
          {renderTrigger({ open: popoverOpen, hasFolder, folderName, hasPrototype, prototypeSlug, workingDirectory, homeDir, gitBranch })}
        </PopoverTrigger>
        <PopoverContent side={side} align={align} sideOffset={sideOffset} className={MENU_CONTAINER_STYLE}>
          <CommandPrimitive shouldFilter={showFilter}>
            {/* Filter input - only shown when more than 5 recent folders */}
            {showFilter && (
              <div className="border-b border-border/50 px-3 py-2">
                <CommandPrimitive.Input
                  ref={inputRef}
                  value={filter}
                  onValueChange={setFilter}
                  placeholder={t('chat.filterFolders')}
                  className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/50 placeholder:select-none"
                />
              </div>
            )}

            <CommandPrimitive.List className={MENU_LIST_STYLE}>
              {/* Where the conversation works now — one row, whichever kind it is. */}
              {hasPrototype ? (
                <CommandPrimitive.Item
                  value={`current-prototype-${prototypeSlug}`}
                  className={cn(MENU_ITEM_STYLE, 'pointer-events-none bg-foreground/5')}
                  disabled
                >
                  <FlaskConical className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="flex-1 min-w-0 truncate">
                    <span className="font-mono text-xs">{prototypeSlug}</span>
                    <span className="text-muted-foreground ml-1.5">{formatPathForDisplay(workingDirectory, homeDir)}</span>
                  </span>
                  <Check className="h-4 w-4 shrink-0" />
                </CommandPrimitive.Item>
              ) : hasFolder && (
                <CommandPrimitive.Item
                  value={`current-${workingDirectory}`}
                  className={cn(MENU_ITEM_STYLE, 'pointer-events-none bg-foreground/5')}
                  disabled
                >
                  <Icon_Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="flex-1 min-w-0 truncate">
                    <span>{folderName}</span>
                    <span className="text-muted-foreground ml-1.5">{formatPathForDisplay(workingDirectory, homeDir)}</span>
                  </span>
                  <Check className="h-4 w-4 shrink-0" />
                </CommandPrimitive.Item>
              )}

              {/* The other prototypes: the same choice's other kind, so picking one
                  replaces the folder the conversation is in. The label is dropped while
                  a filter is typed, when the rows that survive are already the answer. */}
              {otherPrototypes.length > 0 && (
                <>
                  {!filter && (
                    <div className="px-3 pt-2 pb-1 text-[11px] font-medium text-muted-foreground">
                      {t('chat.prototypes')}
                    </div>
                  )}
                  {otherPrototypes.map((prototype) => (
                    <CommandPrimitive.Item
                      key={prototype.slug}
                      value={`${prototype.slug} prototype`}
                      onSelect={() => handleSelectPrototype(prototype.slug)}
                      className={cn(MENU_ITEM_STYLE, 'group/item data-[selected=true]:bg-foreground/5')}
                    >
                      <FlaskConical className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="flex-1 min-w-0 truncate font-mono text-xs">{prototype.slug}</span>
                    </CommandPrimitive.Item>
                  ))}
                </>
              )}

              {/* Separator before the folders */}
              {(hasFolder || otherPrototypes.length > 0) && filteredRecent.length > 0 && (
                <div className="h-px bg-border my-1 mx-1" />
              )}

              {/* Recent Directories - filterable (current directory already filtered out via filteredRecent) */}
              {filteredRecent.map((path) => {
                const recentFolderName = getPathBasename(path) || 'Folder'
                return (
                  <CommandPrimitive.Item
                    key={path}
                    value={`${recentFolderName} ${path}`}
                    onSelect={() => handleSelectRecent(path)}
                    className={cn(MENU_ITEM_STYLE, 'group/item data-[selected=true]:bg-foreground/5')}
                  >
                    <Icon_Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="flex-1 min-w-0 truncate">
                      <span>{recentFolderName}</span>
                      <span className="text-muted-foreground ml-1.5">{formatPathForDisplay(path, homeDir)}</span>
                    </span>
                    <button
                      type="button"
                      onClick={(e) => handleRemoveRecent(e, path)}
                      data-touch-reveal="true"
                      className="shrink-0 h-3 w-3 rounded-[3px] flex items-center justify-center opacity-0 group-hover/item:opacity-100 text-muted-foreground hover:text-foreground hover:bg-foreground/10 transition-all"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </CommandPrimitive.Item>
                )
              })}

              {/* Empty state when filtering */}
              {showFilter && (
                <CommandPrimitive.Empty className="py-3 text-center text-sm text-muted-foreground">
                  {t('chat.noWorkingDirMatch')}
                </CommandPrimitive.Empty>
              )}
            </CommandPrimitive.List>

            {/* Bottom actions - always visible, outside scrollable area */}
            <div className="border-t border-border/50 p-1">
              <button
                type="button"
                onClick={handleChooseFolder}
                className={cn(MENU_ITEM_STYLE, 'w-full hover:bg-foreground/5')}
              >
                {t('chat.chooseFolder')}
              </button>
              {showReset && (
                <button
                  type="button"
                  onClick={handleReset}
                  className={cn(MENU_ITEM_STYLE, 'w-full hover:bg-foreground/5')}
                >
                  {t('common.reset')}
                </button>
              )}
              {hasPrototype && prototypeSlug && (
                // The one thing the prototype half still needs a door to: the prototype
                // itself. Binding already happened by picking it in the list above.
                <button
                  type="button"
                  onClick={() => {
                    closePopover()
                    navigate(routes.view.prototypes(prototypeSlug))
                  }}
                  className={cn(MENU_ITEM_STYLE, 'w-full hover:bg-foreground/5')}
                >
                  {t('prototypeBind.openPanel')}
                </button>
              )}
            </div>
          </CommandPrimitive>
        </PopoverContent>
      </Popover>
      <ServerDirectoryBrowser
        open={showServerBrowser}
        mode={serverBrowserMode}
        onSelect={confirmServerBrowser}
        onCancel={cancelServerBrowser}
        initialPath={workingDirectory}
      />
    </>
  )
}
