/**
 * Shared browser component utilities
 */

import type { BrowserTabSummary } from '../../../shared/types'

export function getHostname(url: string): string {
  try {
    if (url === 'about:blank' || !url) return 'New Tab'
    const parsed = new URL(url)

    if (parsed.protocol === 'file:') {
      const decodedPath = decodeURIComponent(parsed.pathname || '')
      if (!decodedPath || decodedPath === '/' || decodedPath.endsWith('/')) return 'Local File'

      const normalizedPath = decodedPath.replace(/\/+$/, '')
      const fileName = normalizedPath.split('/').filter(Boolean).at(-1)
      return fileName || 'Local File'
    }

    const hostname = parsed.hostname.replace(/^www\./, '')
    if (hostname) return hostname

    return parsed.protocol.replace(/:$/, '') || url
  } catch {
    return url
  }
}

/**
 * What a window's page menu opens, when it offers "open the conversation/task".
 *
 * A conversation, or a task (whose target is the task's own session).
 */
export interface PageOpenTarget {
  kind: 'session' | 'task'
  sessionId: string
}

/** The part of a session's metadata the rule below reads. */
type SessionWorkMeta = {
  taskSlug?: string
  parentSessionId?: string
  taskDraft?: boolean
}

/** The part of a page the rule below reads: what is on screen, and whose work it is. */
type ActivePageTab = Pick<BrowserTabSummary, 'active' | 'lockedBy' | 'cursorOf' | 'belongsTo'>

/**
 * Where the menu's "open …" item goes: the **page on screen**'s answer, never the window's.
 *
 * One window is shared by the whole workspace, so "the conversation using this window" is not a
 * fact that exists (plan §22) — what exists is that a page is somebody's work, and the person is
 * looking at one of them. Who is working on that page right now, else who works from it, else
 * whose work it is:
 *
 * - a conversation's page opens that conversation;
 * - a **Task's** page opens the **task** — the session carrying that slug that nothing spawned —
 *   and not the session that happened to open the page: that one is provenance, and once its node
 *   has been re-run it has usually stopped, so opening it would land on a dead conversation. A
 *   generate-time draft carries the slug too and is off the board, so it does not count either.
 *
 * `null` when there is nothing to open (no page on screen, a person's page, or a task whose
 * session is gone) — the caller greys the item out rather than opening something arbitrary.
 */
export function openTargetOfActivePage(
  tabs: ActivePageTab[] | undefined,
  sessions: Iterable<[string, SessionWorkMeta]>,
): PageOpenTarget | null {
  const page = tabs?.find((tab) => tab.active)
  if (!page) return null

  const worker = page.lockedBy ?? page.cursorOf
  if (worker) return { kind: 'session', sessionId: worker }

  const work = page.belongsTo
  if (!work) return null
  if (work.kind === 'session') return { kind: 'session', sessionId: work.sessionId }

  for (const [id, meta] of sessions) {
    if (meta.taskSlug === work.taskSlug && !meta.parentSessionId && !meta.taskDraft) {
      return { kind: 'task', sessionId: id }
    }
  }
  return null
}

/**
 * Compute relative luminance of a CSS color string.
 * Uses a hidden probe element to resolve any CSS color format to RGB,
 * then applies the WCAG luminance formula.
 * Results are cached for performance.
 */
const themeLuminanceCache = new Map<string, number | null>()

export function getThemeLuminance(color: string): number | null {
  if (typeof document === 'undefined' || !document.body) return null

  const cached = themeLuminanceCache.get(color)
  if (cached !== undefined) return cached

  const probe = document.createElement('span')
  probe.style.color = color
  probe.style.position = 'absolute'
  probe.style.opacity = '0'
  probe.style.pointerEvents = 'none'
  probe.style.left = '-9999px'
  document.body.appendChild(probe)

  const computed = getComputedStyle(probe).color
  probe.remove()

  const match = computed.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
  if (!match) {
    themeLuminanceCache.set(color, null)
    return null
  }

  const toLinear = (channel: number) => {
    const c = channel / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }

  const r = toLinear(Number(match[1]))
  const g = toLinear(Number(match[2]))
  const b = toLinear(Number(match[3]))

  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
  themeLuminanceCache.set(color, luminance)
  return luminance
}
