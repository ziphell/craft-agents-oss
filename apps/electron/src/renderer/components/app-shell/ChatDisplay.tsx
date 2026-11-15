import * as React from "react"
import { useTranslation } from "react-i18next"
import { useEffect, useState, useMemo, useCallback } from "react"
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  ExternalLink,
  Info,
  X,
} from "lucide-react"
import { motion, AnimatePresence } from "motion/react"
import { toast } from "sonner"

import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { coerceInputText, appendRestoredInput } from "@/lib/input-text"
import { Markdown, CollapsibleMarkdownProvider, StreamingMarkdown, type RenderMode } from "@/components/markdown"
import { AnimatedCollapsibleContent } from "@/components/ui/collapsible"
import {
  Spinner,
  parseReadResult,
  parseBashResult,
  parseGrepResult,
  parseGlobResult,
  extractOverlayData,
  extractOverlayCards,
  ActivityCardsOverlay,
  CodePreviewOverlay,
  MultiDiffPreviewOverlay,
  TerminalPreviewOverlay,
  GenericOverlay,
  JSONPreviewOverlay,
  DocumentFormattedMarkdownOverlay,
  detectLanguage,
  type ActivityItem,
  type DiffViewerSettings,
} from "@craft-agent/ui"
import { useFocusZone } from "@/hooks/keyboard"
import { useTheme } from "@/hooks/useTheme"
import type { Session, Message, FileAttachment, StoredAttachment, PermissionRequest, CredentialRequest, CredentialResponse, LoadedSource, LoadedSkill } from "../../../shared/types"
import type { AnnotationV1 } from '@craft-agent/core/types'
import type { MessageReply } from '@craft-agent/core/types'
import type { PermissionMode } from "@craft-agent/shared/agent/modes"
import type { ThinkingLevel } from "@craft-agent/shared/agent/thinking-levels"
import {
  TurnRail,
  buildTurnRailItems,
  buildTurnRailItemsFromQuestions,
  ScrollToBottomButton,
  isScrolledToBottom,
  UserMessageBubble,
  groupMessagesByTurn,
  groupMessagesByTurnCached,
  formatActivityAsMarkdown,
  getAssistantTurnUiKey,
  asRecord,
  getAnnotationNoteText,
  isAnnotationFollowUpSent,
  extractAnnotationSelectedText,
  normalizeFollowUpText,
  type OpenAnnotationRequest,
  type Turn,
  type TurnGrouping,
  type UserTurn,
  type SystemTurn,
  type AuthRequestTurn,
} from "@craft-agent/ui"
import { MemoizedAuthRequestCard } from "@/components/chat/AuthRequestCard"
import { ChatInputZone, type StructuredInputState, type StructuredResponse, type PermissionResponse, type AdminApprovalResponse } from "./input"
import { dispatchFocusInputEvent } from "./input/focus-input-events"
import type { RichTextInputHandle } from "@/components/ui/rich-text-input"
import { useBackgroundTasks } from "@/hooks/useBackgroundTasks"
import { useTurnCardExpansion } from "@/hooks/useTurnCardExpansion"
import { useNavigation } from "@/contexts/NavigationContext"
import { useAppShellContext } from "@/context/AppShellContext"
import { navigate, routes } from "@/lib/navigate"
import { CHAT_LAYOUT } from "@/config/layout"
import { agentAttribution, splitQueued, withoutAgentEnvelope } from "@/lib/agent-message"
import { chooseFollowBehavior, isRelocation } from "./ChatDisplay.follow"
import { AssistantTurnItem } from "./AssistantTurnItem"
import type { ChatOverlayState } from "./chat-overlay-state"
import { resolveBranchNewPanelOption } from "./branching"
import { handleErrorMessageAction } from "./error-message-actions"

// ============================================================================
// CSS Custom Highlight API helper
// ============================================================================

/** Access CSS.highlights lazily — avoids stale ref from module-init / HMR timing */
function getCSSHighlights(): Map<string, Highlight> | undefined {
  try {
    return (CSS as any).highlights as Map<string, Highlight> | undefined
  } catch {
    return undefined
  }
}

// ============================================================================
// Overlay State
// ============================================================================
//
// The shape lives in `chat-overlay-state.ts`: a turn's card opens these too (its
// own details, its own diff), so the type cannot belong to this file alone.

function isStackedActivityTool(activity: ActivityItem): boolean {
  const toolName = activity.toolName?.toLowerCase() || ''
  return toolName === 'bash' || toolName.startsWith('mcp__') || toolName.startsWith('browser_')
}

function getTurnKey(turn: Turn): string {
  if (turn.type === 'user') return `user-${turn.message.id}`
  if (turn.type === 'system') return `system-${turn.message.id}`
  if (turn.type === 'auth-request') return `auth-${turn.message.id}`
  return `turn-${turn.turnId}-${turn.timestamp}`
}

/**
 * Gap above a located turn. A turn can be taller than the viewport, so jumping
 * to it must show its opening line — centering would land in the middle of the
 * turn and push the first line off-screen. The gap also clears the top fade
 * mask so that first line isn't half-transparent.
 */
const LOCATED_TURN_TOP_GAP = 32

/** No session, no turns — one shared array so the empty case keeps its identity. */
const NO_TURNS: Turn[] = []

interface ChatDisplayProps {
  session: Session | null
  /**
   * Every question in the conversation (id + opening text), for the turn rail.
   * Must cover the whole history, not just the loaded page.
   */
  onLoadQuestions?: () => Promise<{ id: string; text: string }[]>
  /**
   * Where `query` occurs in the whole conversation (not just what is loaded).
   * Resolves with message ids and per-message counts.
   */
  onSearchMessages?: (query: string) => Promise<{
    total: number
    hits: { id: string; role: string; count: number; index: number }[]
    limited: boolean
  }>
  /**
   * Make one specific message available, resolving when it is in `session.messages`.
   * Used to open a search hit that sits outside the loaded page.
   */
  onRevealMessage?: (messageId: string) => Promise<boolean>
  /**
   * Fetch one more page of older messages, resolving with how many arrived.
   *
   * Only called when the reader has reached the oldest message this client
   * holds and `session.messagesTruncated` says there is more on disk. The chat
   * does not know how the page is produced (IPC, remote, fixture) — it only
   * knows the conversation can grow upwards.
   */
  onLoadOlderMessages?: () => Promise<number>
  /** `replyTo` rides along with the send: what this message answers, if the person picked one. */
  onSendMessage: (message: string, attachments?: FileAttachment[], skillSlugs?: string[], replyTo?: MessageReply) => void
  onOpenFile: (path: string) => void
  onOpenUrl: (url: string) => void
  // Model selection
  currentModel: string
  onModelChange: (model: string, connection?: string) => void
  // Connection selection (auto-pinned on first message, explicitly switchable afterwards)
  /** Callback when the user explicitly picks a model/connection (works mid-session) */
  onConnectionChange?: (connectionSlug: string) => void
  /** Ref for the input, used for external focus control */
  textareaRef?: React.RefObject<RichTextInputHandle>
  /** When true, disables input (e.g., when agent needs activation) */
  disabled?: boolean
  /** Pending permission request for this session */
  pendingPermission?: PermissionRequest
  /** Callback to respond to permission request */
  onRespondToPermission?: (
    sessionId: string,
    requestId: string,
    allowed: boolean,
    alwaysAllow: boolean,
    options?: import('../../../shared/types').PermissionResponseOptions
  ) => void
  /** Pending credential request for this session */
  pendingCredential?: CredentialRequest
  /** Callback to respond to credential request */
  onRespondToCredential?: (sessionId: string, requestId: string, response: CredentialResponse) => void
  // Thinking level (session-level setting)
  /** Current thinking level ('off', 'think', 'max') */
  thinkingLevel?: ThinkingLevel
  /** Callback when thinking level changes */
  onThinkingLevelChange?: (level: ThinkingLevel) => void
  // Advanced options
  /** Current permission mode */
  permissionMode?: PermissionMode
  /** Mode before the last change (plan approval returns to Guarded from it) */
  previousPermissionMode?: PermissionMode
  onPermissionModeChange?: (mode: PermissionMode) => void
  /** Enabled permission modes for Shift+Tab cycling */
  enabledModes?: PermissionMode[]
  // Input value preservation (controlled from parent)
  /** Current input value - preserved across mode switches and conversation changes */
  inputValue?: string
  /** Callback when input value changes */
  onInputChange?: (value: string) => void
  /** Persisted attachment draft for this session (hydrated from disk in ChatPage) */
  attachmentsValue?: FileAttachment[]
  /** Callback when attachment draft changes (add, remove, clear on send) */
  onAttachmentsChange?: (attachments: FileAttachment[]) => void
  // Source selection
  /** Available sources (enabled only) */
  sources?: LoadedSource[]
  /** Callback when source selection changes */
  onSourcesChange?: (slugs: string[]) => void
  // Skill selection (for @mentions)
  /** Available skills for @mention autocomplete */
  skills?: LoadedSkill[]
  // Label selection (for #labels)
  /** Available label configs (tree) for label menu and badge display */
  labels?: import('@craft-agent/shared/labels').LabelConfig[]
  /** Callback when labels change */
  onLabelsChange?: (labels: string[]) => void
  // State/status selection (for # menu and ActiveOptionBadges)
  /** Available workflow states */
  sessionStatuses?: import('@/config/session-status-config').SessionStatus[]
  /** Callback when session state changes */
  onSessionStatusChange?: (stateId: string) => void
  /** Workspace ID for loading skill icons */
  workspaceId?: string
  // Working directory (per session)
  /** Current working directory for this session */
  workingDirectory?: string
  /** Callback when working directory changes */
  onWorkingDirectoryChange?: (path: string) => void
  /** Session folder path (for "Reset to Session Root" option) */
  sessionFolderPath?: string
  // Lazy loading
  /** When true, messages are still loading - show spinner in messages area */
  messagesLoading?: boolean
  /** Message load failure shown instead of an infinite spinner */
  messagesLoadError?: string | null
  /** Whether a retry is currently in flight */
  messagesRetrying?: boolean
  /** Retry lazy-loading the session transcript */
  onRetryMessagesLoad?: () => void
  // Tutorial
  /** Disable send action (for tutorial guidance) */
  disableSend?: boolean
  // Search highlighting (from session list search)
  /** Search query for highlighting matches - passed from session list */
  searchQuery?: string
  /** Whether search mode is active (prevents focus stealing to chat input) */
  isSearchModeActive?: boolean
  /** Callback when match info changes - for immediate UI updates */
  onMatchInfoChange?: (info: { count: number; index: number; isHighlighting: boolean; sessionId: string | null }) => void
  // Compact mode (for EditPopover embedding and auto-compact / WebUI mobile)
  /** Enable compact mode - hides non-essential UI elements for popover embedding */
  compactMode?: boolean
  /**
   * When compactMode is true, enable the compact (drawer-based) model selector
   * next to the permission-mode pill. Defaults to false so EditPopover keeps
   * its current behavior; ChatPage opts in when in auto-compact / mobile.
   */
  enableCompactModelPicker?: boolean
  /** Custom placeholder for input (used in compact mode for edit context) */
  placeholder?: string | string[]
  /** Label shown as empty state in compact mode (e.g., "Permission Settings") */
  emptyStateLabel?: string
  /** When true, the session's locked connection has been removed - disables send and shows unavailable state */
  connectionUnavailable?: boolean
}

import {
  formatFollowUpSection,
  normalizeFollowUpsMarkdown,
  truncateForChipTooltip,
  type PendingFollowUpAnnotation,
} from './ChatDisplay.follow-ups'

/**
 * Imperative handle exposed via forwardRef for navigation between matches
 */
export interface ChatDisplayHandle {
  goToNextMatch: () => void
  goToPrevMatch: () => void
  matchCount: number
  currentMatchIndex: number
  isHighlighting: boolean
}

/**
 * One occurrence of the search query.
 *
 * Identified by the message it lives in and which occurrence of the query that
 * is *within* that message, so it can be turned back into a DOM range once the
 * message is rendered — including when it had to be loaded on the way there.
 */
interface SearchMatch {
  matchId: string
  messageId: string
  role: string
  occurrence: number
}

/**
 * How many occurrences the client keeps as a flat list. Above this, navigation
 * still works over the first N; the total shown comes from the server.
 */
const MAX_SEARCH_MATCHES = 2000

/**
 * Processing status messages - cycles through these randomly
 * Inspired by Claude Code's playful status messages
 */
const PROCESSING_MESSAGE_KEYS = [
  'chat.processing.thinking',
  'chat.processing.pondering',
  'chat.processing.contemplating',
  'chat.processing.reasoning',
  'chat.processing.processing',
  'chat.processing.computing',
  'chat.processing.considering',
  'chat.processing.reflecting',
  'chat.processing.deliberating',
  'chat.processing.cogitating',
  'chat.processing.ruminating',
  'chat.processing.musing',
  'chat.processing.workingOnIt',
  'chat.processing.onIt',
  'chat.processing.crunching',
  'chat.processing.brewing',
  'chat.processing.connectingDots',
  'chat.processing.mullingItOver',
  'chat.processing.deepInThought',
  'chat.processing.hmm',
  'chat.processing.letMeSee',
  'chat.processing.oneMoment',
  'chat.processing.holdOn',
  'chat.processing.bearWithMe',
  'chat.processing.justASec',
  'chat.processing.hangTight',
  'chat.processing.gettingThere',
  'chat.processing.almost',
  'chat.processing.working',
  'chat.processing.busyBusy',
  'chat.processing.whirring',
  'chat.processing.churning',
  'chat.processing.percolating',
  'chat.processing.simmering',
  'chat.processing.cooking',
  'chat.processing.baking',
  'chat.processing.stirring',
  'chat.processing.spinningUp',
  'chat.processing.warmingUp',
  'chat.processing.revving',
  'chat.processing.buzzing',
  'chat.processing.humming',
  'chat.processing.ticking',
  'chat.processing.clicking',
  'chat.processing.whizzing',
  'chat.processing.zooming',
  'chat.processing.zipping',
  'chat.processing.chugging',
  'chat.processing.trucking',
  'chat.processing.rolling',
]

/**
 * Format elapsed time: "45s" under a minute, "1:02" for 1+ minutes
 */
function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`
}

interface ProcessingIndicatorProps {
  /** Start timestamp (persists across remounts) */
  startTime?: number
  /** Override cycling messages with explicit status (e.g., "Compacting...") */
  statusMessage?: string
}

/**
 * ProcessingIndicator - Shows cycling status messages with elapsed time
 * Matches TurnCard header layout for visual continuity
 */
function ProcessingIndicator({ startTime, statusMessage }: ProcessingIndicatorProps) {
  const { t } = useTranslation()
  const [elapsed, setElapsed] = React.useState(0)
  const [messageIndex, setMessageIndex] = React.useState(() =>
    Math.floor(Math.random() * PROCESSING_MESSAGE_KEYS.length)
  )

  // Update elapsed time every second using provided startTime
  React.useEffect(() => {
    const start = startTime || Date.now()
    // Set initial elapsed immediately
    setElapsed(Math.floor((Date.now() - start) / 1000))

    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - start) / 1000))
    }, 1000)
    return () => clearInterval(interval)
  }, [startTime])

  // Cycle through messages every 10 seconds (only when not showing status)
  React.useEffect(() => {
    if (statusMessage) return  // Don't cycle when showing status
    const interval = setInterval(() => {
      setMessageIndex(prev => {
        // Pick a random different message
        let next = Math.floor(Math.random() * PROCESSING_MESSAGE_KEYS.length)
        while (next === prev && PROCESSING_MESSAGE_KEYS.length > 1) {
          next = Math.floor(Math.random() * PROCESSING_MESSAGE_KEYS.length)
        }
        return next
      })
    }, 10000)
    return () => clearInterval(interval)
  }, [statusMessage])

  // Use status message if provided, otherwise cycle through default messages
  const displayMessage = statusMessage || t(PROCESSING_MESSAGE_KEYS[messageIndex])

  return (
    <div className="flex items-center gap-2 px-3 py-1 -mb-1 text-[13px] text-muted-foreground">
      {/* Spinner in same location as TurnCard chevron */}
      <div className="w-3 h-3 flex items-center justify-center shrink-0">
        <Spinner className="text-[10px]" />
      </div>
      {/* Label with crossfade animation on content change only */}
      <span className="relative h-5 flex items-center">
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={displayMessage}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.4, ease: 'easeInOut' }}
          >
            {displayMessage}
          </motion.span>
        </AnimatePresence>
        {elapsed >= 1 && (
          <span className="text-muted-foreground/60 ml-1 tabular-nums">
            {formatElapsed(elapsed)}
          </span>
        )}
      </span>
    </div>
  )
}

/**
 * Puts the conversation on its newest turn when the content mounts, before
 * paint.
 *
 * It scrolls the viewport itself rather than calling `scrollIntoView` on an end
 * anchor: that form scrolls every scrollable ancestor too (drag-anywhere
 * panels, the shell), so a chat embedded in a taller page can move the page
 * instead of the conversation.
 *
 * The first layout is not the last one — highlighted code, images, preview
 * blocks and diagrams get their height after this paint — so the pin is
 * asserted again over the next frames. Without that, a conversation can open
 * on its *first* message simply because everything below it arrived late.
 */
function PinToBottomOnMount({
  viewportRef,
  resetKey,
  onScroll,
  skip = false
}: {
  viewportRef: React.RefObject<HTMLDivElement | null>
  /**
   * Re-pin when this changes, not only when the component mounts.
   *
   * Compact/mobile keeps one transcript element for every session (the session
   * key would push the panel in and out on every switch), so a mount-only pin
   * would never fire there and the next conversation would open wherever the
   * last one was left.
   */
  resetKey?: string | null
  onScroll?: () => void
  skip?: boolean
}) {
  React.useLayoutEffect(() => {
    if (skip) return
    const viewport = viewportRef.current
    if (!viewport) return

    const pin = () => viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'instant' })
    pin()
    onScroll?.()

    let second = 0
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(pin)
    })
    return () => {
      cancelAnimationFrame(first)
      if (second !== 0) cancelAnimationFrame(second)
    }
    // `resetKey` is a dependency on purpose: it is the only thing that says a
    // different conversation is now in this element.
  }, [skip, resetKey])
  return null
}

/**
 * ChatDisplay - Main chat interface for a selected session
 *
 * Structure:
 * - Session Header: Avatar + workspace name
 * - Messages Area: Scrollable list of MessageBubble components
 * - Input Area: Textarea + Send button
 *
 * Shows empty state when no session is selected
 */
export const ChatDisplay = React.forwardRef<ChatDisplayHandle, ChatDisplayProps>(function ChatDisplay({
  session,
  onSendMessage,
  onOpenFile,
  onOpenUrl,
  currentModel,
  onModelChange,
  onConnectionChange,
  textareaRef: externalTextareaRef,
  disabled = false,
  pendingPermission,
  onRespondToPermission,
  pendingCredential,
  onRespondToCredential,
  // Thinking level
  thinkingLevel = 'medium',
  onThinkingLevelChange,
  // Advanced options
  permissionMode = 'ask',
  previousPermissionMode,
  onPermissionModeChange,
  enabledModes,
  // Input value preservation
  inputValue,
  onInputChange,
  attachmentsValue,
  onAttachmentsChange,
  // Sources
  sources,
  onSourcesChange,
  // Skills (for @mentions)
  skills,
  // Labels (for #labels)
  labels,
  onLabelsChange,
  // States (for # menu and badge)
  sessionStatuses,
  onSessionStatusChange,
  workspaceId,
  // Working directory
  workingDirectory,
  onWorkingDirectoryChange,
  sessionFolderPath,
  // Lazy loading
  onLoadOlderMessages,
  onLoadQuestions,
  onSearchMessages,
  onRevealMessage,
  messagesLoading = false,
  messagesLoadError,
  messagesRetrying = false,
  onRetryMessagesLoad,
  // Tutorial
  disableSend = false,
  // Search highlighting
  searchQuery: externalSearchQuery,
  isSearchModeActive = false,
  onMatchInfoChange,
  // Compact mode (for EditPopover embedding and auto-compact / WebUI mobile)
  compactMode = false,
  enableCompactModelPicker = false,
  placeholder,
  emptyStateLabel,
  // Connection unavailable
  connectionUnavailable = false,
}, ref) {
  const { t } = useTranslation()

  // Panel focus state (for multi-panel auto-scroll behavior)
  const appShellContext = useAppShellContext()
  const isFocusedPanel = appShellContext?.isFocusedPanel ?? true

  // Input is only disabled when explicitly disabled (e.g., agent needs activation)
  // User can type during streaming - submitting will stop the stream and send
  const isInputDisabled = disabled
  const scrollViewportRef = React.useRef<HTMLDivElement>(null)
  const prevSessionIdRef = React.useRef<string | null>(null)
  // Reverse pagination: show last N turns initially, load more on scroll up
  const TURNS_PER_PAGE = 20
  const [visibleTurnCount, setVisibleTurnCount] = React.useState(TURNS_PER_PAGE)
  // Sticky-bottom: When true, auto-scroll on content changes. Toggled by user scroll behavior.
  const isStickToBottomRef = React.useRef(true)
  // Same fact, as state, for the return-to-bottom button: the ref alone cannot
  // re-render anything when the reader scrolls away.
  const [isAtBottom, setIsAtBottom] = React.useState(true)
  // Mirror isFocusedPanel into a ref so the ResizeObserver closure reads the latest value
  const isFocusedPanelRef = React.useRef(isFocusedPanel)
  isFocusedPanelRef.current = isFocusedPanel
  // The live session and shell, for handlers that must keep their identity.
  //
  // A streamed token replaces the session object, so any callback that closes
  // over it is a new function on every token — which switches off `React.memo`
  // for every turn card it is passed to. Reading through a ref keeps those
  // callbacks stable while still seeing the newest state when they run.
  const liveSessionRef = React.useRef(session)
  liveSessionRef.current = session
  const liveShellRef = React.useRef(appShellContext)
  liveShellRef.current = appShellContext
  // Skip smooth scroll briefly after session switch (instant scroll already happened)
  const skipSmoothScrollUntilRef = React.useRef(0)
  // Older messages arrive from disk, not from memory: `visibleTurnCount` only
  // decides how many of the *loaded* turns are shown, so the two refs below say
  // whether asking for a page is even meaningful right now.
  const visibleTurnCountRef = React.useRef(TURNS_PER_PAGE)
  visibleTurnCountRef.current = visibleTurnCount
  const messagesTruncatedRef = React.useRef(false)
  messagesTruncatedRef.current = session?.messagesTruncated ?? false
  const loadOlderMessagesRef = React.useRef(onLoadOlderMessages)
  loadOlderMessagesRef.current = onLoadOlderMessages
  const loadingOlderRef = React.useRef(false)
  // A page is being inserted above the reader right now: the next commit is
  // theirs to be held still for. (Streaming growth is not — that belongs at the
  // bottom and must not move the scroll position.)
  const prependPendingRef = React.useRef(false)
  // Content height at the previous commit, so the shift a prepend causes can be
  // measured exactly rather than guessed.
  const lastContentHeightRef = React.useRef(0)
  // Track message commit boundaries so we can auto-scroll when a new user message
  // actually lands in state (important when attachments delay optimistic insertion).
  const prevLastMessageIdRef = React.useRef<string | null>(null)
  const prevMessageCountRef = React.useRef(0)
  const prevSessionIdForCommitScrollRef = React.useRef<string | null>(null)
  const internalTextareaRef = React.useRef<RichTextInputHandle>(null)
  const textareaRef = externalTextareaRef || internalTextareaRef
  const [sendMessageKey, setSendMessageKey] = useState<'enter' | 'cmd-enter'>('enter')
  const [openAnnotationRequest, setOpenAnnotationRequest] = React.useState<OpenAnnotationRequest | null>(null)
  const followUpOpenNonceRef = React.useRef(0)

  // Navigation for session branching
  const { navigate } = useNavigation()

  // Get isDark from useTheme hook for overlay theme
  // This accounts for scenic themes (like Haze) that force dark mode
  const { isDark } = useTheme()

  // Register as focus zone - when zone gains focus, focus the textarea
  // Guard with isFocusedPanelRef so only the focused panel responds in multi-panel layouts
  const { zoneRef, isFocused } = useFocusZone({
    zoneId: 'chat',
    enabled: isFocusedPanel,
    focusFirst: () => {
      if (isFocusedPanelRef.current) {
        textareaRef.current?.focus()
      }
    },
  })

  // Background tasks management
  const { tasks: backgroundTasks, killTask } = useBackgroundTasks({
    sessionId: session?.id ?? ''
  })

  // TurnCard expansion state — persisted to localStorage across session switches
  const {
    expandedTurns,
    toggleTurn,
    expandedActivityGroups,
    setExpandedActivityGroups,
  } = useTurnCardExpansion(session?.id)


  // ============================================================================
  // Search Highlighting (from session list search)
  // ============================================================================
  // Current match index for navigation (internal state, exposed via ref)
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0)
  const turnRefs = React.useRef<Map<string, HTMLDivElement>>(new Map())
  // Inject ::highlight() styles at runtime to avoid LightningCSS build warnings
  // (the optimizer doesn't recognize ::highlight as a valid pseudo-element yet)
  React.useEffect(() => {
    const id = 'search-highlight-styles'
    if (document.getElementById(id)) return
    const style = document.createElement('style')
    style.id = id
    style.textContent = `
      ::highlight(search-passive) { background-color: rgb(253 224 71 / 0.3); color: inherit; }
      ::highlight(search-active) { background-color: rgb(253 224 71); color: rgb(0 0 0 / 0.9); }
    `
    document.head.appendChild(style)
  }, [])
  // Flag to control when scrolling to matches should happen
  // Only scroll when: session changes with search active, or user clicks navigation
  const shouldScrollToMatchRef = React.useRef(false)
  const prevSessionIdForScrollRef = React.useRef<string | null>(null)

  // Use the external search query from props
  const searchQuery = externalSearchQuery || ''
  // Require 2+ characters to activate in-chat search (aligned with session list isSearchMode)
  const isSearchActive = searchQuery.trim().length >= 2

  // Focus textarea when zone gains focus via keyboard (Tab, Cmd+3, ArrowRight)
  // Requires isFocused to be true - respects zone architecture
  // Does NOT auto-focus just because session changed (that would steal focus from SessionList)
  // Uses isSearchModeActive (prop) instead of isSearchActive (query-based) to prevent
  // focus stealing when search is open but query is empty
  // In multi-panel layouts, only the focused panel should auto-focus its textarea
  useEffect(() => {
    if (session && !isSearchModeActive && isFocused && isFocusedPanel) {
      textareaRef.current?.focus()
    }
  }, [session?.id, isFocused, isSearchModeActive, isFocusedPanel])

  useEffect(() => {
    let isMounted = true

    const loadSendMessageKey = async () => {
      if (!window.electronAPI) return

      try {
        const key = await window.electronAPI.getSendMessageKey()
        if (!isMounted) return
        setSendMessageKey(key ?? 'enter')
      } catch (error) {
        console.error('Failed to load send message key for follow-up view:', error)
      }
    }

    loadSendMessageKey()

    return () => {
      isMounted = false
    }
  }, [])

  // Reset match state when session or search query changes
  useEffect(() => {
    const isSessionSwitch = prevSessionIdForScrollRef.current !== null && prevSessionIdForScrollRef.current !== session?.id
    prevSessionIdForScrollRef.current = session?.id ?? null

    // If session switched with search active, trigger scroll to first match
    if (isSessionSwitch && isSearchActive) {
      shouldScrollToMatchRef.current = true
    }

    setCurrentMatchIndex(0)
    setActiveMatch(null)
    revealRequestedRef.current.clear()
  }, [session?.id, searchQuery, isSearchActive])

  // ---------------------------------------------------------------------------
  // Where the query occurs — asked of the conversation, not of this window
  // ---------------------------------------------------------------------------
  //
  // A conversation opens with only its newest page, and search is the one
  // feature that must reach what the reader cannot see. So the matches come from
  // the server, over the whole history, as message ids; a hit that is not loaded
  // is opened when the reader navigates to it (see the turn-blocking effect
  // below, which runs once the turns are known).
  //
  // Counts therefore mean the same thing in a fully loaded conversation and in
  // one with a single page — one definition, on the server.
  const [searchMatches, setSearchMatches] = useState<SearchMatch[]>([])
  const [searchPending, setSearchPending] = useState(false)
  // The occurrence currently in view, for the highlight split. Set when
  // navigation lands on a hit; cleared when the query changes.
  const [activeMatch, setActiveMatch] = useState<{ turnKey: string; occurrence: number } | null>(null)
  // Hits whose page we already asked for, so a hit that cannot be opened (it was
  // deleted, or compacted away) is not requested again on every render.
  const revealRequestedRef = React.useRef<Set<string>>(new Set())

  // The conversation's questions, for the turn rail. Refetched when a new
  // question is asked, so the newest tick appears without a reload.
  const [questions, setQuestions] = useState<{ id: string; text: string }[]>([])
  const lastUserMessageId = React.useMemo(() => {
    const messages = session?.messages
    if (!messages) return null
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]
      if (message && message.role === 'user' && !message.isQueued) return message.id
    }
    return null
  }, [session?.messages])

  useEffect(() => {
    if (!onLoadQuestions || !session?.id) {
      setQuestions([])
      return
    }
    let cancelled = false
    onLoadQuestions()
      .then(list => { if (!cancelled) setQuestions(list) })
      .catch(error => { console.error("[rail] could not list the conversation's questions:", error) })
    return () => { cancelled = true }
  }, [onLoadQuestions, session?.id, lastUserMessageId])

  // Turns are computed further down (they need the whole message list). Search
  // needs them here — to know which hits are mounted, and which to open — so they
  // are read through a ref that is filled in during the same render, right after
  // they are computed.
  const turnsRef = React.useRef<{ allTurns: Turn[]; byMessageId: Map<string, number> }>({
    allTurns: NO_TURNS,
    byMessageId: new Map(),
  })

  /** Which mounted turn a hit belongs to, or null while that part is unloaded. */
  const turnKeyForMessage = React.useCallback((messageId: string, role: string): string | null => {
    if (role === 'user') return `user-${messageId}`
    if (role === 'error' || role === 'info' || role === 'warning') return `system-${messageId}`
    const { allTurns, byMessageId } = turnsRef.current
    const index = byMessageId.get(messageId)
    if (index == null) return null
    const turn = allTurns[index]
    return turn ? getTurnKey(turn) : null
  }, [])

  useEffect(() => {
    const query = searchQuery.trim()
    if (!isSearchActive || query.length === 0 || !onSearchMessages) {
      setSearchMatches([])
      setSearchPending(false)
      return
    }

    let cancelled = false
    setSearchPending(true)
    // Debounced: this runs on every keystroke of the search field.
    const timer = setTimeout(() => {
      onSearchMessages(query)
        .then(result => {
          if (cancelled) return
          const flat: SearchMatch[] = []
          for (const hit of result.hits) {
            for (let occurrence = 0; occurrence < hit.count; occurrence++) {
              if (flat.length >= MAX_SEARCH_MATCHES) break
              flat.push({
                matchId: `${hit.id}-${occurrence}`,
                messageId: hit.id,
                role: hit.role,
                occurrence,
              })
            }
            if (flat.length >= MAX_SEARCH_MATCHES) break
          }
          setSearchMatches(flat)
        })
        .catch(error => {
          console.error('[search] whole-history search failed:', error)
          if (!cancelled) setSearchMatches([])
        })
        .finally(() => {
          if (!cancelled) setSearchPending(false)
        })
    }, 140)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [isSearchActive, searchQuery, onSearchMessages, session?.id])

  // Search is driven by logical matches; there is no DOM verification step.
  const validMatches = searchMatches

  // Turns that contain a hit *and* are mounted. Computed per render rather than
  // memoized: it depends on which turns are loaded, which changes as pages
  // arrive, and the cost is a map lookup per hit.
  const matchingTurnIds: Set<string> = new Set()
  if (isSearchActive) {
    for (const match of validMatches) {
      const key = turnKeyForMessage(match.messageId, match.role)
      if (key) matchingTurnIds.add(key)
    }
  }

  const currentMatchTurnKey = (() => {
    const match = validMatches[currentMatchIndex]
    return match ? turnKeyForMessage(match.messageId, match.role) : null
  })()

  // Scroll to the current match — opening its part of the conversation first when
  // the hit is older than the loaded page.
  //
  // Only runs when navigation asked for it (`shouldScrollToMatchRef`): a session
  // switch with search active, the navigation buttons, or a single match.
  useEffect(() => {
    if (!shouldScrollToMatchRef.current) return

    const match = validMatches[currentMatchIndex]
    if (!match) return

    // Not in the transcript yet: ask for the page that contains it, and let this
    // effect run again when the messages land.
    if (!currentMatchTurnKey) {
      if (revealRequestedRef.current.has(match.messageId)) return
      revealRequestedRef.current.add(match.messageId)
      void onRevealMessage?.(match.messageId)
      return
    }

    // Loaded but outside the rendered window: widen it.
    const { allTurns } = turnsRef.current
    const turnIndex = allTurns.findIndex(turn => getTurnKey(turn) === currentMatchTurnKey)
    if (turnIndex >= 0) {
      const startIndex = Math.max(0, allTurns.length - visibleTurnCount)
      if (turnIndex < startIndex) {
        setVisibleTurnCount(allTurns.length - turnIndex + 5)
        return
      }
    }

    const turnEl = turnRefs.current.get(currentMatchTurnKey)
    if (turnEl) {
      const rect = turnEl.getBoundingClientRect()
      const buffer = 128
      const isVisible = rect.top >= buffer && rect.bottom <= window.innerHeight - buffer
      if (!isVisible) {
        turnEl.scrollIntoView({ behavior: 'instant', block: 'center' })
      }
      setActiveMatch({ turnKey: currentMatchTurnKey, occurrence: match.occurrence })
      shouldScrollToMatchRef.current = false
    }
  }, [
    validMatches,
    currentMatchIndex,
    currentMatchTurnKey,
    session?.messages,
    visibleTurnCount,
    onRevealMessage,
  ])

  // Auto-scroll to match ONLY when there's exactly one match
  // Multiple matches: user navigates with chevrons to avoid jarring scroll
  useEffect(() => {
    if (validMatches.length === 1 && isSearchActive) {
      shouldScrollToMatchRef.current = true
    }
  }, [validMatches.length, isSearchActive])

  // ---------------------------------------------------------------------------
  // CSS Custom Highlight API — non-destructive text highlighting
  // Creates browser-native highlight ranges over matching text without
  // modifying the DOM tree. Safe with React re-renders and streaming.
  // Uses cross-node matching: concatenates text across node boundaries
  // to find matches that span multiple DOM nodes (e.g. Shiki-split tokens).
  // ---------------------------------------------------------------------------

  const MAX_HIGHLIGHT_RANGES = 5000
  // Ranges per turn, so the active occurrence can be picked out by
  // (turn, occurrence index) — the same pair a search hit carries — without
  // re-walking the DOM when navigation moves.
  const highlightRangesRef = React.useRef<Map<string, Range[]>>(new Map())

  // Effect 1: Walk DOM and collect highlight ranges when search/session/pagination changes
  useEffect(() => {
    const cssHighlights = getCSSHighlights()
    highlightRangesRef.current = new Map()

    // Clear previous highlights
    try {
      cssHighlights?.delete('search-passive')
      cssHighlights?.delete('search-active')
    } catch { /* API unavailable — no-op */ }

    if (!searchQuery.trim() || !isSearchActive || !cssHighlights) return

    const query = searchQuery.toLowerCase()
    const matchingTurnIdSet = matchingTurnIds
    if (matchingTurnIdSet.size === 0) return

    const rafId = requestAnimationFrame(() => {
      const allRanges: Range[] = []
      const perTurn = new Map<string, Range[]>()

      turnRefs.current.forEach((container, turnKey) => {
        if (allRanges.length >= MAX_HIGHLIGHT_RANGES) return
        if (!matchingTurnIdSet.has(turnKey)) return

        // For assistant turns, narrow search to response content root
        const searchRoot = container.querySelector('[data-search-root="response"]') || container

        // Collect ALL eligible text nodes (no query filter — needed for cross-node matching)
        const walker = document.createTreeWalker(
          searchRoot,
          NodeFilter.SHOW_TEXT,
          {
            acceptNode: (node) => {
              const parent = node.parentElement
              if (!parent) return NodeFilter.FILTER_REJECT
              const tag = parent.tagName.toLowerCase()
              if (tag === 'script' || tag === 'style') return NodeFilter.FILTER_REJECT
              if (parent.closest('[data-search-exclude="true"]')) return NodeFilter.FILTER_REJECT
              return NodeFilter.FILTER_ACCEPT
            },
          }
        )

        // Build concatenated string with node offset mapping for cross-node matching
        const textNodes: Text[] = []
        let currentNode: Node | null
        while ((currentNode = walker.nextNode())) {
          textNodes.push(currentNode as Text)
        }
        if (textNodes.length === 0) return
        const turnRanges: Range[] = []

        const nodeOffsets: { node: Text; start: number; end: number }[] = []
        let totalLength = 0
        for (const node of textNodes) {
          const text = node.textContent || ''
          nodeOffsets.push({ node, start: totalLength, end: totalLength + text.length })
          totalLength += text.length
        }
        const concatenated = textNodes.map(n => n.textContent || '').join('')
        const lowerConcatenated = concatenated.toLowerCase()

        // Find all matches in the concatenated string
        let searchPos = 0
        while (searchPos < lowerConcatenated.length && allRanges.length < MAX_HIGHLIGHT_RANGES) {
          const idx = lowerConcatenated.indexOf(query, searchPos)
          if (idx === -1) break
          const matchEnd = idx + query.length

          // Create a Range spanning the match (may cross node boundaries)
          try {
            const range = new Range()
            let startSet = false

            for (const offset of nodeOffsets) {
              if (offset.end <= idx) continue
              if (offset.start >= matchEnd) break

              if (!startSet) {
                range.setStart(offset.node, idx - offset.start)
                startSet = true
              }
              range.setEnd(offset.node, Math.min(offset.end - offset.start, matchEnd - offset.start))
            }

            if (startSet) {
              allRanges.push(range)
              turnRanges.push(range)
            }
          } catch {
            // Range creation can fail if node was removed during walk
          }

          searchPos = matchEnd
        }

        if (turnRanges.length > 0) perTurn.set(turnKey, turnRanges)
      })

      // Store ranges for the active-match effect to use
      for (const [turnKey, ranges] of perTurn) {
        if (ranges.length > 0) highlightRangesRef.current.set(turnKey, ranges)
      }

      if (allRanges.length === 0 && matchingTurnIdSet.size > 0) {
        console.warn('[search-highlight] 0 ranges from', matchingTurnIdSet.size, 'matching turns — possible turn ID mismatch')
      }

      if (allRanges.length === 0) return

      try {
        // Apply all ranges as passive initially — the active-match effect will restyle
        cssHighlights.set('search-passive', new Highlight(...allRanges))
      } catch {
        // Highlight API call failed — degrade gracefully
      }
    })

    return () => cancelAnimationFrame(rafId)
    // Deps deliberately exclude `matchingTurnIds`: it is rebuilt every render, and
    // depending on it would re-walk the DOM on every token. The inputs it derives
    // from are here instead.
  }, [searchQuery, isSearchActive, searchMatches, turnKeyForMessage, session?.id, visibleTurnCount])

  // Effect 2: Update active/passive highlight split when navigation moves.
  // Lightweight — only reshuffles Range objects between the two Highlight instances.
  useEffect(() => {
    const cssHighlights = getCSSHighlights()
    const rangesByTurn = highlightRangesRef.current
    if (!cssHighlights || rangesByTurn.size === 0) return

    const allRanges: Range[] = []
    for (const ranges of rangesByTurn.values()) allRanges.push(...ranges)

    const activeRange = activeMatch
      ? rangesByTurn.get(activeMatch.turnKey)?.[activeMatch.occurrence]
      : undefined

    try {
      const passiveRanges = activeRange
        ? allRanges.filter(range => range !== activeRange)
        : allRanges
      if (passiveRanges.length > 0) cssHighlights.set('search-passive', new Highlight(...passiveRanges))
      else cssHighlights.delete('search-passive')
      if (activeRange) cssHighlights.set('search-active', new Highlight(activeRange))
      else cssHighlights.delete('search-active')
    } catch { /* graceful degradation */ }
  }, [activeMatch, searchMatches, visibleTurnCount])

  // Navigate to next match (no looping - stops at last match)
  const goToNextMatch = useCallback(() => {
    if (validMatches.length === 0) return
    setCurrentMatchIndex(prev => {
      // Don't loop - stop at last match
      if (prev >= validMatches.length - 1) return prev
      shouldScrollToMatchRef.current = true
      return prev + 1
    })
  }, [validMatches])

  // Navigate to previous match (no looping - stops at first match)
  const goToPrevMatch = useCallback(() => {
    if (validMatches.length === 0) return
    setCurrentMatchIndex(prev => {
      // Don't loop - stop at first match
      if (prev <= 0) return prev
      shouldScrollToMatchRef.current = true
      return prev - 1
    })
  }, [validMatches])

  // Highlighting itself is instant (CSS Highlight API); what can take a moment is
  // the query, which the server answers over the whole history.
  const isHighlighting = searchPending

  // Expose navigation via imperative handle (for session list navigation controls)
  React.useImperativeHandle(ref, () => ({
    goToNextMatch,
    goToPrevMatch,
    matchCount: validMatches.length,
    currentMatchIndex,
    isHighlighting,
  }), [goToNextMatch, goToPrevMatch, validMatches.length, currentMatchIndex])

  // Notify parent when match info (count, index, highlighting state) changes
  useEffect(() => {
    onMatchInfoChange?.({
      count: validMatches.length,
      index: currentMatchIndex,
      isHighlighting,
      sessionId: session?.id ?? null,
    })
  }, [validMatches.length, currentMatchIndex, isHighlighting, session?.id, onMatchInfoChange])

  // ============================================================================
  // Overlay State Management
  // ============================================================================

  // Overlay state - controls which overlay is shown (if any)
  const [overlayState, setOverlayState] = useState<ChatOverlayState>(null)

  // Diff viewer settings - loaded from user preferences on mount, persisted on change
  // These settings are stored in ~/.craft-agent/preferences.json (not localStorage)
  const [diffViewerSettings, setDiffViewerSettings] = useState<Partial<DiffViewerSettings>>({})

  // Load diff viewer settings from preferences on mount
  useEffect(() => {
    window.electronAPI.readPreferences().then(({ content }) => {
      try {
        const prefs = JSON.parse(content)
        if (prefs.diffViewer) {
          setDiffViewerSettings(prefs.diffViewer)
        }
      } catch {
        // Ignore parse errors, use defaults
      }
    })
  }, [])

  // Persist diff viewer settings to preferences when changed
  const handleDiffViewerSettingsChange = useCallback((settings: DiffViewerSettings) => {
    setDiffViewerSettings(settings)
    // Read current preferences, merge in new settings, write back
    window.electronAPI.readPreferences().then(({ content }) => {
      try {
        const prefs = JSON.parse(content)
        prefs.diffViewer = settings
        prefs.updatedAt = Date.now()
        window.electronAPI.writePreferences(JSON.stringify(prefs, null, 2))
      } catch {
        // If preferences malformed, create fresh with just diffViewer
        window.electronAPI.writePreferences(JSON.stringify({ diffViewer: settings, updatedAt: Date.now() }, null, 2))
      }
    })
  }, [])

  // Close overlay handler
  const handleCloseOverlay = useCallback(() => {
    setOverlayState(null)
  }, [])

  // Extract overlay cards for activity-based overlays (Input/Output, future extensible)
  const overlayCards = useMemo(() => {
    if (!overlayState || overlayState.type !== 'activity') return []
    return extractOverlayCards(overlayState.activity)
  }, [overlayState])

  // Parsed output data for legacy output-only activity overlays
  const activityOutputOverlayData = useMemo(() => {
    if (!overlayState || overlayState.type !== 'activity') return null
    return extractOverlayData(overlayState.activity)
  }, [overlayState])

  // Stacked input/output cards are only enabled for Bash and MCP tools
  const useStackedActivityOverlay = useMemo(() => {
    if (!overlayState || overlayState.type !== 'activity') return false
    return isStackedActivityTool(overlayState.activity)
  }, [overlayState])

  // Pop-out handler - opens message in overlay (read-only markdown)
  const handlePopOut = useCallback((message: Message) => {
    if (!session) return
    setOverlayState({
      type: 'markdown',
      content: message.content,
      title: 'Message Preview',
    })
  }, [session])

  // Ref to track total turn count for scroll handler
  const totalTurnCountRef = React.useRef(0)

  // Latest message metadata (for commit-time auto-scroll)
  const messageCount = session?.messages.length ?? 0
  const lastMessage = messageCount > 0 ? session?.messages[messageCount - 1] : undefined
  const lastMessageId = lastMessage?.id
  const lastMessageRole = lastMessage?.role

  const pendingFollowUpAnnotations = useMemo<PendingFollowUpAnnotation[]>(() => {
    if (!session?.messages?.length) return []

    const pending: PendingFollowUpAnnotation[] = []

    for (const message of session.messages) {
      if (message.role !== 'assistant' && message.role !== 'plan') continue
      if (!message.annotations?.length) continue

      for (const annotation of message.annotations) {
        const note = getAnnotationNoteText(annotation)
        if (!note) continue
        if (isAnnotationFollowUpSent(annotation)) continue

        pending.push({
          messageId: message.id,
          annotationId: annotation.id,
          note,
          selectedText: extractAnnotationSelectedText(annotation, message.content),
          createdAt: annotation.updatedAt ?? annotation.createdAt,
          color: annotation.style?.color,
          meta: asRecord(annotation.meta) ?? undefined,
        })
      }
    }

    return pending.sort((a, b) => a.createdAt - b.createdAt)
  }, [session?.messages])

  const followUpInputItems = useMemo(() => {
    return pendingFollowUpAnnotations.map((followUp, idx) => ({
      id: `${followUp.messageId}:${followUp.annotationId}`,
      messageId: followUp.messageId,
      annotationId: followUp.annotationId,
      index: idx + 1,
      noteLabel: normalizeFollowUpText(followUp.note),
      selectedText: truncateForChipTooltip(followUp.selectedText, 260),
      color: followUp.color,
    }))
  }, [pendingFollowUpAnnotations])

  // Scroll the conversation to its newest turn. Resolving the viewport here
  // (rather than scrolling an end anchor into view) keeps the movement inside
  // the conversation.
  //
  // It does not touch the sticky-bottom flag: some callers follow content by
  // policy (an unfocused panel), and forcing the flag there would drag a reader
  // who had scrolled up the moment that panel regains focus.
  const scrollToBottom = React.useCallback((behavior: ScrollBehavior = 'smooth') => {
    const viewport = scrollViewportRef.current
    if (!viewport) return
    setIsAtBottom(true)
    viewport.scrollTo({ top: viewport.scrollHeight, behavior })
  }, [])

  // Follow the newest content, choosing how to get there by how far away it is.
  //
  // Everything that resolves its height after the panel has painted arrives
  // here: syntax highlighting for every code block at once, images, diagrams,
  // preview blocks, and the reverse-pagination window mounting its turns. When
  // that shift is thousands of pixels, animating it is the difference between
  // "the conversation opened at its end" and "the conversation scrolled itself
  // through its entire history" — so a jump longer than the viewport is
  // instant, and only content close enough to watch is animated.
  const followToBottom = React.useCallback(() => {
    const viewport = scrollViewportRef.current
    if (!viewport) return
    const behavior = chooseFollowBehavior({
      distance: viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight,
      viewportHeight: viewport.clientHeight,
      now: Date.now(),
      quietUntil: skipSmoothScrollUntilRef.current,
    })
    scrollToBottom(behavior)
  }, [scrollToBottom])

  // The reader asking to be taken back to the newest message: that is a request
  // to follow the conversation again, not just a one-off jump.
  const handleJumpToLatest = React.useCallback(() => {
    isStickToBottomRef.current = true
    scrollToBottom('smooth')
  }, [scrollToBottom])

  /**
   * Ask for the page of messages before the oldest one this client holds.
   *
   * The conversation grows *upwards*: the new messages land above what the
   * reader is looking at. So this widens the turn window by the number that
   * arrived — the window only ever slices from the end, and older turns are
   * exactly what just became available — and flags the coming commit, which the
   * layout effect below uses to hold the reader's place.
   */
  const loadOlderPage = React.useCallback(async () => {
    const load = loadOlderMessagesRef.current
    if (!load || loadingOlderRef.current || !messagesTruncatedRef.current) return

    loadingOlderRef.current = true
    try {
      const added = await load()
      if (added > 0) {
        // The messages are already in the atom; this commit is the one that must
        // not move the reader.
        prependPendingRef.current = true
        setVisibleTurnCount(previous => previous + added)
      }
    } finally {
      loadingOlderRef.current = false
    }
  }, [])

  // Hold the reader's place across a prepend, and only across a prepend: the
  // height delta is measured from the previous commit, so content that grew at
  // the bottom in the meantime is not counted.
  React.useLayoutEffect(() => {
    const viewport = scrollViewportRef.current
    if (!viewport) return
    const previousHeight = lastContentHeightRef.current
    lastContentHeightRef.current = viewport.scrollHeight
    if (!prependPendingRef.current) return
    prependPendingRef.current = false
    // No baseline yet (first commit of a session) — there is nothing to hold.
    if (previousHeight <= 0) return
    viewport.scrollTop += viewport.scrollHeight - previousHeight
  }, [session?.messages])

  // A page can be shorter than the screen (a few huge turns, a tall viewport).
  // Without this the reader would have nothing to scroll, so no scroll event,
  // and the older half of the conversation would be unreachable.
  React.useLayoutEffect(() => {
    if (!session?.messagesTruncated) return
    const viewport = scrollViewportRef.current
    if (!viewport) return
    if (viewport.scrollHeight > viewport.clientHeight + 24) return
    void loadOlderPage()
  }, [session?.id, session?.messagesTruncated, session?.messages.length, loadOlderPage])

  // Track scroll position to toggle sticky-bottom behavior
  // - User scrolls up → unstick (stop auto-scrolling)
  // - User scrolls back to bottom → re-stick (resume auto-scrolling)
  // Also handles loading more when scrolling near top
  const handleScroll = React.useCallback(() => {
    const viewport = scrollViewportRef.current
    if (!viewport) return
    const { scrollTop, scrollHeight, clientHeight } = viewport
    // One judgement drives both behaviours: while the reader is at the bottom
    // new content follows them; the moment they leave it, following stops and
    // the way back down appears.
    const atBottom = isScrolledToBottom({ scrollTop, scrollHeight, clientHeight })
    isStickToBottomRef.current = atBottom
    setIsAtBottom((previous) => (previous === atBottom ? previous : atBottom))

    // Load more when scrolling near the top (within 100px). Two kinds of "more
    // above": turns this client already holds, and — once those are all
    // showing — a page of messages it has never carried.
    if (scrollTop < 100) {
      if (totalTurnCountRef.current - visibleTurnCountRef.current > 0) {
        setVisibleTurnCount(prev => {
          // Already showing everything loaded.
          const currentStartIndex = Math.max(0, totalTurnCountRef.current - prev)
          if (currentStartIndex <= 0) return prev

          // Remember scroll height before adding more items
          const prevScrollHeight = viewport.scrollHeight

          // Schedule scroll position adjustment after render
          requestAnimationFrame(() => {
            const newScrollHeight = viewport.scrollHeight
            viewport.scrollTop = newScrollHeight - prevScrollHeight + scrollTop
          })

          return prev + TURNS_PER_PAGE
        })
        return
      }
      void loadOlderPage()
    }
  }, [loadOlderPage])

  // Set up scroll event listener
  React.useEffect(() => {
    const viewport = scrollViewportRef.current
    if (!viewport) return
    viewport.addEventListener('scroll', handleScroll)
    return () => viewport.removeEventListener('scroll', handleScroll)
  }, [handleScroll])

  // Auto-scroll using ResizeObserver for streaming content
  // Initial scroll is handled by PinToBottomOnMount (useLayoutEffect, before paint)
  React.useEffect(() => {
    const viewport = scrollViewportRef.current
    if (!viewport) return

    const isSessionSwitch = prevSessionIdRef.current !== session?.id
    prevSessionIdRef.current = session?.id ?? null

    // On session switch: reset UI state (scroll handled by PinToBottomOnMount)
    if (isSessionSwitch) {
      isStickToBottomRef.current = true
      setIsAtBottom(true)
      setVisibleTurnCount(TURNS_PER_PAGE)
    }

    // Debounced scroll for streaming - waits for layout to settle
    let debounceTimer: ReturnType<typeof setTimeout> | null = null

    const resizeObserver = new ResizeObserver(() => {
      // Unfocused panels: always scroll to bottom instantly (user isn't reading them)
      if (!isFocusedPanelRef.current) {
        scrollToBottom('instant')
        return
      }

      // Focused panel: respect sticky-bottom preference
      if (!isStickToBottomRef.current) return

      // A shift longer than a screen is the transcript arriving (turns mounting,
      // a wall of highlighting, images resolving), not the last message growing
      // a line. Settling that through the debounce below would leave the reader
      // looking at the top of a conversation that is about to jump somewhere a
      // screen away — so go now; only small increments are worth settling.
      const distance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
      if (isRelocation(distance, viewport.clientHeight)) {
        followToBottom()
        return
      }

      // Clear pending scroll and wait for layout to settle
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        // The quiet window after an instant pin is about the *animation*, never
        // about the scroll: content that resolves its height in that window
        // (code highlighting, images, preview and diagram blocks) still has to
        // be followed, and an instant re-pin is exactly what it needs. Skipping
        // the scroll here is what used to leave a freshly opened conversation
        // parked near its first message.
        followToBottom()
      }, 200)
    })

    // Observe the scroll content container (first child of viewport)
    const content = viewport.firstElementChild
    if (content) {
      resizeObserver.observe(content)
    }

    return () => {
      resizeObserver.disconnect()
      if (debounceTimer) clearTimeout(debounceTimer)
    }
  }, [session?.id, scrollToBottom, followToBottom])

  // Commit-time auto-scroll for new user messages.
  // This complements submit-time scrolling and covers cases where attachments delay
  // optimistic message insertion (e.g., thumbnail generation/resizing).
  React.useEffect(() => {
    const currentSessionId = session?.id ?? null

    // Reset baseline on session switch; defer to PinToBottomOnMount/session-switch logic.
    if (prevSessionIdForCommitScrollRef.current !== currentSessionId) {
      prevSessionIdForCommitScrollRef.current = currentSessionId
      prevLastMessageIdRef.current = lastMessageId ?? null
      prevMessageCountRef.current = messageCount
      return
    }

    const previousCount = prevMessageCountRef.current
    const previousLastId = prevLastMessageIdRef.current
    const messageActuallyChanged = !!lastMessageId && lastMessageId !== previousLastId
    const countIncreased = messageCount > previousCount

    // Update baselines before early returns to keep refs consistent.
    prevLastMessageIdRef.current = lastMessageId ?? null
    prevMessageCountRef.current = messageCount

    if (!messageActuallyChanged || !countIncreased) return
    if (lastMessageRole !== 'user') return

    // Sending a message should always re-stick to bottom.
    isStickToBottomRef.current = true

    requestAnimationFrame(() => {
      scrollToBottom(isFocusedPanelRef.current ? 'smooth' : 'instant')
    })
  }, [session?.id, messageCount, lastMessageId, lastMessageRole, scrollToBottom])

  // Handle message submission from InputContainer
  // Backend handles interruption and queueing if currently processing
  const handleSubmit = (message: string, attachments?: FileAttachment[], skillSlugs?: string[]) => {
    const hasBaseMessage = message.trim().length > 0
    const followUpSection = formatFollowUpSection(pendingFollowUpAnnotations, {
      includeTopSeparator: hasBaseMessage,
    })
    const messageWithFollowUps = followUpSection.length > 0
      ? (hasBaseMessage ? `${message}\n\n${followUpSection}` : followUpSection)
      : message
    const normalizedMessage = normalizeFollowUpsMarkdown(messageWithFollowUps)

    // Force stick-to-bottom when user sends a message
    isStickToBottomRef.current = true
    onSendMessage(normalizedMessage, attachments, skillSlugs, replyTo ?? undefined)
    setReplyTo(null)

    // Persist sent marker on follow-up annotations so TurnCard can distinguish
    // sent vs pending follow-ups. If user edits a follow-up later, TurnCard
    // clears these markers and the annotation becomes pending again.
    if (session && pendingFollowUpAnnotations.length > 0) {
      const sentAt = Date.now()
      void Promise.all(pendingFollowUpAnnotations.map((followUp) => {
        const currentMeta = followUp.meta ?? {}
        const currentFollowUpMeta = asRecord(currentMeta.followUp) ?? {}

        return window.electronAPI.sessionCommand(session.id, {
          type: 'updateAnnotation',
          messageId: followUp.messageId,
          annotationId: followUp.annotationId,
          patch: {
            meta: {
              ...currentMeta,
              followUp: {
                ...currentFollowUpMeta,
                text: followUp.note,
                lastSentAt: sentAt,
                lastSentText: followUp.note,
              },
            },
          },
        })
      })).catch((error) => {
        console.error('[ChatDisplay] Failed to mark follow-up annotations as sent:', error)
      })
    }

    // Immediately scroll to bottom after sending - use requestAnimationFrame
    // to ensure the DOM has updated with the new message
    requestAnimationFrame(() => {
      scrollToBottom('smooth')
    })
  }

  const handleSaveAndSendFollowUp = useCallback((_target: {
    messageId: string
    annotationId: string
    note: string
    selectedText: string
  }) => {
    const live = liveSessionRef.current
    if (!live) return

    if (isInputDisabled || disableSend || connectionUnavailable) {
      toast.error(t('toast.cannotSendRightNow'), {
        description: 'Sending is currently disabled for this session.',
      })
      return
    }

    // Mimic pressing Send in the input after Save completes.
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('craft:submit-input', {
        detail: { sessionId: live.id },
      }))
    }, 0)
  }, [t, isInputDisabled, disableSend, connectionUnavailable])

  // Handle stop request from InputContainer
  // silent=true when redirecting (sending new message), silent=false when user clicks Stop button
  const handleStop = (silent = false) => {
    if (!session?.isProcessing) return

    // Explicit Stop (not a redirect/new-message send): put the in-flight prompt
    // back in the input so the user can tweak and resend. Append to any draft.
    // Exclude isQueued messages — those are restored separately by the backend
    // `restore_input` effect (App.tsx) and would otherwise double up here.
    if (!silent) {
      const lastUserMsg = [...session.messages].reverse().find(m => m.role === 'user' && !m.isQueued)
      const restoredText = coerceInputText(lastUserMsg?.content)
      if (restoredText) {
        onInputChange?.(appendRestoredInput(inputValue, restoredText))
      }
    }

    window.electronAPI.cancelProcessing(session.id, silent).catch(error => {
      console.error('[ChatDisplay] Failed to cancel processing:', error)
    })
  }

  // What the person is answering, if they picked a message. The strip above the composer is the
  // whole of the state: clear it and the message sends as an ordinary one.
  const [replyTo, setReplyTo] = React.useState<MessageReply | null>(null)

  const startReply = React.useCallback((message: Pick<Message, 'id' | 'role' | 'content'>) => {
    const excerpt = message.content.trim().replace(/\s+/g, ' ')
    setReplyTo({
      messageId: message.id,
      role: message.role,
      excerpt: excerpt.length > 180 ? `${excerpt.slice(0, 180)}…` : excerpt,
    })
  }, [])

  /**
   * Bring a quoted message back into view.
   *
   * It may be outside what this panel carries at all (a conversation opens on
   * its newest page), or outside the rendered window — so a miss is not the end
   * of the story: open the page that holds it, widen the window to everything
   * now loaded, and try again over the next frames. Silent when the message
   * genuinely no longer exists.
   */
  const jumpToMessage = React.useCallback(async (messageId: string) => {
    const find = () => document.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`)
    const scrollTo = (): boolean => {
      const element = find()
      if (!element) return false
      element.scrollIntoView({ behavior: 'smooth', block: 'center' })
      return true
    }

    if (scrollTo()) return
    if (!onRevealMessage) return

    const revealed = await onRevealMessage(messageId)
    if (!revealed) return

    // Show everything that is loaded: the revealed turn is older than the
    // window's start, so widening is what makes it renderable at all.
    setVisibleTurnCount(Number.MAX_SAFE_INTEGER)
    // The commit that mounts the revealed turn comes after this promise, and
    // measured heights settle a beat later — so try over a short window.
    const startedAt = performance.now()
    const attempt = () => {
      if (scrollTo()) return
      if (performance.now() - startedAt > 1200) return
      requestAnimationFrame(attempt)
    }
    requestAnimationFrame(attempt)
  }, [onRevealMessage])

  // ---------------------------------------------------------------------------
  // Handlers a turn card receives
  // ---------------------------------------------------------------------------
  //
  // Every one of these has to keep its identity across renders: the transcript
  // streams tens of tokens a second and each turn card is memoized, so a handler
  // that is rebuilt per render silently turns the memo off for the whole
  // conversation. They therefore read the live session through a ref rather than
  // closing over it — the session object is replaced on every token, so a
  // closure over it would be a new function every time.
  /** Branch a conversation from one of its own messages, into a new panel. */
  const handleBranch = React.useCallback(async (messageId: string, options?: { newPanel?: boolean }) => {
    const live = liveSessionRef.current
    const onCreateSession = liveShellRef.current?.onCreateSession
    if (!live || !onCreateSession) return
    try {
      const child = await onCreateSession(live.workspaceId, {
        branchFromMessageId: messageId,
        branchFromSessionId: live.id,
        name: `Branch of ${live.name || 'Untitled'}`,
        // Keep branch on the same backend/provider by inheriting parent session settings.
        llmConnection: live.llmConnection,
        model: live.model,
        permissionMode: live.permissionMode,
        workingDirectory: live.workingDirectory,
        enabledSourceSlugs: live.enabledSourceSlugs,
      })
      navigate(routes.view.allSessions(child.id), { newPanel: resolveBranchNewPanelOption(options) })
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : 'Failed to create branch'
      const message = rawMessage.includes('source and target providers must match')
        || rawMessage.includes('same provider/backend')
        ? 'Branching is only supported within the same provider/backend. Switch this panel connection and try again.'
        : rawMessage
      toast.error(t('toast.couldNotCreateBranch'), { description: message })
    }
  }, [t, navigate])

  const handleAddAnnotation = React.useCallback(async (messageId: string, annotation: AnnotationV1) => {
    const live = liveSessionRef.current
    if (!live) return
    try {
      await window.electronAPI.sessionCommand(live.id, { type: 'addAnnotation', messageId, annotation })
    } catch (error) {
      toast.error(t('toast.couldNotSaveHighlight'), {
        description: error instanceof Error ? error.message : 'Unknown error',
      })
      throw error
    }
  }, [t])

  const handleRemoveAnnotation = React.useCallback(async (messageId: string, annotationId: string) => {
    const live = liveSessionRef.current
    if (!live) return
    try {
      await window.electronAPI.sessionCommand(live.id, { type: 'removeAnnotation', messageId, annotationId })
    } catch (error) {
      toast.error(t('toast.couldNotRemoveHighlight'), {
        description: error instanceof Error ? error.message : 'Unknown error',
      })
      throw error
    }
  }, [t])

  const handleUpdateAnnotation = React.useCallback(async (
    messageId: string,
    annotationId: string,
    patch: Partial<AnnotationV1>,
  ) => {
    const live = liveSessionRef.current
    if (!live) return
    try {
      await window.electronAPI.sessionCommand(live.id, { type: 'updateAnnotation', messageId, annotationId, patch })
    } catch (error) {
      toast.error(t('toast.couldNotUpdateHighlight'), {
        description: error instanceof Error ? error.message : 'Unknown error',
      })
      throw error
    }
  }, [t])

  /** Approve the conversation's latest plan (optionally compacting first). */
  const approvePlan = React.useCallback((eventName: 'craft:approve-plan' | 'craft:approve-plan-with-compact') => {
    const live = liveSessionRef.current
    if (!live) return
    const planMessage = live.messages.findLast(m => m.role === 'plan')
    window.dispatchEvent(new CustomEvent(eventName, {
      detail: {
        sessionId: live.id,
        planPath: planMessage?.planPath,
        includeDraftInput: true,
        source: 'plan-card',
      },
    }))
  }, [])

  const handleAcceptPlan = React.useCallback(() => approvePlan('craft:approve-plan'), [approvePlan])
  const handleAcceptPlanWithCompact = React.useCallback(
    () => approvePlan('craft:approve-plan-with-compact'),
    [approvePlan],
  )

  /** Turn details / a response preview: raw markdown, read-only. */
  const openMarkdownOverlay = React.useCallback((text: string) => {
    setOverlayState({ type: 'markdown', content: text, title: 'Response Preview', forceCodeView: true })
  }, [])

  // Queued messages are not transcript turns — they wait in the composer tray.
  //
  // Split by who wrote them (see `splitQueued`), because the tray is the person's own unsent text:
  // hidden nudges never render, and a message from another conversation is readable but not
  // editable into the person's words.
  const queued = React.useMemo(
    () => splitQueued(session?.messages ?? []),
    [session?.messages]
  )
  const queuedMessages = queued.mine

  // Queued messages live in the composer tray until their turn starts. Removing an incoming one
  // uses the same path: the point is that it must leave the queue without ever becoming the
  // person's draft.
  const handleRemoveQueuedMessage = React.useCallback((message: Message) => {
    const sessionId = session?.id
    if (!sessionId) return

    window.electronAPI.cancelQueuedMessage(sessionId, message.id, message.content).then(result => {
      if (!result?.cancelled) toast.error(t('chat.queuedRemoveFailed'))
    }).catch(error => {
      console.error('[ChatDisplay] Failed to cancel queued message:', error)
      toast.error(t('chat.queuedRemoveFailed'))
    })
  }, [session?.id, t])

  // Take the message out of the queue and put its text in the composer so it
  // can be rewritten before sending. Attachments stay with the removed entry.
  const handleEditQueuedMessage = React.useCallback((message: Message) => {
    const sessionId = session?.id
    if (!sessionId) return

    window.electronAPI.cancelQueuedMessage(sessionId, message.id, message.content).then(result => {
      if (!result?.cancelled) {
        toast.error(t('chat.queuedRemoveFailed'))
        return
      }
      onInputChange?.(coerceInputText(message.content))
      dispatchFocusInputEvent({ sessionId })
    }).catch(error => {
      console.error('[ChatDisplay] Failed to edit queued message:', error)
    })
  }, [session?.id, onInputChange, t])

  // "Send now" is Stop + Send: the running turn is interrupted and this message
  // starts the next one. It stays in the tray until the replay clears its flag.
  const handleSendQueuedMessageNow = React.useCallback((message: Message) => {
    const sessionId = session?.id
    if (!sessionId) return

    window.electronAPI.sendQueuedMessageNow(sessionId, message.id).then(result => {
      if (!result?.sent) {
        toast.error(t('chat.queuedSendNowFailed'))
      }
    }).catch(error => {
      console.error('[ChatDisplay] Failed to send queued message now:', error)
      toast.error(t('chat.queuedSendNowFailed'))
    })
  }, [session?.id, t])

  // Drag-to-reorder identifies the entry by id: the queue keeps draining while
  // the pointer is down, so indices can shift (or the entry can start sending).
  const handleReorderQueuedMessage = React.useCallback((messageId: string, toIndex: number) => {
    const sessionId = session?.id
    if (!sessionId) return

    window.electronAPI.sessionCommand(sessionId, {
      type: 'reorderQueuedMessage',
      messageId,
      toIndex,
    }).then(result => {
      // The entry can be replayed between the drop and the backend call.
      if (result && 'reordered' in result && !result.reordered) {
        toast.info(t('chat.queuedReorderExpired'))
      }
    }).catch(error => {
      console.error('[ChatDisplay] Failed to reorder queued messages:', error)
      toast.error(t('chat.queuedReorderFailed'))
    })
  }, [session?.id, t])

  const handleReorderQueuedExpired = React.useCallback(() => {
    toast.info(t('chat.queuedReorderExpired'))
  }, [t])

  // Per-frame scroll compensation during input height animation
  // Only compensate when user is "stuck to bottom" - otherwise let them control their scroll position
  const handleAnimatedHeightChange = React.useCallback((delta: number) => {
    if (!isStickToBottomRef.current) return
    const viewport = scrollViewportRef.current
    if (!viewport) return
    // Adjust scroll to maintain position relative to content
    viewport.scrollTop += delta
  }, [])

  // Handle structured input responses (permissions and credentials)
  const handleStructuredResponse = (response: StructuredResponse) => {
    if ((response.type === 'permission' || response.type === 'admin_approval') && pendingPermission && onRespondToPermission) {
      if (response.type === 'permission') {
        const permResponse = response as PermissionResponse
        onRespondToPermission(
          pendingPermission.sessionId,
          pendingPermission.requestId,
          permResponse.allowed,
          permResponse.alwaysAllow
        )
        return
      }

      const adminResponse = response as AdminApprovalResponse
      onRespondToPermission(
        pendingPermission.sessionId,
        pendingPermission.requestId,
        adminResponse.approved,
        false,
        { rememberForMinutes: adminResponse.rememberForMinutes }
      )
    } else if (response.type === 'credential' && pendingCredential && onRespondToCredential) {
      const credResponse = response as CredentialResponse
      onRespondToCredential(
        pendingCredential.sessionId,
        pendingCredential.requestId,
        credResponse
      )
    }
  }

  // Build structured input state from pending requests (permissions take priority)
  const structuredInput: StructuredInputState | undefined = React.useMemo(() => {
    if (pendingPermission) {
      if (pendingPermission.type === 'admin_approval') {
        return {
          type: 'admin_approval',
          data: {
            appName: pendingPermission.appName || pendingPermission.toolName || 'System action',
            reason: pendingPermission.reason || pendingPermission.description,
            impact: pendingPermission.impact,
            command: pendingPermission.command || '',
            requiresSystemPrompt: pendingPermission.requiresSystemPrompt ?? true,
            rememberForMinutes: pendingPermission.rememberForMinutes ?? 10,
          },
        }
      }
      return { type: 'permission', data: pendingPermission }
    }
    if (pendingCredential) {
      return { type: 'credential', data: pendingCredential }
    }
    return undefined
  }, [pendingPermission, pendingCredential])

  // Turn grouping, with its previous result kept.
  //
  // Grouping itself is cheap; the reason it is cached is *identity*. A streamed
  // token replaces the messages array, and rebuilding every turn object would
  // hand every turn card in the transcript a new prop — which is how one delta
  // used to re-render the whole visible conversation. With the cache, only the
  // turn whose messages actually changed is a new object.
  const groupingRef = React.useRef<{ sessionId: string | null; grouping: TurnGrouping | null }>({
    sessionId: null,
    grouping: null,
  })
  const allTurns = React.useMemo(() => {
    if (!session) return NO_TURNS
    const previous = groupingRef.current.sessionId === session.id ? groupingRef.current.grouping : null
    const grouping = groupMessagesByTurnCached(session.messages, previous, {
      isSessionProcessing: session.isProcessing,
    })
    groupingRef.current = { sessionId: session.id, grouping }
    return grouping.turns
  }, [session?.id, session?.messages, session?.isProcessing])

  // Keep ref in sync for scroll handler
  totalTurnCountRef.current = allTurns.length

  // Reverse pagination: only render last N turns for fast initial render
  const startIndex = Math.max(0, allTurns.length - visibleTurnCount)
  const turns = allTurns.slice(startIndex)
  // "More above" is two facts now: turns held but not shown, and messages never
  // carried at all (`messagesTruncated`). The hint counts whichever applies.
  const unloadedMessageCount = session?.messagesTruncated
    ? Math.max(0, (session.messageCount ?? 0) - session.messages.length)
    : 0
  const hasMoreAbove = startIndex > 0 || unloadedMessageCount > 0

  const assistantTurnIndexByMessageId = useMemo(() => {
    const map = new Map<string, number>()
    allTurns.forEach((turn, index) => {
      if (turn.type !== 'assistant') return
      const messageId = turn.response?.messageId
      if (messageId) map.set(messageId, index)
    })
    return map
  }, [allTurns])

  // Search reads the turns through this ref (see `turnKeyForMessage`): the search
  // section sits above these computations, and the turns change as pages arrive.
  turnsRef.current = { allTurns, byMessageId: assistantTurnIndexByMessageId }

  // Bring a turn into view, widening the reverse-pagination window first when the
  // target is older than what is currently mounted.
  // `align: 'start'` reveals the turn's opening (used by the turn rail, whose turns
  // are usually taller than the viewport); 'center' keeps the existing annotation
  // and search behavior.
  const scrollToTurnByIndex = useCallback((targetTurnIndex: number, align: 'center' | 'start' = 'center') => {
    const targetTurn = allTurns[targetTurnIndex]
    if (!targetTurn) return

    const turnKey = getTurnKey(targetTurn)
    const ensureVisibleCount = allTurns.length - targetTurnIndex

    const scrollToTurn = () => {
      const turnContainer = turnRefs.current.get(turnKey)
      if (!turnContainer) return false

      if (align === 'center') {
        turnContainer.scrollIntoView({ behavior: 'smooth', block: 'center' })
        return true
      }

      const viewport = scrollViewportRef.current
      if (!viewport) return false
      const delta = turnContainer.getBoundingClientRect().top
        - viewport.getBoundingClientRect().top
        - LOCATED_TURN_TOP_GAP
      viewport.scrollTo({ top: viewport.scrollTop + delta, behavior: 'smooth' })
      return true
    }

    if (ensureVisibleCount > visibleTurnCount) {
      setVisibleTurnCount(ensureVisibleCount)
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!scrollToTurn()) {
            setTimeout(() => {
              void scrollToTurn()
            }, 80)
          }
        })
      })
      return
    }

    if (!scrollToTurn()) {
      requestAnimationFrame(() => {
        void scrollToTurn()
      })
    }
  }, [allTurns, visibleTurnCount])

  const scrollToFollowUpTurn = useCallback((item: {
    messageId: string
    annotationId: string
  }) => {
    const targetTurnIndex = assistantTurnIndexByMessageId.get(item.messageId)
    if (targetTurnIndex == null) return
    scrollToTurnByIndex(targetTurnIndex)
  }, [assistantTurnIndexByMessageId, scrollToTurnByIndex])

  const handleFollowUpChipClick = useCallback((item: {
    messageId: string
    annotationId: string
  }, anchor?: { x: number; y: number }) => {
    const targetTurnIndex = assistantTurnIndexByMessageId.get(item.messageId)
    if (targetTurnIndex != null) {
      const ensureVisibleCount = allTurns.length - targetTurnIndex
      if (ensureVisibleCount > visibleTurnCount) {
        setVisibleTurnCount(ensureVisibleCount)
      }
    }

    followUpOpenNonceRef.current += 1
    setOpenAnnotationRequest({
      messageId: item.messageId,
      annotationId: item.annotationId,
      mode: 'view',
      anchorX: anchor?.x,
      anchorY: anchor?.y,
      nonce: followUpOpenNonceRef.current,
    })
  }, [assistantTurnIndexByMessageId, allTurns, visibleTurnCount])

  const handleFollowUpIndexClick = useCallback((item: {
    messageId: string
    annotationId: string
  }) => {
    scrollToFollowUpTurn(item)
  }, [scrollToFollowUpTurn])

  // --- Turn rail -----------------------------------------------------------
  // Ticks every question in the conversation — including the ones this panel has
  // never loaded. Paging made that the whole point: a rail built from the mounted
  // turns would tick only the questions inside the current page and silently
  // claim the conversation began there (and its older ticks would jump nowhere).
  //
  // The list therefore comes from the conversation itself (`onLoadQuestions`);
  // the mounted turns remain the fallback for callers that have no such source.
  const railItems = useMemo(
    () => (questions.length > 0
      ? buildTurnRailItemsFromQuestions(questions)
      : buildTurnRailItems(allTurns, getTurnKey)),
    [questions, allTurns],
  )
  const railKeys = useMemo(() => new Set(railItems.map((item) => item.key)), [railItems])

  const [activeTurnKey, setActiveTurnKey] = React.useState<string | null>(null)

  // Reading position: the last turn whose top has passed the viewport's anchor
  // line. Recomputed on scroll and whenever the mounted window changes.
  React.useEffect(() => {
    const viewport = scrollViewportRef.current
    if (!viewport) return

    let frame = 0
    const measure = () => {
      frame = 0
      const anchorY = viewport.getBoundingClientRect().top + 80
      let bestKey: string | null = null
      let bestTop = -Infinity
      turnRefs.current.forEach((element, key) => {
        // Only ticks are candidates — anchoring on an assistant turn would leave
        // the rail with nothing highlighted while its question is what you read.
        if (!railKeys.has(key)) return
        const top = element.getBoundingClientRect().top
        if (top <= anchorY && top > bestTop) {
          bestTop = top
          bestKey = key
        }
      })
      setActiveTurnKey((previous) => (previous === bestKey ? previous : bestKey))
    }
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(measure)
    }

    measure()
    viewport.addEventListener('scroll', schedule, { passive: true })
    return () => {
      viewport.removeEventListener('scroll', schedule)
      if (frame !== 0) cancelAnimationFrame(frame)
    }
  }, [session?.id, turns.length, visibleTurnCount, railKeys])

  // A tick whose question is not loaded asks for its page first, then jumps:
  // `pendingRailKeyRef` is read by the effect below once the turns include it.
  const pendingRailKeyRef = React.useRef<string | null>(null)

  const handleRailSelect = useCallback((key: string) => {
    const index = allTurns.findIndex((turn) => getTurnKey(turn) === key)
    if (index >= 0) {
      scrollToTurnByIndex(index, 'start')
      return
    }
    if (!key.startsWith('user-') || !onRevealMessage) return
    pendingRailKeyRef.current = key
    void onRevealMessage(key.slice('user-'.length))
  }, [allTurns, scrollToTurnByIndex, onRevealMessage])

  React.useEffect(() => {
    const key = pendingRailKeyRef.current
    if (!key) return
    const index = allTurns.findIndex((turn) => getTurnKey(turn) === key)
    if (index < 0) return
    pendingRailKeyRef.current = null
    scrollToTurnByIndex(index, 'start')
  }, [allTurns, scrollToTurnByIndex])

  // The rail is the desktop navigation column; the return-to-bottom button
  // lives at its foot. A conversation with under two ticks has no rail, and the
  // button then floats over the messages like it does on mobile.
  const showTurnRail = !compactMode && railItems.length >= 2

  // Compute if we should skip scroll-to-bottom (when search is active on session switch)
  // At render time, prevSessionIdForScrollRef still has the OLD session ID, so we can detect the switch
  const isSessionSwitchForScroll = prevSessionIdForScrollRef.current !== null && prevSessionIdForScrollRef.current !== session?.id
  const skipScrollToBottom = isSessionSwitchForScroll && isSearchActive
  const hasUnrenderedLoadedMessages = !messagesLoading
    && turns.length === 0
    && ((session?.messages?.length ?? 0) > 0 || (session?.messageCount ?? 0) > 0)

  return (
    <div ref={zoneRef} className="flex h-full flex-col min-w-0" data-focus-zone="chat">
      {session ? (
        <div className="flex flex-1 flex-col min-h-0 min-w-0 relative">
          {/* Content layer */}
          <div className="flex flex-1 flex-col min-h-0 min-w-0 relative z-10">
          {/* === MESSAGES AREA: Scrollable list of message bubbles === */}
          {/* The turn rail is a sibling column, not an overlay: it reserves its own
              width instead of sitting on top of the conversation. */}
          <div className="flex flex-1 min-h-0 min-w-0">
          <div className="relative flex-1 min-h-0 min-w-0">
            {/* Mask wrapper - fades content at top and bottom over transparent/image backgrounds */}
            <div
              className="h-full"
              style={{
                maskImage: 'linear-gradient(to bottom, transparent 0%, black 32px, black calc(100% - 32px), transparent 100%)',
                WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, black 32px, black calc(100% - 32px), transparent 100%)'
              }}
            >
              <ScrollArea className="h-full min-w-0" viewportRef={scrollViewportRef}>
              <div className={cn(
                CHAT_LAYOUT.maxWidth,
                "mx-auto min-w-0",
                compactMode ? "px-3 py-4 space-y-2" : [CHAT_LAYOUT.containerPadding, CHAT_LAYOUT.messageSpacing]
              )}>
                {/* Session-level AnimatePresence: Prevents layout jump when switching sessions */}
                <AnimatePresence mode={compactMode ? "sync" : "wait"} initial={false}>
                  <motion.div
                    key={compactMode ? 'compact-session' : session?.id}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={compactMode ? { duration: 0 } : { duration: 0.1, ease: 'easeOut' }}
                  >
                    {/* Loading/Content AnimatePresence: sync mode avoids stale loading exits masking ready content */}
                    <AnimatePresence mode="sync" initial={false}>
                    {messagesLoading ? (
                      /* Loading State: Show spinner while messages are being lazy loaded */
                      <motion.div
                        key="loading"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={compactMode ? { duration: 0 } : { duration: 0.1 }}
                        className="flex items-center justify-center h-64"
                      >
                        <Spinner className="text-foreground/30" />
                      </motion.div>
                    ) : messagesLoadError ? (
                      <motion.div
                        key="load-error"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={compactMode ? { duration: 0 } : { duration: 0.1 }}
                        className="flex items-center justify-center h-64 px-4"
                      >
                        <div
                          className="max-w-sm rounded-[8px] border border-destructive/20 px-4 py-3 text-center shadow-tinted"
                          style={{
                            backgroundColor: 'oklch(from var(--destructive) l c h / 0.03)',
                            '--shadow-color': 'var(--destructive-rgb)',
                          } as React.CSSProperties}
                        >
                          <AlertTriangle className="mx-auto mb-2 h-4 w-4 text-destructive/70" />
                          <div className="text-sm font-medium text-destructive">{t("chat.failedToLoadConversation")}</div>
                          <p className="mt-1 break-words text-xs text-destructive/70">{messagesLoadError}</p>
                          {onRetryMessagesLoad && (
                            <button
                              type="button"
                              onClick={onRetryMessagesLoad}
                              disabled={messagesRetrying}
                              className="mt-3 rounded border border-destructive/20 px-2 py-0.5 text-xs text-destructive/70 transition-colors hover:border-destructive/40 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {messagesRetrying ? t("common.retrying") : t("common.retry")}
                            </button>
                          )}
                        </div>
                      </motion.div>
                    ) : (
                    /* Turn-based Message Display - memoized to avoid re-grouping on every render */
                    /* AnimatePresence handles the fade-in animation when transitioning from loading */
                    <motion.div
                      key={compactMode ? 'loaded-compact' : `loaded-${session?.id}`}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={compactMode ? { duration: 0 } : { duration: 0.1, ease: 'easeOut' }}
                    >
                  {/* Pin to the newest turn before paint - fires via useLayoutEffect */}
                  {/* Skip when search is active on session switch - scroll to first match instead */}
                  <PinToBottomOnMount
                    viewportRef={scrollViewportRef}
                    resetKey={session?.id}
                    skip={skipScrollToBottom}
                    onScroll={() => {
                      skipSmoothScrollUntilRef.current = Date.now() + 500
                    }}
                  />
                  {/* Empty state for compact mode - inviting conversational prompt, centered in full popover */}
                  {compactMode && turns.length === 0 && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center select-none gap-1 pointer-events-none">
                      <span className="text-sm text-muted-foreground">{t("editPopover.whatToChange")}</span>
                      <span className="text-xs text-muted-foreground/50">{t("editPopover.justDescribe")}</span>
                    </div>
                  )}
                  {!compactMode && hasUnrenderedLoadedMessages && (
                    <div className="flex h-64 items-center justify-center px-4 text-center">
                      <div className="max-w-sm rounded-[8px] border border-border/50 bg-foreground/[0.03] px-4 py-3">
                        <CircleAlert className="mx-auto mb-2 h-4 w-4 text-foreground/50" />
                        <div className="text-sm font-medium text-foreground/70">Conversation loaded, but no renderable messages were found.</div>
                        <p className="mt-1 text-xs text-foreground/50">Try reloading the session. If this persists, the message history may contain an unsupported format.</p>
                      </div>
                    </div>
                  )}
                  {/* Load more indicator - shown when there are older messages */}
                  {hasMoreAbove && (
                    <div className="text-center text-muted-foreground/60 text-xs py-3 select-none">
                      ↑ {t('chat.scrollUpForEarlier', { count: startIndex > 0 ? startIndex : unloadedMessageCount })}
                    </div>
                  )}
                  {turns.map((turn, index) => {
                    // Compute turn key and check if it's a search match
                    const turnKey = getTurnKey(turn)
                    const isCurrentMatch = isSearchActive && currentMatchTurnKey === turnKey
                    const isAnyMatch = isSearchActive && matchingTurnIds.has(turnKey)

                    // User turns - render with MemoizedMessageBubble
                    // Extra padding creates visual separation from AI responses
                    if (turn.type === 'user') {
                      return (
                        <div
                          key={turnKey}
                          ref={el => { if (el) turnRefs.current.set(turnKey, el); else turnRefs.current.delete(turnKey) }}
                          data-message-id={turn.message.id}
                          className={cn(
                            compactMode ? "pt-2 pb-1" : CHAT_LAYOUT.userMessagePadding,
                            "rounded-lg transition-all duration-200",
                            isCurrentMatch && "ring-2 ring-info ring-offset-2 ring-offset-background",
                            isAnyMatch && !isCurrentMatch && "ring-1 ring-info/30"
                          )}
                        >
                          <MemoizedMessageBubble
                            message={turn.message}
                            onOpenFile={onOpenFile}
                            onOpenUrl={onOpenUrl}
                            sessionId={session?.id}
                            baseDir={workingDirectory}
                            compactMode={compactMode}
                            onJumpToMessage={jumpToMessage}
                          />
                        </div>
                      )
                    }

                    // System turns (error, status, info, warning) - render with MemoizedMessageBubble
                    if (turn.type === 'system') {
                      return (
                        <div
                          key={turnKey}
                          ref={el => { if (el) turnRefs.current.set(turnKey, el); else turnRefs.current.delete(turnKey) }}
                          className={cn(
                            "rounded-lg transition-all duration-200",
                            isCurrentMatch && "ring-2 ring-info ring-offset-2 ring-offset-background",
                            isAnyMatch && !isCurrentMatch && "ring-1 ring-info/30"
                          )}
                        >
                          <MemoizedMessageBubble
                            message={turn.message}
                            onOpenFile={onOpenFile}
                            onOpenUrl={onOpenUrl}
                            sessionId={session?.id}
                            baseDir={workingDirectory}
                            onRetry={turn.message.role === 'error' ? () => {
                              const msgs = session?.messages
                              if (!msgs) return
                              const errorIdx = msgs.findIndex(m => m.id === turn.message.id)
                              const lastUserMsg = msgs.slice(0, errorIdx).findLast(m => m.role === 'user')
                              if (lastUserMsg) {
                                onSendMessage(lastUserMsg.content)
                              }
                            } : undefined}
                          />
                        </div>
                      )
                    }

                    // Auth-request turns - render inline auth UI
                    // mt-2 matches ResponseCard spacing for visual consistency
                    if (turn.type === 'auth-request') {
                      // Interactive only if no user message follows
                      const isAuthInteractive = !turns.slice(index + 1).some(t => t.type === 'user')
                      return (
                        <div
                          key={turnKey}
                          ref={el => { if (el) turnRefs.current.set(turnKey, el); else turnRefs.current.delete(turnKey) }}
                          className={cn(
                            "mt-2 rounded-lg transition-all duration-200",
                            isCurrentMatch && "ring-2 ring-info ring-offset-2 ring-offset-background",
                            isAnyMatch && !isCurrentMatch && "ring-1 ring-info/30"
                          )}
                        >
                          <MemoizedAuthRequestCard
                            message={turn.message}
                            sessionId={session.id}
                            onRespondToCredential={onRespondToCredential}
                            isInteractive={isAuthInteractive}
                          />
                        </div>
                      )
                    }

                    // Check if this is the last response (for Accept Plan button visibility)
                    const isLastResponse = index === turns.length - 1 || !turns.slice(index + 1).some(t => t.type === 'user')

                    // Assistant turns - render with TurnCard (buffered streaming)
                    // through a memoized item: it owns the handlers bound to this
                    // turn, so a token elsewhere does not rebuild its props.
                    const assistantUiKey = getAssistantTurnUiKey(turn, index)
                    return (
                      <div
                        key={turnKey}
                        ref={el => { if (el) turnRefs.current.set(turnKey, el); else turnRefs.current.delete(turnKey) }}
                        className={cn(
                          "pt-2",
                          "rounded-lg transition-all duration-200",
                          isCurrentMatch && "ring-2 ring-info ring-offset-2 ring-offset-background",
                          isAnyMatch && !isCurrentMatch && "ring-1 ring-info/30"
                        )}
                      >
                        <AssistantTurnItem
                          turn={turn}
                          uiKey={assistantUiKey}
                          sessionId={session.id}
                          sessionFolderPath={session.sessionFolderPath}
                          workingDirectory={workingDirectory}
                          isExpanded={expandedTurns.has(assistantUiKey)}
                          onToggleTurn={toggleTurn}
                          expandedActivityGroups={expandedActivityGroups}
                          onExpandedActivityGroupsChange={setExpandedActivityGroups}
                          isLastResponse={isLastResponse}
                          compactMode={compactMode}
                          sendMessageKey={sendMessageKey}
                          openAnnotationRequest={openAnnotationRequest}
                          hasActiveFollowUpAnnotations={pendingFollowUpAnnotations.length > 0}
                          supportsBranching={!!session.supportsBranching}
                          onOpenFile={onOpenFile}
                          onOpenUrl={onOpenUrl}
                          onReply={startReply}
                          onSaveAndSendFollowUp={handleSaveAndSendFollowUp}
                          onBranch={handleBranch}
                          onAddAnnotation={handleAddAnnotation}
                          onRemoveAnnotation={handleRemoveAnnotation}
                          onUpdateAnnotation={handleUpdateAnnotation}
                          onAcceptPlan={handleAcceptPlan}
                          onAcceptPlanWithCompact={handleAcceptPlanWithCompact}
                          onPopOut={openMarkdownOverlay}
                          onOpenOverlay={setOverlayState}
                        />
                      </div>
                    )
                  })}
                    </motion.div>
                    )}
                    </AnimatePresence>
                  </motion.div>
                </AnimatePresence>
                {/* Processing Indicator - always visible while processing */}
                {session.isProcessing && (() => {
                  // Walk backwards instead of copying + reversing: this runs on
                  // every rendered token, and the transcript is unbounded.
                  let lastUserMsg: Message | undefined
                  for (let i = session.messages.length - 1; i >= 0; i--) {
                    const candidate = session.messages[i]
                    if (candidate && candidate.role === 'user' && !candidate.isQueued) {
                      lastUserMsg = candidate
                      break
                    }
                  }
                  return (
                    <ProcessingIndicator
                      startTime={lastUserMsg?.timestamp}
                      statusMessage={session.currentStatus?.message}
                    />
                  )
                })()}
              </div>
              </ScrollArea>
            </div>
            {/* No rail to sit under (compact/mobile, or a conversation with a
                single turn): the way back down floats over the messages,
                clear of the fade at the bottom edge. */}
            {!showTurnRail && (
              <div className="pointer-events-none absolute inset-x-0 bottom-2 z-20 flex justify-end pr-2">
                <ScrollToBottomButton
                  variant="floating"
                  visible={!isAtBottom}
                  onClick={handleJumpToLatest}
                  className="pointer-events-auto"
                />
              </div>
            )}
          </div>
          {showTurnRail && (
            <TurnRail
              items={railItems}
              activeKey={activeTurnKey}
              onSelect={handleRailSelect}
              // Directly under the ticks: same column, same job — going back to
              // where the conversation is.
              trailing={
                <ScrollToBottomButton
                  visible={!isAtBottom}
                  onClick={handleJumpToLatest}
                />
              }
            />
          )}
          </div>

          {/* === INPUT CONTAINER: FreeForm or Structured Input === */}
          <ChatInputZone
            compactMode={compactMode}
            permissionMode={permissionMode}
            onPermissionModeChange={onPermissionModeChange}
            tasks={backgroundTasks}
            sessionId={session.id}
            sessionFolderPath={sessionFolderPath}
            onKillTask={(taskId) => killTask(taskId, backgroundTasks.find(t => t.id === taskId)?.type === 'shell' ? 'shell' : 'agent')}
            onInsertMessage={onInputChange}
            sessionLabels={session.labels}
            labels={labels}
            onLabelsChange={onLabelsChange}
            sessionStatuses={sessionStatuses}
            currentSessionStatus={session.sessionStatus || 'todo'}
            onSessionStatusChange={onSessionStatusChange}
            queuedMessages={queuedMessages}
            queuedFromAgents={queued.fromAgents}
            onDiscardQueuedFromAgent={handleRemoveQueuedMessage}
            onEditQueued={handleEditQueuedMessage}
            onRemoveQueued={handleRemoveQueuedMessage}
            onSendQueuedNow={handleSendQueuedMessageNow}
            onReorderQueued={handleReorderQueuedMessage}
            onReorderQueuedExpired={handleReorderQueuedExpired}
            replyTo={replyTo}
            onClearReply={() => setReplyTo(null)}
            inputProps={{
              placeholder,
              previousPermissionMode,
              disabled: isInputDisabled,
              isProcessing: session.isProcessing,
              onAnimatedHeightChange: handleAnimatedHeightChange,
              onSubmit: handleSubmit,
              onStop: handleStop,
              textareaRef,
              currentModel,
              onModelChange,
              thinkingLevel,
              onThinkingLevelChange,
              enabledModes,
              enableCompactModelPicker,
              structuredInput,
              onStructuredResponse: handleStructuredResponse,
              inputValue,
              onInputChange,
              attachmentsValue,
              onAttachmentsChange,
              sources,
              enabledSourceSlugs: session.enabledSourceSlugs,
              onSourcesChange,
              skills,
              workspaceId,
              workingDirectory,
              onWorkingDirectoryChange,
              disableSend: disableSend || connectionUnavailable,
              connectionUnavailable,
              isEmptySession: session.messages.length === 0,
              currentConnection: session.llmConnection,
              onConnectionChange,
              contextStatus: {
                isCompacting: session.currentStatus?.statusType === 'compacting',
                inputTokens: session.tokenUsage?.inputTokens,
                contextWindow: session.tokenUsage?.contextWindow,
                contextUsage: session.tokenUsage?.contextUsage,
              },
              followUpItems: followUpInputItems,
              onFollowUpClick: handleFollowUpChipClick,
              onFollowUpIndexClick: handleFollowUpIndexClick,
            }}
          />
          </div>
        </div>
      ) : null}

      {/* ================================================================== */}
      {/* Preview Overlays - Rendered outside the main chat flow            */}
      {/* ================================================================== */}

      {/* Activity details overlay */}
      {overlayState?.type === 'activity' && useStackedActivityOverlay && (
        <ActivityCardsOverlay
          isOpen={true}
          onClose={handleCloseOverlay}
          cards={overlayCards}
          title={overlayState.activity.displayName || overlayState.activity.toolName || 'Activity'}
          theme={isDark ? 'dark' : 'light'}
          onOpenUrl={onOpenUrl}
          onOpenFile={onOpenFile}
        />
      )}

      {/* Legacy output-only activity overlay for non-bash/non-mcp tools */}
      {overlayState?.type === 'activity' && !useStackedActivityOverlay && activityOutputOverlayData && (
        activityOutputOverlayData.type === 'code' ? (
          <CodePreviewOverlay
            isOpen={true}
            onClose={handleCloseOverlay}
            content={activityOutputOverlayData.content}
            filePath={activityOutputOverlayData.filePath}
            mode={activityOutputOverlayData.mode}
            startLine={activityOutputOverlayData.startLine}
            totalLines={activityOutputOverlayData.totalLines}
            numLines={activityOutputOverlayData.numLines}
            command={activityOutputOverlayData.command}
            error={activityOutputOverlayData.error}
            theme={isDark ? 'dark' : 'light'}
          />
        ) : activityOutputOverlayData.type === 'terminal' ? (
          <TerminalPreviewOverlay
            isOpen={true}
            onClose={handleCloseOverlay}
            command={activityOutputOverlayData.command}
            output={activityOutputOverlayData.output}
            exitCode={activityOutputOverlayData.exitCode}
            toolType={activityOutputOverlayData.toolType}
            description={activityOutputOverlayData.description}
            error={activityOutputOverlayData.error}
            theme={isDark ? 'dark' : 'light'}
          />
        ) : activityOutputOverlayData.type === 'json' ? (
          <JSONPreviewOverlay
            isOpen={true}
            onClose={handleCloseOverlay}
            data={activityOutputOverlayData.data}
            title={activityOutputOverlayData.title}
            error={activityOutputOverlayData.error}
            theme={isDark ? 'dark' : 'light'}
          />
        ) : activityOutputOverlayData.type === 'document' ? (
          <DocumentFormattedMarkdownOverlay
            isOpen={true}
            onClose={handleCloseOverlay}
            content={activityOutputOverlayData.content}
            onOpenUrl={onOpenUrl}
            onOpenFile={onOpenFile}
            filePath={activityOutputOverlayData.filePath}
            typeBadge={{
              icon: Info,
              label: activityOutputOverlayData.toolName,
              variant: 'blue',
            }}
            error={activityOutputOverlayData.error}
          />
        ) : detectLanguage(activityOutputOverlayData.content) === 'markdown' ? (
          <DocumentFormattedMarkdownOverlay
            isOpen={true}
            onClose={handleCloseOverlay}
            content={activityOutputOverlayData.content}
            onOpenUrl={onOpenUrl}
            onOpenFile={onOpenFile}
            typeBadge={{
              icon: Info,
              label: overlayState.activity.displayName || overlayState.activity.toolName || 'Activity',
              variant: 'blue',
            }}
            error={activityOutputOverlayData.error}
          />
        ) : (
          <GenericOverlay
            isOpen={true}
            onClose={handleCloseOverlay}
            content={activityOutputOverlayData.content}
            title={activityOutputOverlayData.title}
            error={activityOutputOverlayData.error}
            theme={isDark ? 'dark' : 'light'}
          />
        )
      )}

      {/* Multi-diff preview overlay (Edit/Write tools) */}
      {overlayState?.type === 'multi-diff' && (
        <MultiDiffPreviewOverlay
          isOpen={true}
          onClose={handleCloseOverlay}
          changes={overlayState.changes}
          consolidated={overlayState.consolidated}
          focusedChangeId={overlayState.focusedChangeId}
          theme={isDark ? 'dark' : 'light'}
          diffViewerSettings={diffViewerSettings}
          onDiffViewerSettingsChange={handleDiffViewerSettingsChange}
        />
      )}

      {/* Markdown preview overlay (pop-out, turn details) */}
      {/* forceCodeView: show raw markdown source in code viewer (used by "View as Markdown" button) */}
      {/* otherwise: render formatted markdown (used by turn details, etc.) */}
      {overlayState?.type === 'markdown' && (
        overlayState.forceCodeView ? (
          <CodePreviewOverlay
            isOpen={true}
            onClose={handleCloseOverlay}
            content={overlayState.content}
            filePath="response.md"
            language="markdown"
            mode="read"
            theme={isDark ? 'dark' : 'light'}
          />
        ) : (
          <DocumentFormattedMarkdownOverlay
            isOpen={true}
            onClose={handleCloseOverlay}
            content={overlayState.content}
            onOpenUrl={onOpenUrl}
            onOpenFile={onOpenFile}
          />
        )
      )}
    </div>
  )
})

/**
 * MessageBubble - Renders a single message based on its role
 *
 * Message Roles & Styles:
 * - user:      Right-aligned, blue (bg-foreground), white text
 * - assistant: Left-aligned, gray (bg-muted), markdown rendered with clickable links
 * - error:     Left-aligned, red border/bg, warning icon + error message
 * - status:    Centered pill badge with pulsing dot (e.g., t("chat.processing.thinking"))
 *
 * Note: Tool messages are rendered by TurnCard, not MessageBubble
 */
interface MessageBubbleProps {
  message: Message
  onOpenFile: (path: string) => void
  onOpenUrl: (url: string) => void
  sessionId?: string
  /** The conversation's working directory — the folder a relative file link in the message resolves against. */
  baseDir?: string
  /**
   * Markdown render mode for assistant messages
   * @default 'minimal'
   */
  renderMode?: RenderMode
  /**
   * Callback to pop out message into a separate window
   */
  onPopOut?: (message: Message) => void
  /** Compact mode - reduces padding for popover embedding */
  compactMode?: boolean
  /** Callback to resend the user message that preceded an error */
  onRetry?: () => void
  /** Click a quote to go back to the message it quotes. */
  onJumpToMessage?: (messageId: string) => void
}

/**
 * ErrorMessage - Separate component for error messages to allow useState hook
 */
function ErrorMessage({ message, onOpenUrl, sessionId, onRetry }: { message: Message; onOpenUrl?: (url: string) => void; sessionId?: string; onRetry?: () => void }) {
  const { t } = useTranslation()
  const hasDetails = (message.errorDetails && message.errorDetails.length > 0) || message.errorOriginal
  const [detailsOpen, setDetailsOpen] = React.useState(false)
  const actions = message.errorActions?.filter(a => {
    if (a.action === 'open_url') return !!a.url && !!onOpenUrl
    return true
  })

  return (
    <div className="flex justify-start mt-4">
      {/* Subtle bg (3% opacity) + tinted shadow for softer error appearance */}
      <div
        className="max-w-[80%] shadow-tinted rounded-[8px] pl-5 pr-4 pt-2 pb-2.5 break-words"
        style={{
          backgroundColor: 'oklch(from var(--destructive) l c h / 0.03)',
          '--shadow-color': 'var(--destructive-rgb)',
        } as React.CSSProperties}
      >
        <div className="text-xs text-destructive/50 mb-0.5 font-semibold">
          {message.errorTitle || t('common.error')}
        </div>
        <p className="text-sm text-destructive">{message.content}</p>

        {/* Action buttons */}
        {actions && actions.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {actions.map((action) => (
              <button
                key={action.key}
                onClick={() => {
                  handleErrorMessageAction(action, {
                    sessionId,
                    onOpenUrl,
                    onRetry,
                  })
                }}
                className="text-xs px-2 py-0.5 rounded border border-destructive/20 text-destructive/70 hover:text-destructive hover:border-destructive/40 transition-colors"
              >
                {action.label}{action.action === 'open_url' ? ' ↗' : ''}
              </button>
            ))}
          </div>
        )}

        {/* Collapsible Details Toggle */}
        {hasDetails && (
          <div className="mt-2">
            <button
              onClick={() => setDetailsOpen(!detailsOpen)}
              className="flex items-center gap-1 text-xs text-destructive/70 hover:text-destructive transition-colors"
            >
              {detailsOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              <span>{detailsOpen ? t('chat.hideTechnicalDetails') : t('chat.showTechnicalDetails')}</span>
            </button>

            <AnimatedCollapsibleContent isOpen={detailsOpen} className="overflow-hidden">
              <div className="mt-2 pt-2 border-t border-destructive/20 text-xs text-destructive/60 font-mono space-y-0.5">
                {message.errorDetails?.map((detail, i) => (
                  <div key={i}>{detail}</div>
                ))}
                {message.errorOriginal && !message.errorDetails?.some(d => d.includes('Raw error:')) && (
                  <div className="mt-1">Raw: {message.errorOriginal.slice(0, 200)}{message.errorOriginal.length > 200 ? '...' : ''}</div>
                )}
              </div>
            </AnimatedCollapsibleContent>
          </div>
        )}
      </div>
    </div>
  )
}

function MessageBubble({
  message,
  onOpenFile,
  onOpenUrl,
  sessionId,
  baseDir,
  renderMode = 'minimal',
  onPopOut,
  compactMode,
  onRetry,
  onJumpToMessage,
}: MessageBubbleProps) {
  const { t } = useTranslation()

  // === USER MESSAGE: Right-aligned bubble with attachments above ===
  if (message.role === 'user') {
    return (
      <UserMessageBubble
        // An agent's message keeps its envelope in storage (that is what the model reads) but not
        // on screen: what a person needs is the message, and who it came from — not the addressing.
        content={withoutAgentEnvelope(message.content, message)}
        fromAgent={agentAttribution(message)}
        attachments={message.attachments}
        badges={message.badges}
        isPending={message.isPending}
        replyTo={message.replyTo}
        onJumpToMessage={onJumpToMessage}
        onUrlClick={onOpenUrl}
        onFileClick={onOpenFile}
        compactMode={compactMode}
      />
    )
  }

  // === ASSISTANT MESSAGE: Left-aligned gray bubble with markdown rendering ===
  if (message.role === 'assistant') {
    return (
      <div className="flex justify-start group">
        <div className="relative max-w-[90%] bg-background shadow-minimal rounded-[8px] pl-6 pr-4 py-3 break-words min-w-0 select-text">
          {/* Pop-out button - visible on hover */}
          {onPopOut && !message.isStreaming && (
            <button
              onClick={() => onPopOut(message)}
              data-touch-reveal="true"
              className="absolute top-2 right-2 p-1.5 rounded-md opacity-0 group-hover:opacity-100 transition-opacity hover:bg-foreground/5"
              title={t("sidebarMenu.openInNewWindow")}
            >
              <ExternalLink className="w-4 h-4 text-muted-foreground hover:text-foreground" />
            </button>
          )}
          {/* Use StreamingMarkdown for block-level memoization during streaming */}
          {message.isStreaming ? (
            <StreamingMarkdown
              content={message.content}
              isStreaming={true}
              mode={renderMode}
              baseDir={baseDir}
              onUrlClick={onOpenUrl}
              onFileClick={onOpenFile}
            />
          ) : (
            <CollapsibleMarkdownProvider>
              <Markdown
                mode={renderMode}
                baseDir={baseDir}
                onUrlClick={onOpenUrl}
                onFileClick={onOpenFile}
                id={message.id}
                className="text-sm"
                collapsible
              >
                {message.content}
              </Markdown>
            </CollapsibleMarkdownProvider>
          )}
        </div>
      </div>
    )
  }

  // === ERROR MESSAGE: Red bordered bubble with warning icon and collapsible details ===
  if (message.role === 'error') {
    return <ErrorMessage message={message} onOpenUrl={onOpenUrl} sessionId={sessionId} onRetry={onRetry} />
  }

  // === STATUS MESSAGE: Matches ProcessingIndicator layout for visual consistency ===
  if (message.role === 'status') {
    return (
      <div className="flex items-center gap-2 px-3 py-1 -mb-1 text-[13px] text-muted-foreground">
        {/* Spinner in same location as TurnCard chevron */}
        <div className="w-3 h-3 flex items-center justify-center shrink-0">
          <Spinner className="text-[10px]" />
        </div>
        <span>{message.content}</span>
      </div>
    )
  }

  // === INFO MESSAGE: Icon and color based on level ===
  if (message.role === 'info') {
    // Compaction complete message - render as horizontal rule with centered label
    // This persists after reload to show where context was compacted
    if (message.statusType === 'compaction_complete') {
      return (
        <div className="flex items-center gap-3 my-12 px-3">
          <div className="flex-1 h-px bg-border" />
          <span className="text-sm text-muted-foreground/70 select-none">
            Conversation Compacted
          </span>
          <div className="flex-1 h-px bg-border" />
        </div>
      )
    }

    const level = message.infoLevel || 'info'
    const config = {
      info: { icon: Info, className: 'text-muted-foreground' },
      warning: { icon: AlertTriangle, className: 'text-info' },
      error: { icon: CircleAlert, className: 'text-destructive' },
      success: { icon: CheckCircle2, className: 'text-success' },
    }[level]
    const Icon = config.icon

    return (
      <div className={cn('flex items-center gap-2 px-3 py-1 text-[13px] select-none', config.className)}>
        <div className="w-3 h-3 flex items-center justify-center shrink-0">
          <Icon className="w-3 h-3" />
        </div>
        <span>{message.content}</span>
      </div>
    )
  }

  // === WARNING MESSAGE: Info themed bubble ===
  if (message.role === 'warning') {
    return (
      <div className="flex justify-start">
        <div className="max-w-[80%] bg-info/10 rounded-[8px] pl-5 pr-4 pt-2 pb-2.5 break-words select-none">
          <div className="text-xs text-info/50 mb-0.5 font-semibold">
            Warning
          </div>
          <p className="text-sm text-info">{message.content}</p>
        </div>
      </div>
    )
  }

  return null
}

/**
 * MemoizedMessageBubble - Prevents re-renders of non-streaming messages
 *
 * During streaming, the entire message list gets updated on each delta.
 * This wrapper skips re-renders for messages that haven't changed,
 * significantly improving performance for long conversations.
 */
const MemoizedMessageBubble = React.memo(MessageBubble, (prev, next) => {
  // Always re-render streaming messages (content is changing)
  if (prev.message.isStreaming || next.message.isStreaming) {
    return false
  }
  // Skip re-render if key props unchanged
  return (
    prev.message.id === next.message.id &&
    prev.message.content === next.message.content &&
    prev.message.role === next.message.role &&
    // Queued/pending flags drive the queued chip (and its cancel button), so a
    // flip must re-render even though the bubble content is unchanged.
    prev.message.isQueued === next.message.isQueued &&
    prev.message.isPending === next.message.isPending &&
    prev.sessionId === next.sessionId &&
    prev.baseDir === next.baseDir &&
    prev.compactMode === next.compactMode
  )
})
