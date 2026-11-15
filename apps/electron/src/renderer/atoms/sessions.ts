/**
 * Per-Session State Management with Jotai
 *
 * Uses atomFamily to create isolated atoms per session.
 * Updates to one session don't trigger re-renders in other sessions.
 *
 * This solves the performance issue where streaming in Session A
 * caused re-renders and focus loss in Session B.
 */

import { atom } from 'jotai'
import type { Getter, Setter } from 'jotai/vanilla'
import { atomFamily } from 'jotai-family'
// Direct path, not the sessions barrel: the barrel also exports disk and
// agent plumbing that must never enter the renderer bundle.
import { SESSION_MESSAGE_PAGE_SIZE } from '@craft-agent/shared/sessions/message-page'
import type { Session, Message, SessionMode } from '../../shared/types'

/**
 * Session metadata for list display (lightweight, no messages)
 * Used by SessionList to avoid re-rendering on message changes
 */
export interface SessionMeta {
  id: string
  name?: string
  /** Preview of first user message (for title fallback) */
  preview?: string
  workspaceId: string
  lastMessageAt?: number
  isProcessing?: boolean
  isFlagged?: boolean
  lastReadMessageId?: string
  workingDirectory?: string
  enabledSourceSlugs?: string[]
  /** Shared viewer URL (if shared via viewer) */
  sharedUrl?: string
  /** Shared session ID in viewer (for revoke) */
  sharedId?: string
  /** ID of the last final (non-intermediate) assistant message - for unread detection */
  lastFinalMessageId?: string
  /**
   * Explicit unread flag - single source of truth for NEW badge.
   * Set to true when assistant message completes while user is NOT viewing.
   * Set to false when user views the session (and not processing).
   */
  hasUnread?: boolean
  /** Labels for filtering (additive tags, many-per-session) */
  labels?: string[]
  /** The layer this conversation is working in (only meaningful inside its project; prompt-block only) */
  mode?: SessionMode
  /** Permission mode ('safe', 'ask', 'guarded', 'allow-all') — used by view expressions */
  permissionMode?: string
  /** Session status for filtering */
  sessionStatus?: string
  /** Role/type of the last message (for badge display without loading messages) */
  lastMessageRole?: 'user' | 'assistant' | 'plan' | 'tool' | 'error'
  /** Whether an async operation is ongoing (sharing, updating share, revoking, title regeneration) */
  isAsyncOperationOngoing?: boolean
  /** @deprecated Use isAsyncOperationOngoing instead */
  isRegeneratingTitle?: boolean
  /** Model override for this session */
  model?: string
  /** LLM connection slug for this session */
  llmConnection?: string
  /** Token usage stats (from JSONL header, available without loading messages) */
  tokenUsage?: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    costUsd: number
    contextTokens: number
  }
  /** When the session was created (ms timestamp) */
  createdAt?: number
  /** Total number of messages in this session */
  messageCount?: number
  /** When true, session is hidden from session list (e.g., mini edit sessions, the assistant) */
  hidden?: boolean
  /** `bot` for the assistant's own conversation; absent for ordinary ones. */
  role?: 'bot'
  /** Whether this session is archived */
  isArchived?: boolean
  /** Timestamp when session was archived (for retention policy) */
  archivedAt?: number
  /** Workspace-scoped project id this session is bound to (undefined = unbound) */
  projectId?: string
  /** Parent session id — when set, this session is a subtask of the parent (undefined = top-level task) */
  parentSessionId?: string
  /** Kanban board column id ('todo' | 'in-progress' | 'done'); independent of sessionStatus */
  kanbanColumn?: string
  /** Tasks Conductor: slug of the task spec this session belongs to (orchestrator + child nodes) */
  taskSlug?: string
  /** Tasks Conductor: id of the run that spawned this child session (Conductor-owned children only) */
  taskRunId?: string
  /** Tasks Conductor: id of the DAG node this child session executes (Conductor-owned children only) */
  taskNodeId?: string
  /** Tasks Conductor: total DAG node count (orchestrator only) — stable board progress denominator while children spawn lazily */
  taskNodeCount?: number
  /** Tasks Conductor: how many `kind: approval` gates of the active run are waiting on a person */
  taskAwaitingApproval?: number
  /** Tasks Conductor: a generate-time draft orchestrator, hidden from the board until adopted by createTask. */
  taskDraft?: boolean
}

/**
 * Find the last final (non-intermediate) assistant or plan message ID
 */
function findLastFinalMessageId(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    // Include plan messages as final responses (they're AI-generated content)
    if ((msg.role === 'assistant' || msg.role === 'plan') && !msg.isIntermediate) {
      return msg.id
    }
  }
  return undefined
}

/**
 * Extract metadata from a full session object
 */
export function extractSessionMeta(session: Session): SessionMeta {
  const messages = session.messages || []

  // Destructure fields that don't exist on SessionMeta or need overrides
  const {
    messages: _msgs, sessionFolderPath: _sf, supportsBranching: _sb,
    workspaceName: _wn, thinkingLevel: _tl, currentStatus: _cs,
    isAsyncOperationOngoing, isRegeneratingTitle,
    messageCount, lastFinalMessageId: sessionLastFinal,
    ...sessionFields
  } = session

  return {
    ...sessionFields,
    lastFinalMessageId: sessionLastFinal ?? findLastFinalMessageId(messages),
    // Math.max, not ??: streaming appends grow `messages` without touching the
    // session's `messageCount` field, so a defined-but-stale count (stamped at
    // load/creation) must never shadow the live length. Meta-only sessions
    // (empty `messages`) keep the server/header count.
    messageCount: Math.max(messageCount ?? 0, messages.length),
    isAsyncOperationOngoing: isAsyncOperationOngoing ?? isRegeneratingTitle,
    isRegeneratingTitle,
  } as SessionMeta
}

/**
 * Atom family for individual session state
 * Each session gets its own atom - updates are isolated
 */
export const sessionAtomFamily = atomFamily(
  (_sessionId: string) => atom<Session | null>(null),
  (a, b) => a === b
)

/**
 * Atom for session metadata map (for list display)
 * Only contains lightweight data needed for SessionList
 */
export const sessionMetaMapAtom = atom<Map<string, SessionMeta>>(new Map())

/**
 * Derived atom: ordered list of session IDs (for list ordering)
 */
export const sessionIdsAtom = atom<string[]>([])

/**
 * Track which sessions have had their messages loaded (for lazy loading)
 * Sessions are loaded with empty messages initially, messages are fetched on-demand
 */
export const loadedSessionsAtom = atom<Set<string>>(new Set<string>())

/**
 * Promise cache for deduplicating concurrent session load requests.
 * Prevents race condition where multiple calls (e.g., from React re-renders)
 * start loading before the first completes and marks the session as loaded.
 * Module-level map since it tracks in-flight promises, not React state.
 */
const sessionLoadingPromises = new Map<string, Promise<Session | null>>()

/**
 * Currently active session ID - the session displayed in the main content area
 * This replaces the tab-based session selection
 */
export const activeSessionIdAtom = atom<string | null>(null)

// NOTE: sessionsAtom REMOVED to fix memory leak
// The sessions array with messages was being retained by Jotai's internal state.
// Instead, we now use:
// - sessionMetaMapAtom for listing (lightweight metadata, no messages)
// - sessionAtomFamily(id) for individual session data
// - initializeSessionsAtom for bulk initialization
// - addSessionAtom, removeSessionAtom for individual operations

/**
 * Action atom: update a single session
 * Only triggers re-render in components subscribed to this specific session
 */
export const updateSessionAtom = atom(
  null,
  (get, set, sessionId: string, updater: (prev: Session | null) => Session | null) => {
    const sessionAtom = sessionAtomFamily(sessionId)
    const currentSession = get(sessionAtom)
    const newSession = updater(currentSession)
    set(sessionAtom, newSession)

    // Also update metadata if session exists
    if (newSession) {
      const metaMap = get(sessionMetaMapAtom)
      const newMetaMap = new Map(metaMap)
      newMetaMap.set(sessionId, extractSessionMeta(newSession))
      set(sessionMetaMapAtom, newMetaMap)
    }
  }
)

/**
 * Action atom: update only session metadata (for list display updates)
 * Doesn't affect the full session atom
 */
export const updateSessionMetaAtom = atom(
  null,
  (get, set, sessionId: string, updates: Partial<SessionMeta>) => {
    const metaMap = get(sessionMetaMapAtom)
    const existing = metaMap.get(sessionId)
    if (existing) {
      const newMetaMap = new Map(metaMap)
      newMetaMap.set(sessionId, { ...existing, ...updates })
      set(sessionMetaMapAtom, newMetaMap)
    }
  }
)

/**
 * Action atom: replace a session with an authoritative full session payload.
 *
 * Use this for data returned by getSessionMessages() or createSession(), where
 * the `messages` array is known to represent the loaded transcript. Keeping the
 * full session atom and loadedSessionsAtom in one write prevents the chat panel
 * from hiding real messages behind a stale lazy-loading spinner.
 */
export const replaceLoadedSessionAtom = atom(
  null,
  (get, set, session: Session) => {
    set(sessionAtomFamily(session.id), session)

    const metaMap = get(sessionMetaMapAtom)
    const newMetaMap = new Map(metaMap)
    newMetaMap.set(session.id, extractSessionMeta(session))
    set(sessionMetaMapAtom, newMetaMap)

    const loadedSessions = get(loadedSessionsAtom)
    if (!loadedSessions.has(session.id)) {
      const newLoadedSessions = new Set(loadedSessions)
      newLoadedSessions.add(session.id)
      set(loadedSessionsAtom, newLoadedSessions)
    }
  }
)

/**
 * Action atom: append message to session (for streaming)
 * Optimized to only update the specific session
 * Note: Does NOT update lastMessageAt - caller must handle timestamp updates
 * to avoid session list jumping on intermediate/tool messages
 */
export const appendMessageAtom = atom(
  null,
  (get, set, sessionId: string, message: Message) => {
    const sessionAtom = sessionAtomFamily(sessionId)
    const session = get(sessionAtom)
    if (session) {
      set(sessionAtom, {
        ...session,
        messages: [...session.messages, message],
        // Don't update lastMessageAt here - only user messages and final responses should update it
      })
    }
  }
)

/**
 * Action atom: update streaming content for a session
 * For text_delta events - appends to the last streaming message
 */
export const updateStreamingContentAtom = atom(
  null,
  (get, set, sessionId: string, content: string, turnId?: string) => {
    const sessionAtom = sessionAtomFamily(sessionId)
    const session = get(sessionAtom)
    if (!session) return

    const messages = [...session.messages]
    const lastMsg = messages[messages.length - 1]

    // Append to existing streaming message
    if (lastMsg?.role === 'assistant' && lastMsg.isStreaming &&
        (!turnId || lastMsg.turnId === turnId)) {
      messages[messages.length - 1] = {
        ...lastMsg,
        content: lastMsg.content + content,
      }
      set(sessionAtom, { ...session, messages })
    }
  }
)

/**
 * Action atom: initialize sessions from loaded data
 */
export const initializeSessionsAtom = atom(
  null,
  (get, set, sessions: Session[]) => {
    // Clean up stale atom family entries from previous workspace.
    // Without this, switching workspaces leaves orphaned atoms in memory
    // and components subscribed to old session IDs see stale/empty data.
    const oldIds = get(sessionIdsAtom)
    const newIdSet = new Set(sessions.map(s => s.id))
    for (const oldId of oldIds) {
      if (!newIdSet.has(oldId)) {
        sessionAtomFamily.remove(oldId)
        backgroundTasksAtomFamily.remove(oldId)
      }
    }
    // Reset loaded sessions tracking — new workspace needs fresh lazy loading
    set(loadedSessionsAtom, new Set<string>())

    // Set individual session atoms
    for (const session of sessions) {
      set(sessionAtomFamily(session.id), session)
    }

    // Build metadata map
    const metaMap = new Map<string, SessionMeta>()
    for (const session of sessions) {
      metaMap.set(session.id, extractSessionMeta(session))
    }
    set(sessionMetaMapAtom, metaMap)

    // Set ordered IDs (sorted by lastMessageAt desc)
    const ids = sessions
      .sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0))
      .map(s => s.id)
    set(sessionIdsAtom, ids)

    // NOTE: Do NOT mark sessions as loaded here
    // Sessions from getSessions() have empty messages: [] to save memory
    // Messages are lazy-loaded via ensureSessionMessagesLoadedAtom when session is opened
    // This reduces initial memory usage from ~500MB to ~50MB for 300+ sessions
  }
)

/**
 * Action atom: refresh session metadata after a stale reconnect.
 *
 * Unlike initializeSessionsAtom (which resets everything for workspace switches),
 * this preserves messages for already-loaded sessions and only marks overwritten
 * metadata-only sessions as unloaded for lazy re-fetching.
 *
 * All cross-atom mutations happen inside a single write transaction so that
 * React subscribers see one consistent update instead of intermediate states.
 */
export const refreshSessionsMetadataAtom = atom(
  null,
  (
    get,
    set,
    payload: { sessions: Session[]; loadedSessionIds: Set<string>; removeMissing?: boolean }
  ): Map<string, SessionMeta> => {
    const { sessions, loadedSessionIds, removeMissing = true } = payload

    // Remove stale sessions only for authoritative refreshes. Stale reconnect
    // recovery can receive a transient partial list immediately after sleep/wake;
    // treating that as authoritative is what makes the sidebar collapse to the
    // single active session. In non-destructive mode we upsert returned sessions
    // and preserve missing metadata until a confirmed delete/workspace reload.
    const currentIds = get(sessionIdsAtom)
    const latestIds = new Set(sessions.map(s => s.id))
    if (removeMissing) {
      for (const staleId of currentIds) {
        if (!latestIds.has(staleId)) {
          set(removeSessionAtom, staleId)
        }
      }
    }

    // Update each session atom, preserving messages for loaded sessions
    const unloadedIds: string[] = []
    for (const session of sessions) {
      const currentSession = get(sessionAtomFamily(session.id))
      const shouldPreserveMessages = !!currentSession && loadedSessionIds.has(session.id)
      const nextSession = shouldPreserveMessages && currentSession
        ? { ...session, messages: currentSession.messages }
        : session

      set(sessionAtomFamily(session.id), nextSession)

      // Track sessions that lost their messages so lazy-loading re-fetches them
      if (!shouldPreserveMessages && loadedSessionIds.has(session.id)) {
        unloadedIds.push(session.id)
      }
    }

    // Remove overwritten sessions from loadedSessionsAtom
    if (unloadedIds.length > 0) {
      const nextLoaded = new Set(get(loadedSessionsAtom))
      for (const id of unloadedIds) nextLoaded.delete(id)
      set(loadedSessionsAtom, nextLoaded)
    }

    // Build and set metadata map. Non-destructive refresh starts from the
    // existing map so sessions omitted by a transient partial response remain
    // visible. Returned sessions are still authoritative for their own fields.
    const nextMetaMap = removeMissing
      ? new Map<string, SessionMeta>()
      : new Map(get(sessionMetaMapAtom))
    for (const session of sessions) {
      nextMetaMap.set(session.id, extractSessionMeta(session))
    }
    set(sessionMetaMapAtom, nextMetaMap)

    // Set ordered IDs from the metadata map we actually exposed to the UI.
    const nextIds = Array.from(nextMetaMap.values())
      .sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0))
      .map(s => s.id)
    set(sessionIdsAtom, nextIds)

    return nextMetaMap
  }
)

/**
 * Action atom: add a new session
 */
export const addSessionAtom = atom(
  null,
  (get, set, session: Session) => {
    // Set session atom
    set(sessionAtomFamily(session.id), session)

    // Add to metadata map
    const metaMap = get(sessionMetaMapAtom)
    const newMetaMap = new Map(metaMap)
    newMetaMap.set(session.id, extractSessionMeta(session))
    set(sessionMetaMapAtom, newMetaMap)

    // Add to beginning of IDs list
    const ids = get(sessionIdsAtom)
    set(sessionIdsAtom, [session.id, ...ids])

    // Mark as loaded (new sessions are complete - no lazy loading needed)
    const loadedSessions = get(loadedSessionsAtom)
    const newLoadedSessions = new Set(loadedSessions)
    newLoadedSessions.add(session.id)
    set(loadedSessionsAtom, newLoadedSessions)
  }
)

/**
 * Action atom: remove a session
 */
export const removeSessionAtom = atom(
  null,
  (get, set, sessionId: string) => {
    // Clear session atom value first
    set(sessionAtomFamily(sessionId), null)
    // Remove atom from family cache to allow GC of the atom and its stored value
    sessionAtomFamily.remove(sessionId)

    // Remove from metadata map
    const metaMap = get(sessionMetaMapAtom)
    const newMetaMap = new Map(metaMap)
    newMetaMap.delete(sessionId)
    set(sessionMetaMapAtom, newMetaMap)

    // Remove from IDs list
    const ids = get(sessionIdsAtom)
    set(sessionIdsAtom, ids.filter(id => id !== sessionId))

    // Remove from loaded sessions tracking
    const loadedSessions = get(loadedSessionsAtom)
    const newLoadedSessions = new Set(loadedSessions)
    newLoadedSessions.delete(sessionId)
    set(loadedSessionsAtom, newLoadedSessions)

    // Clean up additional atom families to prevent memory leaks
    // These store per-session UI state that should be garbage collected
    backgroundTasksAtomFamily.remove(sessionId)
  }
)

/**
 * Action atom: sync React state to per-session atoms
 *
 * This is the key to the hybrid approach:
 * - React state (sessions array) remains the source of truth
 * - This atom syncs changes to per-session atoms automatically
 * - Components using useSession(id) get isolated updates
 * - Jotai's referential equality prevents unnecessary re-renders
 *
 * IMPORTANT: During streaming, the atom is the source of truth.
 * Streaming events (text_delta, tool_start, tool_result) update atoms directly
 * and bypass React state for performance. We must NOT overwrite atoms for
 * sessions that are processing, or we lose streaming data (tool calls, text).
 * Once a "handoff" event (complete, error, etc.) occurs, React state catches up
 * and sync works normally again.
 */
export const syncSessionsToAtomsAtom = atom(
  null,
  (get, set, sessions: Session[]) => {
    const loadedSessions = get(loadedSessionsAtom)

    // Update each session atom
    for (const session of sessions) {
      const sessionAtom = sessionAtomFamily(session.id)
      const atomSession = get(sessionAtom)

      // CRITICAL: If the atom's session is processing, it has streaming updates
      // that React state doesn't know about yet. Don't overwrite - atom is
      // source of truth during streaming. The handoff event will reconcile.
      if (atomSession?.isProcessing) {
        continue
      }

      // CRITICAL: If session messages were lazy-loaded, atom has full messages
      // but React state may have empty array. Only skip if React would lose messages.
      // Allow sync when React has MORE messages (e.g., user just sent a message).
      if (loadedSessions.has(session.id) && atomSession) {
        const atomMessageCount = atomSession.messages?.length ?? 0
        const reactMessageCount = session.messages?.length ?? 0
        // Skip sync only if React has fewer messages (would lose data)
        if (reactMessageCount < atomMessageCount) {
          continue
        }
      }

      // Only update if the session object is different (referential check)
      // This prevents unnecessary re-renders when the session hasn't changed
      if (atomSession !== session) {
        set(sessionAtom, session)
      }
    }

    // Update metadata map for list display
    // Note: We still update metadata from React state, which is fine because
    // metadata doesn't include messages - the streaming content we're protecting
    const metaMap = new Map<string, SessionMeta>()
    for (const session of sessions) {
      const meta = extractSessionMeta(session)
      // Preserve isProcessing from atom if atom is processing
      // React state may have stale isProcessing: false during streaming
      const atomSession = get(sessionAtomFamily(session.id))
      if (atomSession?.isProcessing) {
        meta.isProcessing = true
      }
      metaMap.set(session.id, meta)
    }
    set(sessionMetaMapAtom, metaMap)

    // Update ordered IDs (preserve order from React state)
    set(sessionIdsAtom, sessions.map(s => s.id))
  }
)

// loadedSessionsAtom moved up before sessionsAtom (needed for self-syncing)

/**
 * Action atom: Load session messages if not already loaded
 * Returns the loaded session or current session if already loaded.
 * Uses promise deduplication to prevent redundant IPC calls from concurrent requests.
 *
 * IMPORTANT: This only merges messages into the existing session atom.
 * UI state fields (hasUnread, isFlagged, sessionStatus, etc.) are preserved from
 * the in-memory atom, NOT overwritten with potentially stale disk data.
 * This prevents a race condition where optimistic updates (e.g., clearing the
 * NEW badge on session view) get clobbered by async message loading that reads
 * older state from disk.
 */
async function loadSessionMessages(
  get: Getter,
  set: Setter,
  sessionId: string,
  options?: { force?: boolean },
): Promise<Session | null> {
  const force = options?.force ?? false

  if (force) {
    const nextLoadedSessions = new Set(get(loadedSessionsAtom))
    nextLoadedSessions.delete(sessionId)
    set(loadedSessionsAtom, nextLoadedSessions)

    // Clear any stale in-flight request so the caller gets a fresh fetch.
    sessionLoadingPromises.delete(sessionId)
  } else {
    const loadedSessions = get(loadedSessionsAtom)

    // Already loaded, return current session
    if (loadedSessions.has(sessionId)) {
      return get(sessionAtomFamily(sessionId))
    }
  }

  // Check if already loading - return existing promise to deduplicate concurrent calls
  const existingPromise = sessionLoadingPromises.get(sessionId)
  if (existingPromise) {
    return existingPromise
  }

  // Create the loading promise with all the fetch and update logic
  const loadPromise = (async (): Promise<Session | null> => {
    // Fetch the newest page of messages from main process.
    //
    // The server keeps the whole history (branching, compaction and retries read
    // it); what a conversation long enough to matter should not do is *carry* all
    // of it into the renderer on open. Older pages arrive as the reader scrolls
    // up — see `loadOlderSessionMessagesAtom`.
    const loadedSession = await window.electronAPI.getSessionMessages(sessionId, {
      limit: SESSION_MESSAGE_PAGE_SIZE,
      // A page that stops in the middle of a long turn is unreadable: the
      // question is off-screen, the turn has no beginning, and everything that
      // measures from the question (elapsed time, the turn rail) has nothing to
      // measure from. So the opening page carries a few questions regardless of
      // how many messages that costs.
      minQuestions: 5,
    })
    if (!loadedSession) {
      return get(sessionAtomFamily(sessionId))
    }

    // Merge messages and disk-only fields into existing session, preserving in-memory UI state.
    // The renderer's atom is authoritative for UI fields (hasUnread, isFlagged, etc.)
    // because optimistic updates may have changed them since the disk write.
    // tokenUsage and sessionFolderPath are only returned by getSession() (not getSessions()),
    // so they must be explicitly merged here to be available after app restart.
    const existingSession = get(sessionAtomFamily(sessionId))
    const preservedStaleMessages = !!existingSession
      && existingSession.messages.length > 0
      && (!loadedSession.messages || loadedSession.messages.length === 0)

    const mergedSession = existingSession
      ? {
          ...existingSession,
          // CRITICAL: Don't clobber messages if session is actively streaming
          // AND already has messages in the atom. Streaming events update the atom
          // directly and may contain messages the IPC response doesn't know about
          // (race window between IPC request and response).
          // The `messages.length > 0` guard ensures Cmd+R reload works: after reload,
          // the atom starts with messages=[] from getSessions(), so IPC response
          // (which has full history from main process memory) must be used.
          // Also guard against sleep/wake edge case: the server may return
          // empty messages if the session subprocess hasn't finished lazy-loading.
          messages: preservedStaleMessages
            ? existingSession.messages
            : existingSession.isProcessing && existingSession.messages.length > 0
              ? existingSession.messages
              : loadedSession.messages,
          // Kept in step with whichever message list won above: the flag describes
          // what the renderer is missing, so preserving the in-memory list also
          // preserves how much of the history that list is missing.
          messagesTruncated: preservedStaleMessages
            || (existingSession.isProcessing && existingSession.messages.length > 0)
            ? existingSession.messagesTruncated ?? false
            : loadedSession.messagesTruncated ?? false,
          tokenUsage: loadedSession.tokenUsage ?? existingSession.tokenUsage,
          sessionFolderPath: loadedSession.sessionFolderPath ?? existingSession.sessionFolderPath,
        }
      : loadedSession
    set(sessionAtomFamily(sessionId), mergedSession)

    // Update only lastFinalMessageId in metadata (now computable from loaded messages).
    // Don't replace the full meta entry — other fields are maintained through
    // optimistic updates and IPC events, and may be ahead of disk state.
    const lastFinalMessageId = findLastFinalMessageId(loadedSession.messages)
    if (lastFinalMessageId) {
      const metaMap = get(sessionMetaMapAtom)
      const existingMeta = metaMap.get(sessionId)
      if (existingMeta && existingMeta.lastFinalMessageId !== lastFinalMessageId) {
        const newMetaMap = new Map(metaMap)
        newMetaMap.set(sessionId, { ...existingMeta, lastFinalMessageId })
        set(sessionMetaMapAtom, newMetaMap)
      }
    }

    // Mark as loaded only when we received a fresh payload.
    // If we had to preserve stale in-memory messages because the backend returned
    // an empty array during lazy-load recovery, keep the session reloadable.
    if (!preservedStaleMessages) {
      const newLoadedSessions = new Set(get(loadedSessionsAtom))
      newLoadedSessions.add(sessionId)
      set(loadedSessionsAtom, newLoadedSessions)
    }

    return mergedSession
  })()

  // Cache the promise before awaiting
  sessionLoadingPromises.set(sessionId, loadPromise)

  try {
    return await loadPromise
  } finally {
    // Always clean up the cache, whether success or failure
    sessionLoadingPromises.delete(sessionId)
  }
}

export const ensureSessionMessagesLoadedAtom = atom(
  null,
  async (get, set, sessionId: string): Promise<Session | null> => {
    return loadSessionMessages(get, set, sessionId)
  }
)

/**
 * Action atom: fetch one more page of *older* messages for a session.
 *
 * This is the other half of paged loading. The transcript's reverse pagination
 * used to be a slice of whatever the renderer happened to hold; now that opening
 * a conversation carries only its newest page, scrolling past the oldest loaded
 * message has to ask for the page before it.
 *
 * Returns how many messages were added — 0 when the conversation is complete,
 * or when the page brought nothing this renderer did not already have — so the
 * caller can widen its turn window by exactly that much.
 */
export const loadOlderSessionMessagesAtom = atom(
  null,
  async (get, set, sessionId: string): Promise<number> => {
    const session = get(sessionAtomFamily(sessionId))
    if (!session || !session.messagesTruncated) return 0
    const oldest = session.messages[0]
    if (!oldest) return 0

    const page = await window.electronAPI.getSessionMessages(sessionId, {
      limit: SESSION_MESSAGE_PAGE_SIZE,
      before: oldest.id,
    })
    if (!page) return 0

    // Re-read after the await: a streamed token may have appended a message
    // while the page was in flight, and that append must survive.
    const current = get(sessionAtomFamily(sessionId))
    if (!current) return 0

    const known = new Set(current.messages.map(message => message.id))
    const older = page.messages.filter(message => !known.has(message.id))

    // A page that brought nothing new means the cursor no longer names a message
    // the server has (deleted, or compacted away). Keep what is on screen and
    // stop asking — otherwise the scroll handler would fetch in a loop.
    set(sessionAtomFamily(sessionId), {
      ...current,
      messages: older.length > 0 ? [...older, ...current.messages] : current.messages,
      messagesTruncated: older.length > 0 ? (page.messagesTruncated ?? false) : false,
    })

    return older.length
  }
)

/**
 * Force-refresh session messages even if the session is currently marked as loaded.
 * Used by reconnect recovery when a session atom is stuck in an empty-but-loaded state.
 */
export const forceSessionMessagesReloadAtom = atom(
  null,
  async (get, set, sessionId: string): Promise<Session | null> => {
    return loadSessionMessages(get, set, sessionId, { force: true })
  }
)

/**
 * Action atom: every question in a conversation, for the turn rail.
 *
 * Answered over the whole history — the rail has to tick questions that were
 * never loaded, or it quietly claims the conversation starts where the page does.
 */
export const sessionQuestionsAtom = atom(
  null,
  async (_get, _set, sessionId: string) => {
    return window.electronAPI.getSessionQuestions(sessionId)
  }
)

/**
 * Action atom: where `query` occurs in a conversation.
 *
 * Answered by the server over the whole history, because search is the one
 * feature that must reach text the reader cannot see — a client holding only the
 * newest page would otherwise report "0 results" for text that is plainly there.
 * One definition of "searchable" for every client, too.
 */
export const searchSessionMessagesAtom = atom(
  null,
  async (_get, _set, sessionId: string, query: string) => {
    return window.electronAPI.searchSessionMessages(sessionId, query)
  }
)

/** Reveals in flight per session, so repeated jumps do not refetch the same page. */
const revealPromises = new Map<string, Promise<boolean>>()

/**
 * Action atom: make one specific message available to the transcript.
 *
 * This is how a search hit from the middle of an unloaded history gets opened:
 * the page still ends where the client's window begins — no hole in the
 * conversation — it just starts early enough to contain the target.
 *
 * Returns whether the message is now present (false when it no longer exists).
 */
export const revealSessionMessageAtom = atom(
  null,
  async (get, set, sessionId: string, messageId: string): Promise<boolean> => {
    const existing = get(sessionAtomFamily(sessionId))
    if (!existing) return false
    if (existing.messages.some(message => message.id === messageId)) return true

    const oldest = existing.messages[0]
    if (!oldest) return false

    const key = `${sessionId}:${messageId}`
    const inFlight = revealPromises.get(key)
    if (inFlight) return inFlight

    const pending = (async () => {
      const page = await window.electronAPI.getSessionMessages(sessionId, {
        before: oldest.id,
        include: messageId,
      })
      if (!page) return false

      const current = get(sessionAtomFamily(sessionId))
      if (!current) return false

      const known = new Set(current.messages.map(message => message.id))
      const older = page.messages.filter(message => !known.has(message.id))

      set(sessionAtomFamily(sessionId), {
        ...current,
        messages: older.length > 0 ? [...older, ...current.messages] : current.messages,
        messagesTruncated: page.messagesTruncated ?? false,
      })

      return older.some(message => message.id === messageId)
    })()

    revealPromises.set(key, pending)
    try {
      return await pending
    } finally {
      revealPromises.delete(key)
    }
  }
)

/**
 * Background task for ActiveTasksBar display
 */
/**
 * Lifecycle status of a background task chip.
 * - `running`  — backgrounded, no terminal signal yet (chip shows a spinner + live elapsed).
 * - `stale` — no lifecycle signal arrived within the renderer timeout. The task may
 *   still be running, so the chip shows an unknown state and remains recoverable.
 * - `completed`/`failed`/`stopped` — a real task_completed notification arrived.
 * - `orphaned` — the turn that owned the task ended before it finished, so it was
 *   terminated with that turn's subprocess. Shown distinctly instead of a false
 *   "running". Not produced once WS2 keep-alive is enabled.
 */
export type BackgroundTaskStatus = 'running' | 'stale' | 'completed' | 'failed' | 'stopped' | 'orphaned'

export interface BackgroundTask {
  /** Task or shell ID */
  id: string
  /** Task type. 'workflow' = a fan-out Workflow launch (many sub-agents). */
  type: 'agent' | 'shell' | 'workflow'
  /** Tool use ID for correlation with messages */
  toolUseId: string
  /** Workflow run id (wf_...) — set for type 'workflow'; correlates agent-completed updates. */
  workflowId?: string
  /** Count of sub-agents that have completed so far (type 'workflow' only). */
  agentsCompleted?: number
  /** When the task started */
  startTime: number
  /** Elapsed seconds (from progress events; the chip also derives it from startTime) */
  elapsedSeconds: number
  /** Last renderer-observed lifecycle/progress signal; falls back to startTime. */
  lastSignalAt?: number
  /** Task intent/description */
  intent?: string
  /** Lifecycle status; defaults to 'running' when added */
  status: BackgroundTaskStatus
  /** ms timestamp when the task reached a terminal/orphaned status */
  completedAt?: number
  /** Output file for click-through, set when task_completed arrives */
  outputFile?: string
  /** Short summary, set when task_completed arrives */
  summary?: string
}

/**
 * Atom family for tracking active background tasks per session
 * Updated on task_backgrounded, shell_backgrounded, task_progress events
 * Cleared when tasks complete or are killed
 */
export const backgroundTasksAtomFamily = atomFamily(
  (_sessionId: string) => atom<BackgroundTask[]>([]),
  (a, b) => a === b
)

/**
 * Window's current workspace ID — shared between Root (ThemeProvider) and App.
 * Written by App on workspace switch, read by Root to keep the theme in sync.
 */
export const windowWorkspaceIdAtom = atom<string | null>(null)

/**
 * State for "Send to Workspace" dialog.
 * Set session IDs to open; clear to close.
 */
export const sendToWorkspaceAtom = atom<string[]>([])
