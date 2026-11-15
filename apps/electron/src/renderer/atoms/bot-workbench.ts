/**
 * The workbench's data, shared by the two places that show it.
 *
 * The workbench is its **own dock**, so it is no longer a child of the assistant's page — and its
 * list, the running count beside the assistant's title and the count on the toggle all have to be
 * the same numbers. Two components polling separately would be two answers to one question (and
 * two RPC round trips every five seconds for a list that changes a few times an hour).
 *
 * So: one store, one poller, started by the first subscriber and stopped by the last. It reads the
 * same two channels the page used to (`bot:session` once, `bot:tasks` + `bot:result` per card) and
 * is otherwise dumb — everything about *what* is listed lives on the server.
 */

import { useSyncExternalStore } from 'react'
import { atom } from 'jotai'
import type { BotSession, BotTask, BotTaskResult } from '@craft-agent/shared/protocol'

/** Is the dock open. Per window, like every other piece of panel chrome. */
export const botWorkbenchOpenAtom = atom(false)

/** How often to re-read when no push has arrived. */
const POLL_MS = 5000

export interface BotWorkbenchSnapshot {
  bot: BotSession | null
  tasks: BotTask[]
  results: Record<string, BotTaskResult>
  error: string | null
}

const EMPTY: BotWorkbenchSnapshot = { bot: null, tasks: [], results: {}, error: null }

let snapshot: BotWorkbenchSnapshot = EMPTY
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | null = null
let unsubscribeChanged: (() => void) | null = null
let inFlight = false
/**
 * Whether anyone can currently see a card's files.
 *
 * The creations scan behind `artifacts` reads every session in the workspace the first time it
 * runs — seconds, on this machine — so it is asked for only while the workbench is open. The
 * collapsed count and the `N 在跑` badge never trigger it.
 */
let artifactsWanted = false
/** `(lastMessageAt, state, artifacts)` per card: a card that has not moved needs no re-read. */
const stamps: Record<string, string> = {}

function emit(next: BotWorkbenchSnapshot): void {
  snapshot = next
  for (const listener of listeners) listener()
}

async function poll(): Promise<void> {
  if (inFlight) return
  inFlight = true
  try {
    const previous = snapshot.bot
    const bot = previous ?? (await window.electronAPI.getBotSession())
    // Emit the conversation the moment it is known. Everything after this (the list, then one
    // result read per changed card) can take a while, and holding the page on a blank "Starting
    // Craft Bot…" until the slowest of them returns is a startup cost paid for nothing.
    if (bot !== previous) emit({ ...snapshot, bot, error: null })

    const tasks = await window.electronAPI.getBotTasks(bot.sessionId)
    // The list, before the files: a card's title and time are cheap, the artifacts behind it are
    // not (`bot:result` with artifacts may read the whole workspace the first time).
    emit({ ...snapshot, bot, tasks, error: null })

    const wanted = tasks.filter(task => {
      const artifacts = artifactsWanted ? 'artifacts' : 'plain'
      return stamps[task.sessionId] !== `${task.lastMessageAt ?? 0}:${task.state}:${artifacts}`
    })
    const results = { ...snapshot.results }
    if (wanted.length > 0) {
      const entries = await Promise.all(wanted.map(async (task) => {
        try {
          return [task.sessionId, await window.electronAPI.getBotTaskResult(task.sessionId, { artifacts: artifactsWanted })] as const
        } catch {
          return null
        }
      }))
      for (const entry of entries) {
        if (!entry) continue
        const [sessionId, result] = entry
        results[sessionId] = result
        const artifacts = artifactsWanted ? 'artifacts' : 'plain'
        stamps[sessionId] = `${result.task.lastMessageAt ?? 0}:${result.task.state}:${artifacts}`
      }
    }

    emit({ bot, tasks, results, error: null })
  } catch (e) {
    // Keep the last good list: a failed read is not an empty workbench.
    emit({ ...snapshot, error: e instanceof Error ? e.message : String(e) })
  } finally {
    inFlight = false
  }
}

function start(): void {
  if (timer !== null) return
  void poll()
  timer = setInterval(() => void poll(), POLL_MS)
  // A dispatched task finishes in a conversation this window is not watching, so the server sends
  // this one signal instead.
  unsubscribeChanged = window.electronAPI.onBotChanged(() => void poll())
}

function stop(): void {
  if (timer !== null) {
    clearInterval(timer)
    timer = null
  }
  unsubscribeChanged?.()
  unsubscribeChanged = null
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  start()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) stop()
  }
}

/**
 * Ask for the cards' files (or stop asking). The dock turns this on while it is mounted: a closed
 * workbench has nowhere to show a poster, so it should not pay to find one.
 */
export function setArtifactsWanted(wanted: boolean): void {
  if (artifactsWanted === wanted) return
  artifactsWanted = wanted
  void poll()
}

export function useBotWorkbench(): BotWorkbenchSnapshot {
  return useSyncExternalStore(subscribe, () => snapshot, () => EMPTY)
}
