import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { FadingText } from '@/components/ui/fading-text'
import { SkillAvatar } from '@/components/ui/skill-avatar'
import { SourceAvatar } from '@/components/ui/source-avatar'
import type { LoadedSkill, LoadedSource, FileSearchResult } from '../../../shared/types'
import type { LoadedDesign } from '@craft-agent/shared/designs/types'
import { AGENTS_PLUGIN_NAME } from '@craft-agent/shared/skills/types'
import { buildDesignMention, buildTabMention, designLabel, tabLabel, type TabRef } from '@craft-agent/shared/mentions'
import { MentionIcon, mentionIconKindFor } from '@craft-agent/ui'

// ============================================================================
// Types
// ============================================================================

export type MentionItemType = 'skill' | 'source' | 'file' | 'folder' | 'tab' | 'design'

export interface MentionItem {
  id: string
  type: MentionItemType
  label: string
  description?: string
  // Type-specific data
  skill?: LoadedSkill
  source?: LoadedSource
  file?: { path: string; type: 'file' | 'directory'; relativePath: string }
  tab?: TabRef
  design?: LoadedDesign
}

export interface MentionSection {
  id: string
  label: string
  items: MentionItem[]
}

export interface InlineMentionMenuProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sections: MentionSection[]
  onSelect: (item: MentionItem) => void
  filter?: string
  position: { x: number; y: number }
  workspaceId?: string
  maxWidth?: number
  className?: string
  /** Whether file search is in progress */
  isSearching?: boolean
}

// ============================================================================
// Shared Styles
// ============================================================================

const MENU_CONTAINER_STYLE = 'overflow-hidden rounded-[8px] bg-background text-foreground shadow-modal-small'
const MENU_LIST_STYLE = 'max-h-[240px] overflow-y-auto py-1'
const MENU_ITEM_STYLE = 'flex cursor-pointer select-none items-center gap-3 rounded-[6px] mx-1 px-2 py-1.5 text-[13px]'
const MENU_ITEM_SELECTED = 'bg-foreground/5'
// Type badge shown to the right of each item label (e.g. "Skill", "Source")
const MENU_TYPE_BADGE = 'rounded-[4px] shadow-minimal bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground shrink-0'

// ============================================================================
// Path utilities
// ============================================================================

/** Extract parent directory from a relative path (e.g. "src/components/Button.tsx" → "src/components/") */
function getParentDir(relativePath: string): string {
  const lastSlash = relativePath.lastIndexOf('/')
  if (lastSlash <= 0) return ''
  return relativePath.slice(0, lastSlash + 1)
}

/** Check if query characters appear in order within target.
 *  Returns true if all characters of query are found sequentially in target.
 *  Note: comparison is literal — pass lowercased inputs for case-insensitive matching. */
function subsequenceMatch(target: string, query: string): boolean {
  let qi = 0
  for (let ti = 0; ti < target.length && qi < query.length; ti++) {
    if (target[ti] === query[qi]) qi++
  }
  return qi === query.length
}

/** Filter cached FileSearchResults by query and convert to MentionItems.
 *  Uses substring matching first (score 2), then subsequence matching as
 *  fallback (score 1) so queries like "appav" find "app availability.md". */
function filterCacheResults(cache: FileSearchResult[], query: string): MentionItem[] {
  const lowerQuery = query.trimEnd().toLowerCase()
  if (!lowerQuery) return []

  const scored = cache
    .map(f => {
      const name = f.name.toLowerCase()
      const path = f.relativePath.toLowerCase()
      let score = 0
      if (name.includes(lowerQuery) || path.includes(lowerQuery)) {
        score = 2
      } else if (subsequenceMatch(name, lowerQuery) || subsequenceMatch(path, lowerQuery)) {
        score = 1
      }
      return { f, score }
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)

  return scored.map(({ f }) => ({
    id: f.path,
    type: f.type === 'directory' ? 'folder' as const : 'file' as const,
    label: f.name,
    description: f.relativePath,
    file: { path: f.path, type: f.type, relativePath: f.relativePath },
  }))
}

// ============================================================================
// Filter utilities
// ============================================================================

/**
 * Get match priority score for filtering (higher = better match)
 * 3 = starts with filter (first word)
 * 2 = word boundary match (2nd+ word after space/hyphen/underscore)
 * 1 = contains filter (mid-word)
 * 0 = no match
 */
function getMatchScore(text: string, filter: string): number {
  const lowerText = text.toLowerCase()
  // Best: starts with filter (first word)
  if (lowerText.startsWith(filter)) return 3
  // Good: word boundary match (after space/hyphen/underscore)
  const escapedFilter = filter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const wordBoundaryPattern = new RegExp(`[\\s\\-_]${escapedFilter}`)
  if (wordBoundaryPattern.test(lowerText)) return 2
  // OK: contains filter anywhere
  if (lowerText.includes(filter)) return 1
  return 0
}

function filterSections(sections: MentionSection[], filter: string): MentionSection[] {
  if (!filter) return sections
  const lowerFilter = filter.trimEnd().toLowerCase()
  if (!lowerFilter) return sections

  // Collect all matching items across sections
  const allItems = sections.flatMap(section => section.items)
  const matchingItems = allItems.filter(item =>
    item.label?.toLowerCase().includes(lowerFilter) ||
    item.id?.toLowerCase().includes(lowerFilter) ||
    item.description?.toLowerCase().includes(lowerFilter)
  )

  // Sort by match priority: first word > later word > contains
  matchingItems.sort((a, b) => {
    const aLabelScore = getMatchScore(a.label, lowerFilter)
    const bLabelScore = getMatchScore(b.label, lowerFilter)
    const aIdScore = getMatchScore(a.id, lowerFilter)
    const bIdScore = getMatchScore(b.id, lowerFilter)

    // Compare by best score (label or id)
    const aScore = Math.max(aLabelScore, aIdScore)
    const bScore = Math.max(bLabelScore, bIdScore)
    if (aScore !== bScore) return bScore - aScore

    // Same score tier: alphabetical by label
    return a.label.localeCompare(b.label)
  })

  // Return as flat list in a single virtual section (headers hidden when filtering)
  if (matchingItems.length === 0) return []
  return [{ id: 'results', label: 'Results', items: matchingItems }]
}

function flattenItems(sections: MentionSection[]): MentionItem[] {
  return sections.flatMap(section => section.items)
}

/**
 * Check if the @ character at the given position is a valid mention trigger.
 * Valid triggers are:
 * - @ at the start of input (position 0)
 * - @ preceded by whitespace (space, tab, newline)
 * - @ preceded by opening brackets or quotes: ( " '
 *
 * Invalid triggers (returns false):
 * - @ in the middle of a word (e.g., "test@example.com")
 * - @ preceded by alphanumeric or other characters
 *
 * @param textBeforeCursor - The text from start of input to cursor position
 * @param atPosition - The position of the @ character in textBeforeCursor
 * @returns true if this @ should trigger the mention menu
 */
export function isValidMentionTrigger(textBeforeCursor: string, atPosition: number): boolean {
  if (atPosition < 0) return false
  if (atPosition === 0) return true
  const charBefore = textBeforeCursor[atPosition - 1]
  if (charBefore === undefined) return false
  // Allow whitespace or opening brackets/quotes before @
  return /\s/.test(charBefore) || /[("']/.test(charBefore)
}

// ============================================================================
// InlineMentionMenu Component
// ============================================================================

export function InlineMentionMenu({
  open,
  onOpenChange,
  sections,
  onSelect,
  filter = '',
  position,
  workspaceId,
  maxWidth = 280,
  className,
}: InlineMentionMenuProps) {
  const { t } = useTranslation()
  const menuRef = React.useRef<HTMLDivElement>(null)
  const listRef = React.useRef<HTMLDivElement>(null)
  const [selectedIndex, setSelectedIndex] = React.useState(0)
  const filteredSections = filterSections(sections, filter)
  const flatItems = flattenItems(filteredSections)

  // Reset selection when filter changes
  React.useEffect(() => {
    setSelectedIndex(0)
  }, [filter])

  // Keyboard navigation
  // Don't attach listener when no items - allows Enter to propagate to input handler
  React.useEffect(() => {
    if (!open || flatItems.length === 0) return

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setSelectedIndex(prev => (prev < flatItems.length - 1 ? prev + 1 : 0))
          break
        case 'ArrowUp':
          e.preventDefault()
          setSelectedIndex(prev => (prev > 0 ? prev - 1 : flatItems.length - 1))
          break
        case 'Enter':
        case 'Tab':
          e.preventDefault()
          if (flatItems[selectedIndex]) {
            onSelect(flatItems[selectedIndex])
            onOpenChange(false)
          }
          break
        case 'Escape':
          e.preventDefault()
          onOpenChange(false)
          break
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, flatItems, selectedIndex, onSelect, onOpenChange])

  // Close on click outside
  React.useEffect(() => {
    if (!open) return

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onOpenChange(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open, onOpenChange])

  // Scroll selected item into view when navigating with keyboard
  React.useEffect(() => {
    if (!listRef.current) return
    const selectedEl = listRef.current.querySelector('[data-selected="true"]')
    if (selectedEl) {
      selectedEl.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedIndex])

  if (!open) return null

  // Calculate bottom position from window height (menu appears above cursor)
  const bottomPosition = typeof window !== 'undefined'
    ? window.innerHeight - Math.round(position.y) + 8
    : 0

  return (
    <div
      ref={menuRef}
      data-inline-menu
      className={cn('fixed z-dropdown', MENU_CONTAINER_STYLE, className)}
      style={{
        left: Math.round(position.x) - 10,
        bottom: bottomPosition,
        width: maxWidth,
        maxWidth,
      }}
    >
      {/* Menu header — sticky above scroll area */}
      <div className="px-3 py-1.5 text-[12px] font-medium text-muted-foreground border-b border-foreground/5">
        {t('chat.mentionFilesSkillsSources')}
      </div>

      <div ref={listRef} className={MENU_LIST_STYLE}>
        {flatItems.length === 0 && filter && (
          <div className="px-3 py-2 text-[12px] text-muted-foreground/60">{t('chat.noResults')}</div>
        )}
        {flatItems.map((item, itemIndex) => {
          const isSelected = itemIndex === selectedIndex

          return (
            <div
              key={`${item.type}-${item.id}`}
              data-selected={isSelected}
              onClick={() => {
                onSelect(item)
                onOpenChange(false)
              }}
              onMouseEnter={() => setSelectedIndex(itemIndex)}
              className={cn(
                MENU_ITEM_STYLE,
                isSelected && MENU_ITEM_SELECTED
              )}
            >
              {/* Icon based on type */}
              <div className="shrink-0">
                {item.type === 'skill' && item.skill && (
                  <SkillAvatar skill={item.skill} size="sm" workspaceId={workspaceId} />
                )}
                {item.type === 'source' && item.source && (
                  <SourceAvatar source={item.source} size="sm" />
                )}
                {(item.type === 'file' || item.type === 'folder' || item.type === 'tab' || item.type === 'design') && (
                  // The same icon the composer's chip and the sent badge show (see
                  // @craft-agent/ui → mention-icons), at the menu's own size.
                  <MentionIcon
                    kind={mentionIconKindFor(item.type, item.label)}
                    className="h-4 w-4 text-muted-foreground"
                  />
                )}
              </div>

              {/* Label and optional path/badge */}
              {(item.type === 'file' || item.type === 'folder') ? (
                <>
                  {/* File/folder: filename then parent path fading out on overflow */}
                  <span className="shrink-0">{item.label}</span>
                  {item.file?.relativePath && getParentDir(item.file.relativePath) && (
                    <FadingText className="text-[11px] text-muted-foreground min-w-0 opacity-50" fadeWidth={20}>
                      {getParentDir(item.file.relativePath)}
                    </FadingText>
                  )}
                </>
              ) : (
                <>
                  {/* Anything with a name and a kind — skill, source, tab, design: the name,
                      then a type badge. The kind is what tells two look-alike rows apart, and
                      it reads better than a slug or an address packed in behind the name. */}
                  <div className="flex-1 min-w-0">
                    <span className="truncate block">{item.label}</span>
                  </div>
                  <span className={MENU_TYPE_BADGE}>
                    {item.type === 'skill' ? t('common.skill')
                      : item.type === 'source' ? t('common.source')
                      : item.type === 'design' ? t('common.design')
                      : t('common.tab')}
                  </span>
                </>
              )}
            </div>
          )
        })}

      </div>
    </div>
  )
}

// ============================================================================
// Hook for managing inline mention state
// ============================================================================

/** Interface for elements that can be used with useInlineMention */
export interface MentionInputElement {
  getBoundingClientRect: () => DOMRect
  getCaretRect?: () => DOMRect | null
  value: string
  selectionStart: number
}

export interface UseInlineMentionOptions {
  /** Ref to input element (textarea or RichTextInput handle) */
  inputRef: React.RefObject<MentionInputElement | null>
  skills: LoadedSkill[]
  sources: LoadedSource[]
  /** Base path for file search (working directory) */
  basePath?: string
  /**
   * The workspace's browser tabs, so one can be mentioned as a thing to look at.
   *
   * Passed in rather than fetched here: this hook knows about the menu, not about
   * where any of its items come from (skills, sources and files arrive the same way).
   */
  tabs?: TabRef[]
  /**
   * The workspace's designs, so one can be referenced as the thing to work on.
   *
   * Like the tabs above: passed in rather than fetched here, because this hook knows
   * about the menu, not about where any of its items come from.
   */
  designs?: LoadedDesign[]
  onSelect: (item: MentionItem) => void
  /** Workspace ID for fully-qualified skill names */
  workspaceId?: string
}

export interface UseInlineMentionReturn {
  isOpen: boolean
  filter: string
  position: { x: number; y: number }
  sections: MentionSection[]
  /** Whether file search is in progress */
  isSearching: boolean
  handleInputChange: (value: string, cursorPosition: number) => void
  close: () => void
  handleSelect: (item: MentionItem) => { value: string; cursorPosition: number }
}

export function useInlineMention({
  inputRef,
  skills,
  sources,
  basePath,
  tabs = [],
  designs = [],
  onSelect,
  workspaceId,
}: UseInlineMentionOptions): UseInlineMentionReturn {
  const [isOpen, setIsOpen] = React.useState(false)
  const [filter, setFilter] = React.useState('')
  // committedFilter: only updates when IPC returns (or immediately when no IPC needed).
  // Prevents visual jumps — the menu shows all items until results are ready,
  // then applies filter + file results in a single frame.
  const [committedFilter, setCommittedFilter] = React.useState('')
  const [position, setPosition] = React.useState({ x: 0, y: 0 })
  const [atStart, setAtStart] = React.useState(-1)
  const [fileResults, setFileResults] = React.useState<MentionItem[]>([])
  const fileSearchTimeout = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  // Cache of raw IPC file search results for the current menu session.
  // Allows instant client-side filtering when user edits the query (add/delete chars)
  // without waiting for a new IPC round-trip. Cleared when menu closes.
  const fileCache = React.useRef<FileSearchResult[]>([])
  // Store current input state for handleSelect
  const currentInputRef = React.useRef({ value: '', cursorPosition: 0 })

  // Cleanup pending timeout on unmount
  React.useEffect(() => {
    return () => {
      if (fileSearchTimeout.current) {
        clearTimeout(fileSearchTimeout.current)
      }
    }
  }, [])

  // Build sections from available data (skills, sources, and file search results)
  const sections = React.useMemo((): MentionSection[] => {
    const result: MentionSection[] = []

    // Skills section
    if (skills.length > 0) {
      result.push({
        id: 'skills',
        label: 'Skills',
        items: skills.map(skill => ({
          id: skill.slug,
          type: 'skill' as const,
          label: skill.metadata.name,
          description: skill.metadata.description,
          skill,
        })),
      })
    }

    // Sources section
    if (sources.length > 0) {
      result.push({
        id: 'sources',
        label: 'Sources',
        items: sources
          .filter(source => source.config.slug && source.config.name)
          .map(source => ({
            id: source.config.slug,
            type: 'source' as const,
            label: source.config.name,
            description: source.config.tagline,
            source,
          })),
      })
    }

    // Designs section — the workspace's own designs. A design is not inside any one
    // conversation, so mentioning one is how a conversation says which design it is about.
    if (designs.length > 0) {
      result.push({
        id: 'designs',
        label: 'Designs',
        items: designs
          .filter(design => design.config.slug && design.config.name)
          .map(design => ({
            id: design.config.slug,
            type: 'design' as const,
            label: designLabel({ slug: design.config.slug, name: design.config.name }),
            description: design.config.slug,
            design,
          })),
      })
    }

    // Files section (from async search results)
    if (fileResults.length > 0) {
      result.push({
        id: 'files',
        label: 'Files',
        items: fileResults,
      })
    }

    // Tabs section — the workspace's browser tabs, last because they are not the
    // workspace's own material: a tab is somewhere to look, and mentioning one says
    // which screen is meant without describing it.
    if (tabs.length > 0) {
      result.push({
        id: 'tabs',
        label: 'Tabs',
        items: tabs.map((tab, index) => ({
          // An item needs an id of its own, and a browser tab has none here: the marker
          // carries what the agent needs, not the window's tab id. Index-prefixed so two
          // blank tabs of one window are two items rather than one id twice.
          id: `${index}:${tab.url}`,
          type: 'tab' as const,
          label: tabLabel(tab),
          description: tab.url,
          tab,
        })),
      })
    }

    return result
  }, [skills, sources, fileResults, tabs, designs])

  const handleInputChange = React.useCallback((value: string, cursorPosition: number) => {
    // Store current state for handleSelect
    currentInputRef.current = { value, cursorPosition }

    const textBeforeCursor = value.slice(0, cursorPosition)
    // Match @ followed by up to 100 chars (word chars, hyphens, slashes, dots, and spaces).
    // Spaces are allowed so users can type filenames with spaces (e.g. @app availability.md).
    // The menu auto-closes when a space produces no matches (Slack-style behavior).
    const atMatch = textBeforeCursor.match(/@([\w\-\/.\s]{0,100})?$/)

    // Check if this is a valid @ mention trigger
    const matchStart = atMatch ? textBeforeCursor.lastIndexOf('@') : -1
    const isValidTrigger = atMatch && isValidMentionTrigger(textBeforeCursor, matchStart)

    if (isValidTrigger) {
      const filterText = atMatch[1] || ''

      // Slack-style auto-close: if the query contains a space and the file cache is
      // populated but produces zero matches, close the menu. This prevents the
      // "infinite spaces" problem while still allowing multi-word queries like
      // "app availability.md". Skills/sources rarely have spaces in names, so
      // file cache is the authoritative signal here.
      if (filterText.includes(' ') && fileCache.current.length > 0) {
        const fileMatches = filterCacheResults(fileCache.current, filterText)
        if (fileMatches.length === 0) {
          setIsOpen(false)
          setFilter('')
          setCommittedFilter('')
          setAtStart(-1)
          if (fileSearchTimeout.current) {
            clearTimeout(fileSearchTimeout.current)
            fileSearchTimeout.current = null
          }
          setFileResults([])
          fileCache.current = []
          return
        }
      }

      setAtStart(matchStart)
      setFilter(filterText)

      // Cache-first file search: if cache has entries from a previous IPC call,
      // filter client-side instantly (no IPC, no debounce). Otherwise fire a
      // debounced IPC to populate the cache. Cache clears when menu closes.
      window.electronAPI.debugLog('[mention] filterText:', filterText, 'basePath:', basePath, 'cacheSize:', fileCache.current.length)
      if (basePath && filterText.length >= 1) {
        if (fileCache.current.length > 0) {
          // Cache exists — filter client-side instantly, no IPC needed
          if (fileSearchTimeout.current) {
            clearTimeout(fileSearchTimeout.current)
            fileSearchTimeout.current = null
          }
          const filtered = filterCacheResults(fileCache.current, filterText)
          window.electronAPI.debugLog('[mention] cache hit:', filtered.length, 'items')
          setFileResults(filtered)
          setCommittedFilter(filterText)
        } else {
          // First search — fire debounced IPC to populate cache
          if (fileSearchTimeout.current) clearTimeout(fileSearchTimeout.current)

          fileSearchTimeout.current = setTimeout(async () => {
            try {
              window.electronAPI.debugLog('[mention] calling IPC searchFiles:', basePath, filterText)
              const results = await window.electronAPI.searchFiles(basePath, filterText)
              window.electronAPI.debugLog('[mention] IPC returned:', results?.length, 'results')
              fileCache.current = results
              const filtered = filterCacheResults(fileCache.current, filterText)
              window.electronAPI.debugLog('[mention] after cache filter:', filtered.length, 'items')
              setFileResults(filtered)
              setCommittedFilter(filterText)
            } catch (err) {
              window.electronAPI.debugLog('[mention] IPC searchFiles error:', String(err))
            }
          }, 150)
        }
      } else {
        window.electronAPI.debugLog('[mention] skipping file search (no basePath or empty filter)')
        if (fileSearchTimeout.current) {
          clearTimeout(fileSearchTimeout.current)
          fileSearchTimeout.current = null
        }
        setFileResults([])
        setCommittedFilter(filterText)
      }

      if (inputRef.current) {
        // Try to get actual caret position from the input element
        const caretRect = inputRef.current.getCaretRect?.()

        if (caretRect && caretRect.x > 0) {
          // Use actual caret position
          setPosition({
            x: caretRect.x,
            y: caretRect.y,
          })
        } else {
          // Fallback: position at input element's left edge
          const rect = inputRef.current.getBoundingClientRect()
          const lineHeight = 20
          const linesBeforeCursor = textBeforeCursor.split('\n').length - 1
          setPosition({
            x: rect.left,
            y: rect.top + (linesBeforeCursor + 1) * lineHeight,
          })
        }
      }

      setIsOpen(true)
    } else {
      setIsOpen(false)
      setFilter('')
      setCommittedFilter('')
      setAtStart(-1)
      // Clear file search state and cache when menu closes
      if (fileSearchTimeout.current) {
        clearTimeout(fileSearchTimeout.current)
        fileSearchTimeout.current = null
      }
      setFileResults([])
      fileCache.current = []
    }
  }, [inputRef, basePath])

  const handleSelect = React.useCallback((item: MentionItem): { value: string; cursorPosition: number } => {
    let result = ''
    let newCursorPosition = 0

    if (atStart >= 0) {
      const { value: currentValue, cursorPosition } = currentInputRef.current
      const before = currentValue.slice(0, atStart)
      const after = currentValue.slice(cursorPosition)

      const buildMentionText = (kind: 'skill' | 'source' | 'file' | 'folder', value: string): string =>
        '[' + kind + ':' + value + '] '

      // Build the mention text based on type using bracket syntax.
      // Skills use fully-qualified names (workspaceId:slug) because the SDK's
      // Skill tool requires this format to resolve workspace-scoped skills.
      let mentionText: string
      if (item.type === 'skill') {
        // Plugin name depends on which tier the skill came from:
        //   workspace → workspaceId, project/global → ".agents"
        const pluginName = item.skill?.source === 'workspace' ? workspaceId : AGENTS_PLUGIN_NAME
        const qualifiedName = pluginName ? `${pluginName}:${item.id}` : item.id
        mentionText = buildMentionText('skill', qualifiedName)
      } else if (item.type === 'source') {
        mentionText = buildMentionText('source', item.id)
      } else if (item.type === 'file') {
        // Use relative path for file mentions
        mentionText = buildMentionText('file', item.file?.relativePath || item.id)
      } else if (item.type === 'folder') {
        mentionText = buildMentionText('folder', item.file?.relativePath || item.id)
      } else if (item.type === 'tab' && item.tab) {
        // A tab is not an id the reader can look up: the marker carries its own
        // fields, encoded, which is why it is built rather than spelled out here
        // (see tab-mention).
        mentionText = `${buildTabMention(item.tab)} `
      } else if (item.type === 'design' && item.design) {
        // The same for a design: the marker carries the slug (the identity the design
        // tools take) and the name (the chip's label), encoded (see design-mention).
        mentionText = `${buildDesignMention({ slug: item.design.config.slug, name: item.design.config.name })} `
      } else {
        mentionText = buildMentionText('skill', item.id)
      }

      result = before + mentionText + after
      newCursorPosition = before.length + mentionText.length
    }

    onSelect(item)
    setIsOpen(false)
    setCommittedFilter('')
    // Clear file search state and cache to prevent stale results on next open
    if (fileSearchTimeout.current) {
      clearTimeout(fileSearchTimeout.current)
      fileSearchTimeout.current = null
    }
    setFileResults([])
    fileCache.current = []

    return { value: result, cursorPosition: newCursorPosition }
  }, [onSelect, atStart, workspaceId])

  const close = React.useCallback(() => {
    setIsOpen(false)
    setFilter('')
    setCommittedFilter('')
    setAtStart(-1)
    // Clear file search state and cache to prevent stale results on next open
    if (fileSearchTimeout.current) {
      clearTimeout(fileSearchTimeout.current)
      fileSearchTimeout.current = null
    }
    setFileResults([])
    fileCache.current = []
  }, [])

  return {
    isOpen,
    filter: committedFilter,
    position,
    sections,
    isSearching: false,
    handleInputChange,
    close,
    handleSelect,
  }
}
