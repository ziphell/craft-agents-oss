/**
 * Watching the hub's browser from the web UI.
 *
 * The web client has no browser window of its own, so a browser tab that lives on the server is
 * otherwise invisible here. This panel subscribes to one tab's frames and sends pointer/keyboard
 * back — see docs/browser-view-streaming.md for the protocol, why it is frames over the existing
 * WebSocket rather than WebRTC, and why one tab is watched at a time.
 *
 * Deliberately small: a tab picker, the page, and input. It is for watching an agent work and
 * taking over for a step, not for everyday browsing.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAtomValue } from 'jotai'
import { Maximize2, Minimize2 } from 'lucide-react'
import { windowWorkspaceIdAtom } from '@/atoms/sessions'
import type {
  BrowserInstanceInfo,
  BrowserStreamFrame,
  BrowserStreamInput,
} from '@craft-agent/shared/protocol'

interface WatchTarget {
  instanceId: string
  tabId: string
}

export function BrowserViewer() {
  const { t } = useTranslation()
  /**
   * The workspace this tab is on, read from the atom the renderer switches — so choosing another
   * workspace moves the panel with it instead of leaving it scoped to the one the page loaded on.
   */
  const workspaceId = useAtomValue(windowWorkspaceIdAtom) ?? undefined
  const [open, setOpen] = useState(false)
  const [instances, setInstances] = useState<BrowserInstanceInfo[]>([])
  const [selected, setSelected] = useState<WatchTarget | null>(null)
  const [frame, setFrame] = useState<BrowserStreamFrame | null>(null)
  const [error, setError] = useState<string | null>(null)
  /**
   * Docked or taking the page. Both are the same component and the same stream — expanding is a
   * layout change, not a second viewer, which is why it never re-subscribes.
   */
  const [expanded, setExpanded] = useState(false)

  /** The stream this panel owns. A ref, because frame callbacks arrive outside React's render. */
  const streamRef = useRef<string | null>(null)
  const lastMoveAtRef = useRef(0)
  /** Double-click is two presses at one place, which CDP needs told (`clickCount`). */
  const lastClickRef = useRef({ at: 0, x: 0, y: 0, count: 0 })

  /** This client's workspace first: another workspace's pages are not this panel's business. */
  const visibleInstances = workspaceId
    ? instances.filter((instance) => !instance.workspaceId || instance.workspaceId === workspaceId)
    : instances
  /** The same list, for effects that must not re-run every time it is rebuilt. */
  const visibleInstancesRef = useRef(visibleInstances)
  visibleInstancesRef.current = visibleInstances

  const load = useCallback(async () => {
    try {
      setInstances(await window.electronAPI.browserPane.list())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const stop = useCallback(async () => {
    const streamId = streamRef.current
    streamRef.current = null
    setFrame(null)
    if (streamId) {
      await window.electronAPI.browserPane.streamStop(streamId).catch(() => {})
    }
  }, [])

  const watch = useCallback(async (target: WatchTarget) => {
    setError(null)
    await stop()
    try {
      const started = await window.electronAPI.browserPane.streamStart(target)
      streamRef.current = started.streamId
      setSelected(target)
    } catch (err) {
      // The common refusal is "already being watched or recorded" — say it, do not swallow it.
      setError(err instanceof Error ? err.message : String(err))
      setSelected(null)
    }
  }, [stop])

  // Frames for whichever stream this panel owns, and a fresh list whenever a window changes.
  useEffect(() => {
    if (!open) return
    const offFrame = window.electronAPI.browserPane.onStreamFrame((incoming) => {
      if (incoming.streamId !== streamRef.current) return
      setFrame(incoming)
    })
    // The stream can end without us: its tab was closed, its window went away, or capture lost
    // its session. Without this the panel would sit on a still picture.
    const offEnded = window.electronAPI.browserPane.onStreamEnded((streamId) => {
      if (streamId !== streamRef.current) return
      streamRef.current = null
      setFrame(null)
      setSelected(null)
      setError(t('browser.streamEnded'))
    })
    const offState = window.electronAPI.browserPane.onStateChanged(() => { void load() })
    void load()
    return () => {
      offFrame()
      offEnded()
      offState()
    }
  }, [open, load, t])

  // Closing the panel (or leaving the page) ends the stream; a viewer is not a background job.
  useEffect(() => {
    if (open) return
    void stop()
    setSelected(null)
  }, [open, stop])
  useEffect(() => () => { void stop() }, [stop])

  // Pick the first tab the moment there is something to watch, so opening the panel shows a page.
  useEffect(() => {
    if (!open || selected || streamRef.current) return
    const first = firstTab(visibleInstancesRef.current)
    if (first) void watch(first)
  }, [open, selected, watch])

  const send = useCallback((events: BrowserStreamInput[]) => {
    const streamId = streamRef.current
    if (!streamId || events.length === 0) return
    void window.electronAPI.browserPane.streamInput(streamId, events).catch((err) => {
      setError(err instanceof Error ? err.message : String(err))
    })
  }, [])

  /** Client coordinates → the tab's CSS pixels, which is what the frame is in. */
  const toTabPoint = (event: React.MouseEvent<HTMLElement>): { x: number; y: number } | null => {
    if (!frame) return null
    const box = event.currentTarget.getBoundingClientRect()
    if (box.width === 0 || box.height === 0) return null
    return {
      x: Math.round(((event.clientX - box.left) / box.width) * frame.width),
      y: Math.round(((event.clientY - box.top) / box.height) * frame.height),
    }
  }

  const mouse = (action: 'move' | 'down' | 'up') => (event: React.MouseEvent<HTMLElement>) => {
    const point = toTabPoint(event)
    if (!point) return
    if (action === 'move') {
      // Hover is throttled to ~20/s; a drag is not, because every point of it is the gesture.
      const now = Date.now()
      if (event.buttons === 0 && now - lastMoveAtRef.current < 50) return
      lastMoveAtRef.current = now
    }
    event.preventDefault()

    // Double-click is two presses at one place: CDP reads it from `clickCount`, not from timing.
    let clickCount: number | undefined
    if (action === 'down') {
      const previous = lastClickRef.current
      const now = Date.now()
      const repeat = now - previous.at < 400
        && Math.abs(previous.x - point.x) <= 2
        && Math.abs(previous.y - point.y) <= 2
      const count = repeat ? previous.count + 1 : 1
      lastClickRef.current = { at: now, x: point.x, y: point.y, count }
      clickCount = count
    } else if (action === 'up') {
      clickCount = lastClickRef.current.count
    }

    send([{
      type: 'mouse',
      action,
      ...point,
      ...(action === 'move' ? {} : { button: buttonName(event.button), clickCount }),
      buttons: event.buttons,
    }])
  }

  const targetValue = selected ? `${selected.instanceId}::${selected.tabId}` : ''

  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="fixed bottom-4 right-4 z-50 rounded-full bg-foreground px-4 py-2 text-[13px] font-medium text-background shadow-lg"
        >
          {t('browser.openBrowser')}
        </button>
      )}

      {open && (
        <section
          className={
            expanded
              ? 'fixed inset-3 z-50 flex flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl'
              : 'fixed bottom-4 right-4 z-50 flex max-h-[80vh] w-[min(760px,92vw)] flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl'
          }
        >
          <header className="flex items-center gap-2 border-b border-border px-3 py-2">
            <select
              className="min-w-0 flex-1 truncate rounded-md bg-muted/50 px-2 py-1 text-[13px] outline-none"
              value={targetValue}
              onChange={(event) => {
                const [instanceId, tabId] = event.target.value.split('::')
                if (instanceId && tabId) void watch({ instanceId, tabId })
              }}
            >
              {visibleInstances.length === 0 && <option value="">{t('browser.openBrowser')}</option>}
              {visibleInstances.map((instance) =>
                (instance.tabs ?? []).map((tab) => (
                  <option key={`${instance.id}::${tab.id}`} value={`${instance.id}::${tab.id}`}>
                    {tab.title || tab.url || tab.id}
                  </option>
                )),
              )}
            </select>
            <button
              type="button"
              onClick={() => setExpanded((value) => !value)}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-muted"
              aria-label={expanded ? t('menu.restore') : t('menu.maximize')}
            >
              {expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md px-2 py-1 text-[13px] text-muted-foreground hover:bg-muted"
              aria-label={t('common.close')}
            >
              ×
            </button>
          </header>

          <div className={expanded ? 'flex-1 overflow-auto bg-muted/30' : 'max-h-[70vh] overflow-auto bg-muted/30'}>
            {error ? (
              <p className="px-3 py-6 text-[13px] text-destructive">{error}</p>
            ) : frame ? (
              <div
                tabIndex={0}
                className="outline-none"
                onMouseDown={mouse('down')}
                onMouseUp={mouse('up')}
                onMouseMove={mouse('move')}
                onContextMenu={(event) => event.preventDefault()}
                onWheel={(event) => {
                  event.preventDefault()
                  const point = toTabPoint(event)
                  if (!point) return
                  const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1
                  send([{ type: 'wheel', ...point, deltaX: event.deltaX * scale, deltaY: event.deltaY * scale }])
                }}
                onKeyDown={(event) => {
                  event.preventDefault()
                  send([{
                    type: 'key',
                    action: 'down',
                    key: event.key,
                    code: event.code,
                    ...(event.key.length === 1 ? { text: event.key } : {}),
                    modifiers: modifiersOf(event),
                  }])
                }}
                onKeyUp={(event) => {
                  event.preventDefault()
                  send([{ type: 'key', action: 'up', key: event.key, code: event.code, modifiers: modifiersOf(event) }])
                }}
              >
                <img
                  src={`data:image/jpeg;base64,${frame.data}`}
                  alt=""
                  draggable={false}
                  className="block h-auto w-full select-none"
                />
              </div>
            ) : (
              <p className="px-3 py-6 text-[13px] text-muted-foreground">{t('browser.openBrowser')}</p>
            )}
          </div>
        </section>
      )}
    </>
  )
}

/** The first tab of the first window that has one. */
function firstTab(instances: BrowserInstanceInfo[]): WatchTarget | null {
  for (const instance of instances) {
    const tab = instance.tabs?.[0]
    if (tab) return { instanceId: instance.id, tabId: tab.id }
  }
  return null
}

/** CDP's modifier bitmask (Alt=1, Ctrl=2, Meta=4, Shift=8). */
function modifiersOf(event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0)
}

/** A DOM `MouseEvent.button` as CDP names it. */
function buttonName(button: number): 'left' | 'middle' | 'right' {
  if (button === 1) return 'middle'
  if (button === 2) return 'right'
  return 'left'
}
