/**
 * ChatPage
 *
 * Displays a single session's chat with a consistent PanelHeader.
 * Extracted from MainContentPanel for consistency with other pages.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useAtomValue, useSetAtom } from 'jotai'
import { AlertCircle, Globe, Copy, RefreshCw, Link2Off, Info, Pencil, PanelRight, PanelRightClose } from 'lucide-react'
import { ChatDisplay, type ChatDisplayHandle } from '@/components/app-shell/ChatDisplay'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { SessionMenu } from '@/components/app-shell/SessionMenu'
import { CompactSessionMenu } from '@/components/app-shell/CompactSessionMenu'
import { ConversationSuffix } from '@/components/app-shell/ConversationSuffix'
import { SessionInfoPopover } from '@/components/app-shell/SessionInfoPopover'
import { RenameDialog } from '@/components/ui/rename-dialog'
import { toast } from 'sonner'
import { PanelHeaderCenterButton } from '@/components/ui/PanelHeaderCenterButton'
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { StyledDropdownMenuContent, StyledDropdownMenuItem, StyledDropdownMenuSeparator } from '@/components/ui/styled-dropdown'
import { useAppShellContext, usePendingPermission, usePendingCredential, useSessionOptionsFor, useSession as useSessionData } from '@/context/AppShellContext'
import { rendererPerf } from '@/lib/perf'
import { isAbsolutePath } from '@/lib/drafts'
import { buildHandoffBrief } from '@/lib/bot-handoff'
import { navigate, routes } from '@/lib/navigate'
import { coerceInputText } from '@/lib/input-text'
import { deriveSessionMessagesLoadState, formatSessionLoadFailure } from '@/lib/session-load'
import { ensureSessionMessagesLoadedAtom, forceSessionMessagesReloadAtom, loadOlderSessionMessagesAtom, revealSessionMessageAtom, searchSessionMessagesAtom, sessionQuestionsAtom, loadedSessionsAtom, sessionMetaMapAtom } from '@/atoms/sessions'
import { projectsAtom } from '@/atoms/projects'
import { nextCanvasLayout, useCanvasLayout } from '@/atoms/canvas-layout'
import { kanbanEditorTargetAtom } from '@/atoms/kanban'
import { getSessionTitle } from '@/utils/session'
// Model resolution: connection.defaultModel (no hardcoded defaults)
import { resolveEffectiveConnectionSlug, isSessionConnectionUnavailable } from '@config/llm-connections'

/**
 * What an assistant's header shows instead of a conversation's.
 *
 * A conversation's header is a **menu of things you can do to a session**: move it to a project,
 * label it, set its board column, share it, archive it. None of those are true of the assistant —
 * it is not filed anywhere, it is not on the board, and it is not a thing you send someone a link
 * to. So the slot replaces the two halves of that header rather than adding to them: the title
 * stops being a dropdown, and the right-hand cluster stops carrying share.
 */
export interface AssistantHeaderChrome {
  /** Beside the title: a fact about the assistant itself, e.g. how many turns are running. */
  badge?: React.ReactNode
  /**
   * The title's menu — only the verbs that are actually true of an assistant (for now: binding an
   * IM bot, which is how a person writes to it from a phone). Omit it and the title is plain text.
   */
  menu?: React.ReactNode
  /** Replaces the right-hand cluster (share and session info are a conversation's verbs). */
  actions?: React.ReactNode
}

export interface ChatPageProps {
  sessionId: string
  /** Set when this page is an assistant rather than a conversation. */
  assistantHeader?: AssistantHeaderChrome
}

const ChatPage = React.memo(function ChatPage({ sessionId, assistantHeader }: ChatPageProps) {
  // An assistant's composer is the same composer. What is NOT taken away is the part that writes
  // the message: `@` references (sources, skills, files, tabs) and `/` commands are how a person
  // points at a thing, and Trae's assistant has both — the assistant's job is *more* about
  // referring to things than a chat's, not less.
  //
  // What it leaves out is the per-conversation plumbing: labels and the board column (it is not on
  // the board), and the working-directory selector (it works in the workspace root; children decide
  // their own). The directory itself is still passed, because file search for `@` needs a base path.
  const isAssistant = !!assistantHeader
  const { t } = useTranslation()
  // Diagnostic: mark when component runs
  React.useLayoutEffect(() => {
    rendererPerf.markSessionSwitch(sessionId, 'panel.mounted')
  }, [sessionId])

  const {
    activeWorkspaceId,
    llmConnections,
    workspaceDefaultLlmConnection,
    onSendMessage,
    onOpenFile,
    onOpenUrl,
    workspaces,
    onRespondToPermission,
    onRespondToCredential,
    onMarkSessionRead,
    onMarkSessionUnread,
    onSetActiveViewingSession,
    getDraft,
    hydrateDraftAttachments,
    onInputChange,
    onAttachmentsChange,
    onHandOffToBot,
    enabledSources,
    skills,
    labels,
    onSessionLabelsChange,
    enabledModes,
    sessionStatuses,
    onSessionSourcesChange,
    onRenameSession,
    onFlagSession,
    onUnflagSession,
    onArchiveSession,
    onUnarchiveSession,
    onSessionStatusChange,
    onDeleteSession,
    rightSidebarButton,
    leadingAction,
    isCompactMode,
    sessionListSearchQuery,
    isSearchModeActive,
    chatDisplayRef,
    onChatMatchInfoChange,
    isFocusedPanel,
  } = useAppShellContext()

  // Use the unified session options hook for clean access
  const {
    options: sessionOpts,
    setOption,
    setPermissionMode,
  } = useSessionOptionsFor(sessionId)

  // Use per-session atom for isolated updates
  const session = useSessionData(sessionId)

  // Track if messages are loaded for this session (for lazy loading)
  const loadedSessions = useAtomValue(loadedSessionsAtom)
  const messagesLoaded = loadedSessions.has(sessionId)

  // Check if session exists in metadata (for loading state detection)
  const sessionMetaMap = useAtomValue(sessionMetaMapAtom)
  const sessionMeta = sessionMetaMap.get(sessionId)

  // Which board this conversation works on is the project's; how the board is shown beside the
  // conversation is the project's layout (see `atoms/canvas-layout`). A conversation with no
  // project has neither, so the control below does not exist there.
  const sessionProjectId = session?.projectId ?? sessionMeta?.projectId ?? null
  const [canvasLayoutMode, setCanvasLayoutMode] = useCanvasLayout(sessionProjectId)

  // Fallback: ensure messages are loaded when session is viewed
  const ensureMessagesLoaded = useSetAtom(ensureSessionMessagesLoadedAtom)
  const forceMessagesReload = useSetAtom(forceSessionMessagesReloadAtom)
  const loadOlderMessages = useSetAtom(loadOlderSessionMessagesAtom)
  const searchMessages = useSetAtom(searchSessionMessagesAtom)
  const loadQuestions = useSetAtom(sessionQuestionsAtom)
  const revealMessage = useSetAtom(revealSessionMessageAtom)
  // A conversation opens on its newest page; scrolling past its oldest message
  // asks for the page before it. Stable identity: the chat keeps this in a ref.
  const handleLoadOlderMessages = React.useCallback(
    () => loadOlderMessages(sessionId),
    [loadOlderMessages, sessionId],
  )
  // Search asks the conversation, not the loaded page: a hit in a part of the
  // history this panel never loaded still has to be found — and then opened.
  const handleSearchMessages = React.useCallback(
    (query: string) => searchMessages(sessionId, query),
    [searchMessages, sessionId],
  )
  const handleRevealMessage = React.useCallback(
    (messageId: string) => revealMessage(sessionId, messageId),
    [revealMessage, sessionId],
  )
  // The turn rail ticks every question in the conversation, including the ones
  // this panel has not loaded.
  const handleLoadQuestions = React.useCallback(
    () => loadQuestions(sessionId),
    [loadQuestions, sessionId],
  )
  const [messagesLoadError, setMessagesLoadError] = React.useState<string | null>(null)
  const [messagesRetrying, setMessagesRetrying] = React.useState(false)
  const autoForcedReloadSessionRef = React.useRef<string | null>(null)
  const shouldForceInitialMessagesReload = React.useMemo(() => {
    const expectedMessageCount = session?.messageCount ?? sessionMeta?.messageCount ?? 0
    return messagesLoaded
      && !!session
      && (session.messages?.length ?? 0) === 0
      && (expectedMessageCount > 0 || !!session.lastFinalMessageId || !!sessionMeta?.lastFinalMessageId)
  }, [messagesLoaded, session, sessionMeta])

  React.useEffect(() => {
    let cancelled = false
    setMessagesLoadError(null)
    setMessagesRetrying(false)

    if (shouldForceInitialMessagesReload && autoForcedReloadSessionRef.current === sessionId) {
      setMessagesLoadError('Session messages are not available')
      return () => {
        cancelled = true
      }
    }

    const useForceReload = shouldForceInitialMessagesReload
    if (useForceReload) {
      autoForcedReloadSessionRef.current = sessionId
    }

    const loadPromise = useForceReload
      ? forceMessagesReload(sessionId)
      : ensureMessagesLoaded(sessionId)

    loadPromise
      .then((loadedSession) => {
        if (!cancelled && !loadedSession) {
          setMessagesLoadError('Session messages are not available')
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setMessagesLoadError(formatSessionLoadFailure(error))
        }
      })

    return () => {
      cancelled = true
    }
  }, [sessionId, ensureMessagesLoaded, forceMessagesReload, shouldForceInitialMessagesReload])

  const handleRetryMessagesLoad = React.useCallback(async () => {
    setMessagesLoadError(null)
    setMessagesRetrying(true)

    try {
      const loadedSession = await forceMessagesReload(sessionId)
      if (!loadedSession) {
        setMessagesLoadError('Session messages are not available')
      }
    } catch (error) {
      setMessagesLoadError(formatSessionLoadFailure(error))
    } finally {
      setMessagesRetrying(false)
    }
  }, [forceMessagesReload, sessionId])

  const messageLoadState = React.useMemo(() => deriveSessionMessagesLoadState({
    session,
    sessionMeta,
    messagesLoaded,
    loadError: messagesLoadError,
  }), [session, sessionMeta, messagesLoaded, messagesLoadError])

  // Perf: Mark when session data is available
  const sessionLoadedMarkedRef = React.useRef<string | null>(null)
  React.useLayoutEffect(() => {
    if (session && sessionLoadedMarkedRef.current !== sessionId) {
      sessionLoadedMarkedRef.current = sessionId
      rendererPerf.markSessionSwitch(sessionId, 'session.loaded')
    }
  }, [sessionId, session])

  // Track window focus state for marking session as read when app regains focus
  const [isWindowFocused, setIsWindowFocused] = React.useState(true)
  React.useEffect(() => {
    window.electronAPI.getWindowFocusState().then(setIsWindowFocused)
    const cleanup = window.electronAPI.onWindowFocusChange(setIsWindowFocused)
    return cleanup
  }, [])

  // Track which session user is viewing (for unread state machine).
  // This tells main process user is looking at this session, so:
  // 1. If not processing → clear hasUnread immediately
  // 2. If processing → when it completes, main process will clear hasUnread
  // The main process handles all the logic; we just report viewing state.
  React.useEffect(() => {
    if (session && isWindowFocused && isFocusedPanel !== false) {
      onSetActiveViewingSession(session.id)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id, isWindowFocused, isFocusedPanel, onSetActiveViewingSession])

  // Get pending permission and credential for this session
  const pendingPermission = usePendingPermission(sessionId)
  const pendingCredential = usePendingCredential(sessionId)

  // Track draft value for this session
  const [inputValue, setInputValue] = React.useState(() => coerceInputText(getDraft(sessionId)))
  const inputValueRef = React.useRef(inputValue)
  inputValueRef.current = inputValue

  // Re-sync from parent when session changes
  React.useEffect(() => {
    setInputValue(coerceInputText(getDraft(sessionId)))
  }, [getDraft, sessionId])

  // Sync when draft is set externally (e.g., from notifications or shortcuts)
  // PERFORMANCE NOTE: This bounded polling (max 10 attempts × 50ms = 500ms)
  // handles external draft injection. Drafts use a ref for typing performance,
  // so they're not directly reactive. This polling only runs on session switch,
  // not continuously. Alternative: Add a Jotai atom for draft changes.
  React.useEffect(() => {
    let attempts = 0
    const maxAttempts = 10
    const interval = setInterval(() => {
      const currentDraft = coerceInputText(getDraft(sessionId))
      if (currentDraft !== inputValueRef.current && currentDraft !== '') {
        setInputValue(currentDraft)
        clearInterval(interval)
      }
      attempts++
      if (attempts >= maxAttempts) {
        clearInterval(interval)
      }
    }, 50)

    return () => clearInterval(interval)
  }, [sessionId, getDraft])

  // Listen for restore-input events (queued messages restored to input on abort)
  React.useEffect(() => {
    const handler = (e: Event) => {
      const { sessionId: targetId, text } = (e as CustomEvent).detail ?? {}
      if (targetId === sessionId) {
        const nextText = coerceInputText(text)
        setInputValue(nextText)
        inputValueRef.current = nextText
      }
    }
    window.addEventListener('craft:restore-input', handler)
    return () => window.removeEventListener('craft:restore-input', handler)
  }, [sessionId])

  const handleInputChange = React.useCallback((value: string) => {
    const nextText = coerceInputText(value)
    setInputValue(nextText)
    inputValueRef.current = nextText
    onInputChange(sessionId, nextText)
  }, [sessionId, onInputChange])

  // Attachments draft state — hydrated async from persisted refs on session switch.
  // `[]` is the safe default while hydration is in flight; FreeFormInput seeds its
  // local state from this prop and swaps in the restored list when ready.
  const [attachmentsValue, setAttachmentsValue] = React.useState<import('../../shared/types').FileAttachment[]>([])

  React.useEffect(() => {
    let cancelled = false
    setAttachmentsValue([])
    hydrateDraftAttachments(sessionId).then((atts) => {
      if (!cancelled) setAttachmentsValue(atts)
    })
    return () => { cancelled = true }
  }, [sessionId, hydrateDraftAttachments])

  const handleAttachmentsChange = React.useCallback((attachments: import('../../shared/types').FileAttachment[]) => {
    setAttachmentsValue(attachments)
    onAttachmentsChange(sessionId, attachments)
  }, [sessionId, onAttachmentsChange])

  // Session model change handler - persists per-session model and connection
  const handleModelChange = React.useCallback((model: string, connection?: string) => {
    if (activeWorkspaceId) {
      window.electronAPI.setSessionModel(sessionId, activeWorkspaceId, model, connection)
    }
  }, [sessionId, activeWorkspaceId])

  // Session connection change handler - explicit switch, allowed at any point in
  // the session (the backend rebuilds its runtime for the new provider)
  const handleConnectionChange = React.useCallback(async (connectionSlug: string) => {
    try {
      await window.electronAPI.sessionCommand(sessionId, { type: 'setConnection', connectionSlug })
    } catch (error) {
      // Connection change may fail if the connection is invalid or its credentials are gone
      console.error('Failed to change connection:', error)
    }
  }, [sessionId])

  // Check if session's locked connection has been removed
  const connectionUnavailable = React.useMemo(() =>
    isSessionConnectionUnavailable(session?.llmConnection, llmConnections),
    [session?.llmConnection, llmConnections]
  )

  // Effective model for this session (session-specific or global fallback)
  const effectiveModel = React.useMemo(() => {
    if (session?.model) return session.model

    // When connection is unavailable, don't resolve through a different connection
    if (connectionUnavailable) return session?.model ?? ''

    const connectionSlug = resolveEffectiveConnectionSlug(
      session?.llmConnection, workspaceDefaultLlmConnection, llmConnections
    )
    const connection = connectionSlug ? llmConnections.find(c => c.slug === connectionSlug) : null

    return connection?.defaultModel ?? ''
  }, [session?.id, session?.model, session?.llmConnection, workspaceDefaultLlmConnection, llmConnections, connectionUnavailable])

  // Working directory for this session
  const workingDirectory = session?.workingDirectory
  const activeWorkspace = React.useMemo(
    () => workspaces.find((w) => w.id === activeWorkspaceId) || null,
    [workspaces, activeWorkspaceId]
  )
  const handleWorkingDirectoryChange = React.useCallback(async (path: string) => {
    if (!session) return
    await window.electronAPI.sessionCommand(session.id, { type: 'updateWorkingDirectory', dir: path })
  }, [session])

  const handleOpenFile = React.useCallback(
    async (path: string) => {
      // Resolve bare relative paths against session working directory,
      // or workspace root as a fallback when workingDirectory is not set.
      const resolved = (() => {
        // Absolute paths (POSIX `/…`, Windows `C:\…`) and `~/…` are used as-is.
        // Using a cross-platform check here fixes Windows preview failures where a
        // `C:\…` path was wrongly treated as relative and re-prefixed with the
        // workspace root, producing a doubled, non-existent path (#922/#875).
        if (isAbsolutePath(path) || path.startsWith('~/')) return path

        const baseDir = workingDirectory || activeWorkspace?.rootPath
        if (!baseDir) return path

        const cleanedBase = baseDir.replace(/\/+$/, '')
        const cleanedPath = path.replace(/^\.\//, '')
        return `${cleanedBase}/${cleanedPath}`
      })()

      // Smart fallback for missing files in AI output:
      // if the exact path doesn't exist, search nearby for same basename
      // (e.g. markdown/linkify.test.ts -> markdown/__tests__/linkify.test.ts).
      if (isAbsolutePath(resolved)) {
        // Backslash-aware so the fallback also runs for `C:\…` paths (#922)
        const lastSlash = Math.max(resolved.lastIndexOf('/'), resolved.lastIndexOf('\\'))
        if (lastSlash > 0 && lastSlash < resolved.length - 1) {
          const parentDir = resolved.slice(0, lastSlash)
          const fileName = resolved.slice(lastSlash + 1)
          try {
            const matches = await window.electronAPI.searchFiles(parentDir, fileName)
            const files = matches.filter((m) => m.type === 'file' && m.name === fileName)
            const exact = files.find((m) => m.path === resolved)
            if (exact) {
              onOpenFile(exact.path)
              return
            }

            if (files.length === 1) {
              onOpenFile(files[0].path)
              toast.info(t('chat.openedClosestMatch', { path: files[0].relativePath }))
              return
            }
          } catch {
            // Search fallback is best-effort; proceed with original resolved path.
          }
        }
      }

      onOpenFile(resolved)
    },
    [onOpenFile, workingDirectory, activeWorkspace?.rootPath]
  )

  const handleOpenUrl = React.useCallback(
    (url: string) => {
      // The conversation is the context the click came from: it names the browser profile
      // the page opens in, so a link in this chat lands in this chat's own window.
      onOpenUrl(url, sessionId)
    },
    [onOpenUrl, sessionId]
  )

  // Perf: Mark when data is ready
  const dataReadyMarkedRef = React.useRef<string | null>(null)
  React.useLayoutEffect(() => {
    if (messageLoadState.messagesReady && session && dataReadyMarkedRef.current !== sessionId) {
      dataReadyMarkedRef.current = sessionId
      rendererPerf.markSessionSwitch(sessionId, 'data.ready')
    }
  }, [sessionId, messageLoadState.messagesReady, session])

  // Perf: Mark render complete after paint
  React.useEffect(() => {
    if (session) {
      const rafId = requestAnimationFrame(() => {
        rendererPerf.endSessionSwitch(sessionId)
      })
      return () => cancelAnimationFrame(rafId)
    }
  }, [sessionId, session])

  // Get display title for header - use getSessionTitle for consistent fallback logic with SessionList
  // Priority: name > first user message > preview > "New chat"
  const displayTitle = session ? getSessionTitle(session) : (sessionMeta ? getSessionTitle(sessionMeta) : t('chat.session'))
  const isFlagged = session?.isFlagged || sessionMeta?.isFlagged || false
  const isArchived = session?.isArchived || sessionMeta?.isArchived || false
  const sharedUrl = session?.sharedUrl || sessionMeta?.sharedUrl || null
  const currentSessionStatus = session?.sessionStatus || sessionMeta?.sessionStatus || 'todo'
  const hasMessages = !!(session?.messages?.length || sessionMeta?.lastFinalMessageId)
  const hasUnreadMessages = sessionMeta
    ? !!(sessionMeta.lastFinalMessageId && sessionMeta.lastFinalMessageId !== sessionMeta.lastReadMessageId)
    : false
  // Use isAsyncOperationOngoing for shimmer effect (sharing, updating share, revoking, title regeneration)
  const isAsyncOperationOngoing = session?.isAsyncOperationOngoing || sessionMeta?.isAsyncOperationOngoing || false

  /**
   * Hand this conversation to Craft Bot.
   *
   * What travels is the title, the id and one excerpt of the last reply — enough for the
   * assistant to know what this was and to go read it, and short enough that the sentence the
   * person is about to write still fits on screen. Nothing is sent: the brief lands in the Bot's
   * composer and waits.
   */
  const handleHandOffToBot = React.useCallback(() => {
    const lastText = [...(session?.messages ?? [])]
      .reverse()
      .find(m => m.role === 'assistant' && !m.isThinking && typeof m.content === 'string' && m.content.trim())
      ?.content
    void onHandOffToBot?.(buildHandoffBrief({
      kind: 'conversation',
      title: displayTitle,
      workspaceName: activeWorkspace?.name ?? '',
      sessionId,
      lastText,
    }))
  }, [activeWorkspace?.name, displayTitle, onHandOffToBot, session?.messages, sessionId])

  // Rename dialog state
  const [renameDialogOpen, setRenameDialogOpen] = React.useState(false)
  const [renameName, setRenameName] = React.useState('')

  // Session action handlers
  const handleRename = React.useCallback(() => {
    setRenameName(displayTitle)
    setRenameDialogOpen(true)
  }, [displayTitle])

  const handleRenameSubmit = React.useCallback(() => {
    if (renameName.trim() && renameName.trim() !== displayTitle) {
      onRenameSession(sessionId, renameName.trim())
    }
    setRenameDialogOpen(false)
  }, [sessionId, renameName, displayTitle, onRenameSession])

  const handleFlag = React.useCallback(() => {
    onFlagSession(sessionId)
  }, [sessionId, onFlagSession])

  const handleUnflag = React.useCallback(() => {
    onUnflagSession(sessionId)
  }, [sessionId, onUnflagSession])

  const handleArchive = React.useCallback(() => {
    onArchiveSession(sessionId)
  }, [sessionId, onArchiveSession])

  const handleUnarchive = React.useCallback(() => {
    onUnarchiveSession(sessionId)
  }, [sessionId, onUnarchiveSession])

  const handleMarkUnread = React.useCallback(() => {
    onMarkSessionUnread(sessionId)
  }, [sessionId, onMarkSessionUnread])

  const handleSessionStatusChange = React.useCallback((state: string) => {
    onSessionStatusChange(sessionId, state)
  }, [sessionId, onSessionStatusChange])

  const handleLabelsChange = React.useCallback((newLabels: string[]) => {
    onSessionLabelsChange?.(sessionId, newLabels)
  }, [sessionId, onSessionLabelsChange])

  // Task orchestrator sessions (spec-backed, top-level) get an "Edit task" header action
  // that opens the board's full-pane Task editor prefilled from task.yaml — the same
  // surface as creation, so goal/acceptance criteria/subtasks can change and the whole
  // task can be re-run (Save & Run mints a fresh Conductor run).
  const taskSlug = sessionMeta?.taskSlug
  const isTaskOrchestrator = !!taskSlug && !sessionMeta?.parentSessionId
  const setKanbanEditorTarget = useSetAtom(kanbanEditorTargetAtom)
  const handleEditTask = React.useCallback(() => {
    if (!taskSlug) return
    setKanbanEditorTarget({
      mode: 'edit',
      sessionId,
      taskSlug,
      initialTitle: sessionMeta ? getSessionTitle(sessionMeta) : undefined,
    })
    navigate(routes.view.board())
  }, [taskSlug, sessionId, sessionMeta, setKanbanEditorTarget])

  const handleDelete = React.useCallback(async () => {
    await onDeleteSession(sessionId)
  }, [sessionId, onDeleteSession])

  const handleOpenInNewWindow = React.useCallback(async () => {
    const route = routes.view.allSessions(sessionId)
    const separator = route.includes('?') ? '&' : '?'
    const url = `craftagents://${route}${separator}window=focused`
    try {
      await window.electronAPI?.openUrl(url)
    } catch (error) {
      console.error('[ChatPage] openUrl failed:', error)
    }
  }, [sessionId])

  // Share action handlers
  const compactInfoButton = React.useMemo(() => {
    if (!isCompactMode || !sessionMeta) return undefined

    return (
      <SessionInfoPopover
        sessionId={sessionId}
        sessionFolderPath={session?.sessionFolderPath}
        presentation="drawer"
        trigger={(
          <PanelHeaderCenterButton
            icon={<Info className="h-4 w-4" />}
            aria-label={t("chat.sessionInfo")}
          />
        )}
      />
    )
  }, [isCompactMode, sessionId, session?.sessionFolderPath, sessionMeta])

  // Pencil opens the Task editor for orchestrator sessions; rendered before the
  // share/info action. The slot div has no gap of its own, so compose with one here.
  const editTaskButton = React.useMemo(() => {
    if (!isTaskOrchestrator) return undefined
    return (
      <PanelHeaderCenterButton
        icon={<Pencil className="h-4 w-4" />}
        tooltip={t('kanban.editTask')}
        onClick={handleEditTask}
      />
    )
  }, [isTaskOrchestrator, handleEditTask, t])

  // One button opens and closes the project panel. The conversation stays where it is; opening the
  // panel is not a mode change, so there is no third state to cycle through. Only the focused pane
  // owns the panel, so only it carries the control — an unfocused pane would be toggling a panel
  // it does not render.
  const canvasLayoutButton = sessionProjectId && isFocusedPanel !== false ? (
    <PanelHeaderCenterButton
      icon={
        canvasLayoutMode === 'split'
          ? <PanelRightClose className="h-4 w-4" />
          : <PanelRight className="h-4 w-4" />
      }
      tooltip={
        canvasLayoutMode === 'split'
          ? t('chat.panelClose')
          : t('chat.panelOpen')
      }
      aria-label={t('chat.layoutToggle')}
      onClick={() => setCanvasLayoutMode(nextCanvasLayout(canvasLayoutMode))}
    />
  ) : undefined

  // The share button used to sit here. Sharing a conversation is still reachable from the session
  // menu; the header keeps its room for the things a person does while reading one.
  const primaryHeaderAction = isCompactMode ? compactInfoButton : undefined
  // An assistant brings its own cluster, and nothing of the session furniture rides along with it.
  const headerActions = (
    <div className="flex items-center gap-1.5">
      {assistantHeader ? assistantHeader.actions : (
        <>
          {editTaskButton}
          {canvasLayoutButton}
          {primaryHeaderAction}
        </>
      )}
    </div>
  )


  // Projects for the title menu's Projects submenu. Read from the atom AppShell already
  // fills via `useProjects` rather than calling the hook here: a second call would mean a
  // second fetch and a second `projects:changed` subscription for the same list.
  const projects = useAtomValue(projectsAtom)
  const projectMenuOptions = React.useMemo(
    () => projects.map(p => ({ id: p.config.id, slug: p.config.slug, name: p.config.name })),
    [projects],
  )
  const handleSetProjectId = React.useCallback(async (projectId: string | null) => {
    if (!session) return
    await window.electronAPI.sessionCommand(session.id, { type: 'setProjectId', projectId })
  }, [session])

  // Build title menu content for chat sessions using shared SessionMenu.
  // Desktop uses Radix DropdownMenu via PanelHeader; compact mode uses a
  // vaul Drawer (CompactSessionMenu) so submenus aren't clipped by the
  // panel container query on narrow viewports.
  const titleMenu = React.useMemo(() => (sessionMeta && !isCompactMode) ? (
    <SessionMenu
      item={sessionMeta}
      sessionStatuses={sessionStatuses ?? []}
      labels={labels ?? []}
      onLabelsChange={handleLabelsChange}
      projects={projectMenuOptions}
      onSetProjectId={handleSetProjectId}
      onRename={handleRename}
      onFlag={handleFlag}
      onUnflag={handleUnflag}
      onArchive={handleArchive}
      onUnarchive={handleUnarchive}
      onMarkUnread={handleMarkUnread}
      onSessionStatusChange={handleSessionStatusChange}
      onOpenInNewWindow={handleOpenInNewWindow}
      onHandOffToBot={onHandOffToBot && session?.role !== 'bot' ? handleHandOffToBot : undefined}
      onDelete={handleDelete}
    />
  ) : null, [
    sessionMeta,
    session?.role,
    isCompactMode,
    sessionStatuses,
    labels,
    handleLabelsChange,
    projectMenuOptions,
    handleSetProjectId,
    handleRename,
    handleFlag,
    handleUnflag,
    handleArchive,
    handleUnarchive,
    handleMarkUnread,
    handleSessionStatusChange,
    handleOpenInNewWindow,
    handleHandOffToBot,
    onHandOffToBot,
    handleDelete,
  ])

  const compactTitleMenu = React.useMemo(() => (sessionMeta && isCompactMode) ? (
    <CompactSessionMenu
      title={displayTitle}
      isRegeneratingTitle={isAsyncOperationOngoing}
      item={sessionMeta}
      sessionStatuses={sessionStatuses ?? []}
      labels={labels ?? []}
      onLabelsChange={handleLabelsChange}
      projects={projectMenuOptions}
      onSetProjectId={handleSetProjectId}
      onRename={handleRename}
      onFlag={handleFlag}
      onUnflag={handleUnflag}
      onArchive={handleArchive}
      onUnarchive={handleUnarchive}
      onMarkUnread={handleMarkUnread}
      onSessionStatusChange={handleSessionStatusChange}
      onOpenInNewWindow={handleOpenInNewWindow}
      onDelete={handleDelete}
    />
  ) : null, [
    sessionMeta,
    isCompactMode,
    displayTitle,
    isAsyncOperationOngoing,
    sessionStatuses,
    labels,
    handleLabelsChange,
    projectMenuOptions,
    handleSetProjectId,
    handleRename,
    handleFlag,
    handleUnflag,
    handleArchive,
    handleUnarchive,
    handleMarkUnread,
    handleSessionStatusChange,
    handleOpenInNewWindow,
    handleDelete,
  ])

  // The title is a menu trigger only when there is a menu — and for the assistant that menu holds
  // its own verbs rather than a conversation's.
  const headerTitle = assistantHeader ? assistantHeader.menu : titleMenu
  const headerCompactTitle = assistantHeader ? undefined : compactTitleMenu

  // Handle missing session - loading or deleted
  if (!session) {
    if (sessionMeta) {
      // Session exists in metadata but not loaded yet - show loading state
      const skeletonSession = {
        id: sessionMeta.id,
        workspaceId: sessionMeta.workspaceId,
        workspaceName: '',
        name: sessionMeta.name,
        preview: sessionMeta.preview,
        lastMessageAt: sessionMeta.lastMessageAt || 0,
        messages: [],
        isProcessing: sessionMeta.isProcessing || false,
        isFlagged: sessionMeta.isFlagged,
        workingDirectory: sessionMeta.workingDirectory,
        enabledSourceSlugs: sessionMeta.enabledSourceSlugs,
      }

      return (
        <>
          <div className="h-full flex flex-col">
            <PanelHeader  title={displayTitle} badge={assistantHeader?.badge} titleMenu={headerTitle} compactTitleMenu={headerCompactTitle} leadingAction={leadingAction} actions={headerActions} rightSidebarButton={rightSidebarButton} isRegeneratingTitle={isAsyncOperationOngoing} />
            <div className="flex-1 flex flex-col min-h-0">
              <ChatDisplay
                ref={chatDisplayRef}
                session={skeletonSession}
                onLoadOlderMessages={handleLoadOlderMessages}
                onLoadQuestions={handleLoadQuestions}
                onSearchMessages={handleSearchMessages}
                onRevealMessage={handleRevealMessage}
                onSendMessage={() => {}}
                onOpenFile={handleOpenFile}
                onOpenUrl={handleOpenUrl}
                currentModel={effectiveModel}
                onModelChange={handleModelChange}
                onConnectionChange={handleConnectionChange}
                pendingPermission={undefined}
                onRespondToPermission={onRespondToPermission}
                pendingCredential={undefined}
                onRespondToCredential={onRespondToCredential}
                thinkingLevel={sessionOpts.thinkingLevel}
                onThinkingLevelChange={(level) => setOption('thinkingLevel', level)}
                permissionMode={sessionOpts.permissionMode}
                previousPermissionMode={sessionOpts.previousPermissionMode}
                onPermissionModeChange={setPermissionMode}
                enabledModes={enabledModes}
                inputValue={inputValue}
                onInputChange={handleInputChange}
                attachmentsValue={attachmentsValue}
                onAttachmentsChange={handleAttachmentsChange}
                sources={enabledSources}
                skills={skills}
                sessionStatuses={sessionStatuses}
                onSessionStatusChange={handleSessionStatusChange}
                workspaceId={activeWorkspaceId || undefined}
                onSourcesChange={(slugs) => onSessionSourcesChange?.(sessionId, slugs)}
                workingDirectory={sessionMeta.workingDirectory}
                onWorkingDirectoryChange={handleWorkingDirectoryChange}
                messagesLoading={messageLoadState.messagesLoading || (messagesRetrying && !messageLoadState.messagesReady)}
                messagesLoadError={messageLoadState.error}
                messagesRetrying={messagesRetrying}
                onRetryMessagesLoad={handleRetryMessagesLoad}
                searchQuery={sessionListSearchQuery}
                isSearchModeActive={isSearchModeActive}
                onMatchInfoChange={onChatMatchInfoChange}
                connectionUnavailable={connectionUnavailable}
                compactMode={!!isCompactMode}
                enableCompactModelPicker={!!isCompactMode}
              />
            </div>
          </div>
          <RenameDialog
            open={renameDialogOpen}
            onOpenChange={setRenameDialogOpen}
            title={t('chat.renameSession')}
            value={renameName}
            onValueChange={setRenameName}
            onSubmit={handleRenameSubmit}
            placeholder={t('chat.enterSessionName')}
          />
        </>
      )
    }

    // Session truly doesn't exist
    return (
      <div className="h-full flex flex-col">
        <PanelHeader  title={t('chat.session')} leadingAction={leadingAction} rightSidebarButton={rightSidebarButton} />
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-muted-foreground">
          <AlertCircle className="h-10 w-10" />
          <p className="text-sm">{t('chat.sessionNoLongerExists')}</p>
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="h-full flex flex-col">
        <PanelHeader  title={displayTitle} badge={assistantHeader?.badge ?? (
          <ConversationSuffix
            sessionId={session.id}
            conversationId={session.conversationId}
          />
        )} titleMenu={headerTitle} compactTitleMenu={headerCompactTitle} leadingAction={leadingAction} actions={headerActions} rightSidebarButton={rightSidebarButton} isRegeneratingTitle={isAsyncOperationOngoing} />
        <div className="flex-1 flex flex-col min-h-0">
          <ChatDisplay
            ref={chatDisplayRef}
            session={session}
            onLoadOlderMessages={handleLoadOlderMessages}
            onLoadQuestions={handleLoadQuestions}
            onSearchMessages={handleSearchMessages}
            onRevealMessage={handleRevealMessage}
            onSendMessage={(message, attachments, skillSlugs) => {
              if (session) {
                onSendMessage(session.id, message, attachments, skillSlugs)
              }
            }}
            onOpenFile={handleOpenFile}
            onOpenUrl={handleOpenUrl}
            currentModel={effectiveModel}
            onModelChange={handleModelChange}
            onConnectionChange={handleConnectionChange}
            pendingPermission={pendingPermission}
            onRespondToPermission={onRespondToPermission}
            pendingCredential={pendingCredential}
            onRespondToCredential={onRespondToCredential}
            thinkingLevel={sessionOpts.thinkingLevel}
            onThinkingLevelChange={(level) => setOption('thinkingLevel', level)}
            permissionMode={sessionOpts.permissionMode}
            previousPermissionMode={sessionOpts.previousPermissionMode}
            onPermissionModeChange={setPermissionMode}
            enabledModes={enabledModes}
            inputValue={inputValue}
            onInputChange={handleInputChange}
            attachmentsValue={attachmentsValue}
            onAttachmentsChange={handleAttachmentsChange}
            sources={enabledSources}
            skills={skills}
            labels={isAssistant ? undefined : labels}
            onLabelsChange={isAssistant ? undefined : (newLabels) => onSessionLabelsChange?.(sessionId, newLabels)}
            sessionStatuses={isAssistant ? undefined : sessionStatuses}
            onSessionStatusChange={isAssistant ? undefined : handleSessionStatusChange}
            workspaceId={activeWorkspaceId || undefined}
            onSourcesChange={(slugs) => onSessionSourcesChange?.(sessionId, slugs)}
            workingDirectory={workingDirectory}
            onWorkingDirectoryChange={isAssistant ? undefined : handleWorkingDirectoryChange}
            // The one line of text that keeps saying what this thing is for: it dispatches work,
            // it does not only chat. The session composer's rotating hints are about the composer.
            {...(isAssistant ? { placeholder: [t('bot.composerPlaceholder', { defaultValue: 'Ask it to do something in this workspace…' })] } : {})}
            sessionFolderPath={session?.sessionFolderPath}
            messagesLoading={messageLoadState.messagesLoading || (messagesRetrying && !messageLoadState.messagesReady)}
            messagesLoadError={messageLoadState.error}
            messagesRetrying={messagesRetrying}
            onRetryMessagesLoad={handleRetryMessagesLoad}
            searchQuery={sessionListSearchQuery}
            isSearchModeActive={isSearchModeActive}
            onMatchInfoChange={onChatMatchInfoChange}
            connectionUnavailable={connectionUnavailable}
            compactMode={!!isCompactMode}
            enableCompactModelPicker={!!isCompactMode}
          />
        </div>
      </div>
      <RenameDialog
        open={renameDialogOpen}
        onOpenChange={setRenameDialogOpen}
        title={t('chat.renameSession')}
        value={renameName}
        onValueChange={setRenameName}
        onSubmit={handleRenameSubmit}
        placeholder={t('chat.enterSessionName')}
      />
    </>
  )
})

export default ChatPage
