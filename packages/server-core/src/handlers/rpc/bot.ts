/**
 * Craft Bot RPC — one conversation, and the tasks it handed to other workspaces.
 *
 * Two decisions shape this file, and each one is why it is short:
 *
 * 1. **There is no task store.** A delegated task *is* the child session it runs in
 *    (`parentSessionId` = the assistant's conversation). `bot:tasks` is derived from
 *    `SessionManager.getSessions()`, which already holds every workspace, so the list is
 *    cross-workspace by construction and survives a restart for free.
 * 2. **It works in one workspace.** The tasks it reports on are conversations the assistant started
 *    here (`spawn_session` children), so there is no cross-workspace targeting to get wrong and no
 *    grant to keep in sync.
 *
 * What it deliberately cannot do: read or write files itself. A task's files are touched by its
 * conversation, which a person can open and read afterwards.
 */

import {
  RPC_CHANNELS,
  type BotSession,
  type BotTask,
  type BotTaskResult,
  type BotArtifact,
  type Session,
} from '@craft-agent/shared/protocol'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import { listTaskSlugs, loadTaskSpec } from '@craft-agent/shared/tasks'
import { createCreationsCache, refreshCreations, type CreationsCache } from '@craft-agent/shared/creations'
import { getTaskRunner } from '../../tasks'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

/** How much of a delegated session's last answer is echoed back to the Bot panel. */
const RESULT_TEXT_LIMIT = 4000

/** How many artifacts a task card lists before the rest live behind "open". */
const ARTIFACT_LIMIT = 6

/**
 * What a task wrote, read from the workspace's creations index.
 *
 * The index derives "which file did this turn write" from the session's own transcript, so this is
 * a **read of an existing fact**, not a record kept for the Bot: a task that ran before this panel
 * existed answers just the same. The per-task cache is keyed by `lastMessageAt`, so a card that has
 * not moved costs nothing, and the scan itself is the index's own incremental one.
 */
const creationsCaches = new Map<string, CreationsCache>()
const artifactsByTask = new Map<string, { stamp: number; items: BotArtifact[] }>()

/**
 * The creations index has to read every session in the workspace the first time anyone asks
 * (`refreshCreations`), and this workspace has 151 of them / 179 MB of transcript. That is far too
 * much to pay for a card that is not on screen — so artifacts are **opt-in**: the panel asks for
 * them when the workbench is open, and the poll behind the collapsed count never triggers a scan.
 */
const ARTIFACTS_DEFAULT = false

async function artifactsFor(session: Session): Promise<BotArtifact[]> {
  const stamp = session.lastMessageAt ?? 0
  const cached = artifactsByTask.get(session.id)
  if (cached && cached.stamp === stamp) return cached.items

  const workspace = getWorkspaceByNameOrId(session.workspaceId)
  if (!workspace) return []

  let cache = creationsCaches.get(workspace.rootPath)
  if (!cache) {
    cache = createCreationsCache()
    creationsCaches.set(workspace.rootPath, cache)
  }

  const snapshot = await refreshCreations(workspace.rootPath, cache)
  const items: BotArtifact[] = snapshot.creations
    .filter(c => c.origins.some(origin => origin.sessionId === session.id))
    .slice(0, ARTIFACT_LIMIT)
    .map(c => ({ path: c.path, title: c.title, format: c.format, exists: c.exists }))

  // Bounded: a long-lived app should not grow a map entry per conversation it ever watched.
  if (artifactsByTask.size > 200) artifactsByTask.clear()
  artifactsByTask.set(session.id, { stamp, items })
  return items
}

function taskOf(session: Session): BotTask {
  return {
    kind: 'session',
    sessionId: session.id,
    name: session.name,
    workspaceId: session.workspaceId,
    workspaceName: session.workspaceName ?? session.workspaceId,
    ...(session.projectId ? { projectId: session.projectId } : {}),
    state: session.isProcessing ? 'running' : 'idle',
    ...(session.hasUnread ? { unread: true } : {}),
    startedAt: session.createdAt ?? 0,
    ...(session.lastMessageAt ? { lastMessageAt: session.lastMessageAt } : {}),
  }
}

/**
 * The task **graphs** this conversation created.
 *
 * A graph is not a child session — giving its orchestrator a `parentSessionId` would take it off
 * the board and away from the task editor — so the link is `task.yaml`'s `created_by`, and this
 * reads it back. Two consequences worth knowing:
 *
 * - **Older tasks do not appear.** Graphs made before `created_by` existed carry no id; there is
 *   nothing to match on, and guessing from timing would put someone else's task on your card.
 * - **`state` comes from the runner, not the tile.** A graph is "running" when a run is alive in
 *   memory; the board column is a different question (a graph can be `needs-review` with nothing
 *   running). After a restart nothing is in memory — the card reads idle, which is true.
 * - **Nothing is cached, on purpose.** A spec is a file a person can edit on the board, and this
 *   panel polls: a cache would need an mtime stamp per file to be honest, and reading a handful of
 *   small YAML files every few seconds costs less than the bug where an edited task never shows up.
 */
async function dagTasksFor(
  deps: HandlerDeps,
  sessions: Session[],
  bot: Session,
): Promise<BotTask[]> {
  const workspace = getWorkspaceByNameOrId(bot.workspaceId)
  if (!workspace) return []

  const runner = getTaskRunner({
    workspaceId: workspace.id,
    workspaceRoot: workspace.rootPath,
    host: deps.sessionManager,
  })

  const out: BotTask[] = []
  for (const slug of listTaskSlugs(workspace.rootPath)) {
    const loaded = loadTaskSpec(workspace.rootPath, slug)
    const spec = loaded?.spec
    if (!spec || spec.created_by !== bot.id) continue

    // The tile the graph belongs to. Without it there is nothing to open and no place for a
    // status to live, so the card would be a dead end.
    const orchestrator = sessions.find(s => s.taskSlug === slug && !s.parentSessionId)
    if (!orchestrator) continue

    const run = runner.activeRun(slug)
    const done = run ? run.nodes.filter(n => n.state === 'done' || n.state === 'skipped').length : 0

    out.push({
      kind: 'task',
      sessionId: orchestrator.id,
      name: spec.title,
      workspaceId: orchestrator.workspaceId,
      workspaceName: orchestrator.workspaceName ?? workspace.name,
      ...(orchestrator.projectId ? { projectId: orchestrator.projectId } : {}),
      state: run ? 'running' : 'idle',
      ...(orchestrator.hasUnread ? { unread: true } : {}),
      startedAt: orchestrator.createdAt ?? 0,
      ...(orchestrator.lastMessageAt ? { lastMessageAt: orchestrator.lastMessageAt } : {}),
      slug,
      ...(run ? { runId: run.runId, progress: { done, total: run.nodes.length } } : {}),
    })
  }
  return out
}

/**
 * The assistant's conversation in **this workspace**: the newest `role: 'bot'` one, created if
 * there is none.
 *
 * One per workspace, not one per app. That is the whole point of the role: the conversation
 * inherits the workspace's model, connection, sources, skills, permission mode and memory, so
 * there is nothing to configure a second time — and nothing to get wrong quietly.
 *
 * Two details that were wrong once and are easy to get wrong again:
 *
 * - **Single flight.** The panel opens with an effect that can run twice (StrictMode, a remount
 *   while the window is still hydrating). Two lookups that both see "no conversation" create two,
 *   which is how the first version ended up with a stray empty one beside the real one.
 * - **`ask`, not the workspace default.** A conversation that is expected to hand work to other
 *   work must not start in Explore mode, where `spawn_session` is not even offered. The
 *   person can still tighten it from the composer; they do not have to discover it first.
 * - **Hidden from the session list.** That list is the person's work — their tasks and their
 *   conversations. The assistant is neither: it is reached from its own entry, and a conversation
 *   sitting among the tasks reads as one more task. `hidden` is presentation only, so the
 *   transcript, the memory and the id stay where they are, which is what lets the panel show what
 *   the list does not.
 */
const botSessionInflight = new Map<string, Promise<Session>>()

async function ensureBotSession(deps: HandlerDeps, workspaceId: string): Promise<Session> {
  const sm = deps.sessionManager
  const existing = sm
    .getSessions(workspaceId)
    .filter(s => s.role === 'bot' && !s.isArchived)
    .sort((a, b) => (b.lastMessageAt ?? b.createdAt ?? 0) - (a.lastMessageAt ?? a.createdAt ?? 0))[0]
  if (existing) {
    // Conversations created before the role was hidden are still in the list; putting them back
    // where they belong happens the first time the panel opens, once.
    if (!existing.hidden) await sm.setSessionHidden(existing.id, true)
    return existing
  }

  const pending = botSessionInflight.get(workspaceId)
  if (pending) return pending

  const created = sm.createSession(workspaceId, {
    name: 'Craft Bot',
    role: 'bot',
    permissionMode: 'ask',
    hidden: true,
  }).finally(() => botSessionInflight.delete(workspaceId))

  botSessionInflight.set(workspaceId, created)
  return created
}

/** The channels this module answers — the registration test reads it, as it does for every module. */
export const HANDLED_CHANNELS = [
  RPC_CHANNELS.bot.SESSION,
  RPC_CHANNELS.bot.TASKS,
  RPC_CHANNELS.bot.RESULT,
  RPC_CHANNELS.bot.CANCEL,
] as const

export function registerBotHandlers(server: RpcServer, deps: HandlerDeps): void {
  server.handle(RPC_CHANNELS.bot.SESSION, async (ctx): Promise<BotSession> => {
    // The window's workspace: the Bot is the assistant *of this workspace*, so where the window is
    // is the answer. A window with no workspace (a remote tab before hydration) gets a clear error
    // instead of a conversation in some other place.
    const workspaceId = ctx.workspaceId
    if (!workspaceId) throw new Error('Craft Bot needs a workspace: this window is not bound to one.')
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace ${workspaceId} not found`)

    const session = await ensureBotSession(deps, workspace.id)
    return {
      sessionId: session.id,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      ...(session.name ? { name: session.name } : {}),
      ...(session.model ? { model: session.model } : {}),
      ...(session.permissionMode ? { permissionMode: session.permissionMode } : {}),
    }
  })

  server.handle(
    RPC_CHANNELS.bot.TASKS,
    async (_ctx, botSessionId?: string): Promise<BotTask[]> => {
      // Every task this conversation dispatched: the conversations it started, plus the graphs it
      // created. Both links are facts already on disk, so nothing here is a task store.
      if (!botSessionId) return []
      const sessions = deps.sessionManager.getSessions()
      const bot = sessions.find(s => s.id === botSessionId)
      // Archived children are gone on purpose: list them and the column becomes an archive of
      // everything ever asked for, which is exactly what it must not be. The history lives in the
      // session list — a child is an ordinary conversation, and archiving it is how a person says
      // they are done with it.
      const children = sessions
        .filter(s => s.parentSessionId === botSessionId && !s.isArchived)
        .map(taskOf)
      const graphs = bot ? await dagTasksFor(deps, sessions, bot) : []
      return [...children, ...graphs].sort((a, b) => b.startedAt - a.startedAt)
    },
  )

  server.handle(
    RPC_CHANNELS.bot.RESULT,
    async (_ctx, sessionId: string, options?: { artifacts?: boolean }): Promise<BotTaskResult> => {
      const session = await deps.sessionManager.getSession(sessionId)
      if (!session) throw new Error(`Task session ${sessionId} not found`)

      const last = [...(session.messages ?? [])]
        .reverse()
        .find(m => m.role === 'assistant' && !m.isThinking && typeof m.content === 'string' && m.content.trim())
      const text = last?.content?.trim()
      const artifacts = (options?.artifacts ?? ARTIFACTS_DEFAULT) ? await artifactsFor(session) : []

      return {
        task: taskOf(session),
        ...(text ? { lastText: text.length > RESULT_TEXT_LIMIT ? `${text.slice(0, RESULT_TEXT_LIMIT)}…` : text } : {}),
        isProcessing: session.isProcessing === true,
        ...(artifacts.length > 0 ? { artifacts } : {}),
      }
    },
  )

  // Stop one task. A conversation is cancelled; a task graph is **stopped**, which is a different
  // operation on a different object — cancelling its orchestrator's turn would leave the graph
  // dispatching nodes nobody is watching.
  server.handle(
    RPC_CHANNELS.bot.CANCEL,
    async (_ctx, sessionId: string, slug?: string, runId?: string) => {
      if (slug && runId) {
        // `sessionId` is the card's own session — for a graph, its orchestrator — so its workspace
        // is the one whose runner owns the run. Asking the session beats re-deriving it from the
        // slug, which would also find archived and hidden tiles.
        const owner = deps.sessionManager.getSessions().find(s => s.id === sessionId)
        if (!owner) throw new Error(`Can't stop task ${slug}: session ${sessionId} is not here`)
        const workspace = getWorkspaceByNameOrId(owner.workspaceId)
        if (!workspace) throw new Error(`Task ${slug} has no workspace to stop in`)
        const runner = getTaskRunner({
          workspaceId: workspace.id,
          workspaceRoot: workspace.rootPath,
          host: deps.sessionManager,
        })
        await runner.stop(slug, runId)
        return { sessionId, cancelled: true }
      }
      await deps.sessionManager.cancelProcessing(sessionId)
      return { sessionId, cancelled: true }
    },
  )
}

