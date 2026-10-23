/**
 * The browser a viewer sees, full screen.
 *
 * A remote window's browser — and the web UI's — is the workspace's browser on **its server**
 * (see docs/browser-view-streaming.md). There is nothing to raise on this machine, so a tab is
 * watched as a stream of frames and input goes back over the same socket.
 *
 * Deliberately one tab at a time: Chromium's screencast is one stream per CDP session, and the
 * server refuses a second viewer rather than silently replacing the first.
 *
 * Two rules this component keeps visible in its UI:
 * - Watching is not controlling. The page is read-only until somebody presses **Take control**;
 *   clicking the picture no longer counts as an answer to that.
 * - The picture is fitted, not cropped: a frame is letterboxed inside the window, and every
 *   pointer coordinate is mapped through the image's own box so a click lands where it looks.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAtomValue, useSetAtom } from 'jotai'
import { cn } from '@/lib/utils'
import {
  ArrowLeft,
  ArrowRight,
  Globe,
  Loader2,
  Lock,
  Maximize2,
  Minimize2,
  MonitorPlay,
  MousePointerClick,
  Plus,
  RefreshCw,
  RotateCw,
  Square,
  TriangleAlert,
  X,
} from 'lucide-react'
import {
  browserViewRequestAtom,
  closeBrowserViewAtom,
  setBrowserInstancesAtom,
} from '@/atoms/browser-pane'
import type {
  BrowserInstanceInfo,
  BrowserStreamFrame,
  BrowserStreamInput,
} from '../../../shared/types'

interface WatchTarget {
  instanceId: string
  tabId: string
}

/**
 * Where the stream is in its life.
 *
 * `connecting` is the request in flight, `waiting` is a session that has not painted yet —
 * a distinction worth showing, because the second one is the slow case (a page that is
 * still settling, or one that does not repaint at all) and it is the one people would
 * otherwise read as "broken".
 */
type Phase = 'idle' | 'connecting' | 'waiting' | 'live' | 'ended'

export interface BrowserStreamViewerProps {
  /** Which workspace's browser to show; `undefined` means every instance visible to this client. */
  workspaceId?: string
}

/**
 * The viewer itself, with no way in of its own.
 *
 * Opening it is the top bar's job — the globe beside the browser control, in both a local window
 * and a viewer-only one. A second floating entry point would put a pill over the page on every
 * client whether or not a browser is open.
 */
export function BrowserStreamViewer({ workspaceId }: BrowserStreamViewerProps) {
  const { t } = useTranslation()
  const request = useAtomValue(browserViewRequestAtom)
  const closeView = useSetAtom(closeBrowserViewAtom)
  /** The same list, for the composer's browser chip and the status slot — the strip is not here. */
  const setBrowserInstances = useSetAtom(setBrowserInstancesAtom)
  const open = request.open

  const [instances, setInstances] = useState<BrowserInstanceInfo[]>([])
  /** Whether a list has been read at all — "none open" and "not asked yet" are different screens. */
  const [loaded, setLoaded] = useState(false)
  const [selected, setSelected] = useState<WatchTarget | null>(null)
  /**
   * The size of the picture, not the picture itself.
   *
   * Frames are painted straight onto a canvas (see `drawLatest`): keeping them in state would
   * re-render this whole shell — tab rail included — fifteen times a second. Only the size,
   * which changes when the tab is resized, is state; the bytes stay in a ref.
   */
  const [frameSize, setFrameSize] = useState<{ width: number; height: number } | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  /** Reflow the page to the pane instead of drawing it 1:1 inside a bigger one. */
  const [fitMode, setFitMode] = useState(false)
  /** The stage's own box, kept current by a ResizeObserver — the picture is fitted into it. */
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 })
  /** Watching is not controlling: pointer and keyboard only go back after the person takes over. */
  const [controlled, setControlled] = useState(false)
  /** A refusal about control or input — news, not a reason to cover the picture. */
  const [notice, setNotice] = useState<string | null>(null)
  /** Why the stream is over. */
  const [failure, setFailure] = useState<string | null>(null)

  /** The stream this panel owns. A ref, because frame callbacks arrive outside React's render. */
  const streamRef = useRef<string | null>(null)
  /** The tab to try again, kept across an ended stream (which clears `selected`). */
  const lastTargetRef = useRef<WatchTarget | null>(null)
  const phaseRef = useRef<Phase>('idle')
  const lastMoveAtRef = useRef(0)
  /** Double-click is two presses at one place, which CDP needs told (`clickCount`). */
  const lastClickRef = useRef({ at: 0, x: 0, y: 0, count: 0 })

  const stageRef = useRef<HTMLDivElement | null>(null)
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  /** The picture. Painted imperatively; never re-mounted between frames. */
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const pendingFrameRef = useRef<BrowserStreamFrame | null>(null)
  const rafRef = useRef<number | null>(null)
  const drawingRef = useRef(false)
  /** Bumped whenever the picture is cleared, so a decode in flight cannot draw onto it. */
  const pictureGenRef = useRef(0)
  /** The size the canvas is showing, readable from callbacks that run before a render. */
  const frameSizeRef = useRef<{ width: number; height: number } | null>(null)
  /** Automatic re-subscription after the stream ends on its own. */
  const reconnectRef = useRef<{ attempts: number; timer: ReturnType<typeof setTimeout> | null }>({
    attempts: 0,
    timer: null,
  })
  /** The pointer locator, moved by hand: sixty renders a second is not what a cursor is worth. */
  const cursorRef = useRef<HTMLDivElement | null>(null)

  /** This client's workspace first: another workspace's pages are not this panel's business. */
  const visibleInstances = workspaceId
    ? instances.filter((instance) => !instance.workspaceId || instance.workspaceId === workspaceId)
    : instances
  /** The same list, for effects that must not re-run every time it is rebuilt. */
  const visibleInstancesRef = useRef(visibleInstances)
  visibleInstancesRef.current = visibleInstances

  const enterPhase = useCallback((next: Phase) => {
    phaseRef.current = next
    setPhase(next)
  }, [])

  const load = useCallback(async () => {
    try {
      const next = await window.electronAPI.browserPane.list()
      setInstances(next)
      setBrowserInstances(next)
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err))
    } finally {
      setLoaded(true)
    }
  }, [setBrowserInstances])

  /** Empty the picture and forget its size — the loading and ended overlays key off both. */
  const clearPicture = useCallback(() => {
    pendingFrameRef.current = null
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    pictureGenRef.current += 1
    frameSizeRef.current = null
    setFrameSize(null)
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (canvas && context) context.clearRect(0, 0, canvas.width, canvas.height)
  }, [])

  /** The latest painter, for the async loop to call itself without being its own dependency. */
  const drawLatestRef = useRef<() => void>(() => {})

  /**
   * Paint the newest frame, at most once per animation frame.
   *
   * Frames arrive faster than a refresh would use them, and decoding is asynchronous: a burst
   * collapses into "the last one", and a decode already in flight is not joined by another for
   * the same animation frame. Everything goes through refs, so streaming never re-renders this
   * shell — the old data-URL `<img>` re-rendered the whole modal, tab rail included, per frame.
   */
  const drawLatest = useCallback(() => {
    if (rafRef.current !== null) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      const next = pendingFrameRef.current
      pendingFrameRef.current = null
      if (!next) return
      if (drawingRef.current) {
        // Keep only the newest; the decode that is running will pick it up when it finishes.
        pendingFrameRef.current = next
        return
      }
      drawingRef.current = true
      const gen = pictureGenRef.current
      void (async () => {
        /** Draw at the source's own pixel size; a stale generation is dropped, not drawn. */
        const paint = (source: CanvasImageSource, width: number, height: number): void => {
          const canvas = canvasRef.current
          if (!canvas || gen !== pictureGenRef.current) return
          if (canvas.width !== width) canvas.width = width
          if (canvas.height !== height) canvas.height = height
          canvas.getContext('2d')?.drawImage(source, 0, 0)
        }
        try {
          const binary = atob(next.data)
          const bytes = new Uint8Array(binary.length)
          for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
          const blob = new Blob([bytes], { type: 'image/jpeg' })
          if (typeof createImageBitmap === 'function') {
            const bitmap = await createImageBitmap(blob)
            paint(bitmap, bitmap.width, bitmap.height)
            bitmap.close()
          } else {
            // A browser without `createImageBitmap`: an <img> decodes the same bytes.
            const url = URL.createObjectURL(blob)
            try {
              const image = new Image()
              image.src = url
              await image.decode()
              paint(image, image.naturalWidth, image.naturalHeight)
            } finally {
              URL.revokeObjectURL(url)
            }
          }
        } catch {
          // A frame that will not decode is one frame not drawn; the next is already coming.
        } finally {
          drawingRef.current = false
          if (pendingFrameRef.current) drawLatestRef.current()
        }
      })()
    })
  }, [])
  drawLatestRef.current = drawLatest

  const stop = useCallback(async () => {
    const streamId = streamRef.current
    streamRef.current = null
    clearPicture()
    setControlled(false)
    if (cursorRef.current) cursorRef.current.style.opacity = '0'
    if (reconnectRef.current.timer) {
      clearTimeout(reconnectRef.current.timer)
      reconnectRef.current.timer = null
    }
    enterPhase('idle')
    if (streamId) {
      await window.electronAPI.browserPane.streamStop(streamId).catch(() => {})
    }
  }, [clearPicture, enterPhase])

  /**
   * Watch a tab.
   *
   * `retrying` is the automatic path: it keeps the retry budget, where a person asking again
   * (or a fresh request) starts over.
   */
  const watch = useCallback(async (target: WatchTarget, retrying = false) => {
    if (!retrying) reconnectRef.current.attempts = 0
    setNotice(null)
    setFailure(null)
    lastTargetRef.current = target
    await stop()
    // The header should show what is being connected to, before there is a picture of it.
    setSelected(target)
    enterPhase('connecting')
    try {
      const started = await window.electronAPI.browserPane.streamStart(target)
      streamRef.current = started.streamId
      // Connected, but nothing painted yet — a still page can take a moment to send its first
      // frame, and that is a different state to "not connected".
      enterPhase('waiting')
    } catch (err) {
      // The common refusal is "already being watched or recorded" — say it, do not swallow it.
      streamRef.current = null
      setSelected(null)
      setFailure(err instanceof Error ? err.message : String(err))
      enterPhase('ended')
    }
  }, [stop, enterPhase])

  /**
   * Take control of the watched tab, or give it back.
   *
   * The server refuses while the agent holds the tab: its turn is using the page, and a click
   * landing in the middle of it is the thing the tab lock exists to prevent. A refusal leaves
   * the panel read-only and says why.
   */
  const setControl = useCallback(async (next: boolean) => {
    const streamId = streamRef.current
    if (!streamId) return
    try {
      await window.electronAPI.browserPane.streamControl(streamId, next)
      setControlled(next)
      if (next) {
        setNotice(null)
        setFailure(null)
      } else if (cursorRef.current) {
        cursorRef.current.style.opacity = '0'
      }
    } catch (err) {
      setControlled(false)
      setNotice(err instanceof Error ? err.message : String(err))
    }
  }, [])

  /** Open the workspace's browser on the server, then watch its first tab. */
  const openBrowser = useCallback(async () => {
    try {
      // Hidden on the server: there is no one sitting in front of it, and this view is the point.
      await window.electronAPI.browserPane.create({ show: false })
      await load()
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err))
    }
  }, [load])

  // Frames for whichever stream this panel owns, and a fresh list whenever a window changes.
  useEffect(() => {
    if (!open) return
    const offFrame = window.electronAPI.browserPane.onStreamFrame((incoming) => {
      if (incoming.streamId !== streamRef.current) return
      pendingFrameRef.current = incoming
      const shown = frameSizeRef.current
      if (!shown || shown.width !== incoming.width || shown.height !== incoming.height) {
        frameSizeRef.current = { width: incoming.width, height: incoming.height }
        setFrameSize(frameSizeRef.current)
      }
      if (phaseRef.current !== 'live') {
        // A picture means the stream is real: the retry budget starts over here, not on the
        // start request (a stream that starts and dies at once must not retry forever).
        reconnectRef.current.attempts = 0
        enterPhase('live')
      }
      drawLatest()
    })
    // The stream can end without us: its tab was closed, its window went away, or capture lost
    // its session. A few silent retries first — most of these are a tab reload or a capture
    // hiccup, and "reconnect" is a poor first answer to both.
    const offEnded = window.electronAPI.browserPane.onStreamEnded((streamId) => {
      if (streamId !== streamRef.current) return
      streamRef.current = null
      clearPicture()
      setControlled(false)
      const target = lastTargetRef.current
      const attempt = reconnectRef.current.attempts
      if (target && attempt < 3) {
        reconnectRef.current.attempts = attempt + 1
        enterPhase('connecting')
        reconnectRef.current.timer = setTimeout(() => {
          reconnectRef.current.timer = null
          void watch(target, true)
        }, 1_000 * 2 ** attempt)
        return
      }
      setSelected(null)
      setFailure(t('browser.streamEnded'))
      enterPhase('ended')
    })
    const offState = window.electronAPI.browserPane.onStateChanged(() => { void load() })
    // The socket can also come back before the server notices: subscribe again rather than sit
    // on a frame that will never be replaced.
    const offReconnected = window.electronAPI.onReconnected(() => {
      const target = lastTargetRef.current
      if (!target) return
      if (!streamRef.current && phaseRef.current !== 'live') return
      void watch(target)
    })
    void load()
    return () => {
      offFrame()
      offEnded()
      offState()
      offReconnected()
    }
  }, [open, load, enterPhase, t, drawLatest, clearPicture, watch])

  // Closing the panel (or leaving the page) ends the stream; a viewer is not a background job.
  useEffect(() => {
    if (open) return
    void stop()
    setSelected(null)
    setFailure(null)
    setNotice(null)
    setBrowserInstances([])
  }, [open, stop, setBrowserInstances])
  useEffect(() => () => { void stop() }, [stop])

  // A workspace change is another browser: the stream on screen belongs to the one that was there.
  const lastWorkspaceRef = useRef(workspaceId)
  useEffect(() => {
    if (lastWorkspaceRef.current === workspaceId) return
    lastWorkspaceRef.current = workspaceId
    if (!open) return
    void stop()
    setSelected(null)
    setInstances([])
    setLoaded(false)
    void load()
  }, [workspaceId, open, stop, load])

  /**
   * A request that names a tab — the page a link or a preview just opened — is watched as-is,
   * including when the panel was already open on another tab.
   */
  const lastRequestNonce = useRef(0)
  useEffect(() => {
    if (!open || !request.target || request.nonce === lastRequestNonce.current) return
    lastRequestNonce.current = request.nonce
    void watch(request.target)
  }, [open, request.nonce, request.target, watch])

  // Pick the first tab the moment there is something to watch, so opening the panel shows a page.
  // Only from `idle`: a stream that has just failed must stay failed until somebody asks again.
  useEffect(() => {
    if (!open || request.target || selected || streamRef.current) return
    if (phaseRef.current !== 'idle') return
    const first = firstTab(visibleInstancesRef.current)
    if (first) void watch(first)
  }, [open, request.target, selected, instances, watch])

  /**
   * The stage's size, live.
   *
   * The picture is fitted against this rather than left to `max-width: 100%`: a bitmap captured
   * at device pixels can be wider than the tab's CSS viewport, so "fill the stage" would enlarge
   * a page past 100%. With both numbers in hand the fit is explicit: shrink to the stage when it
   * is smaller, never grow past 1:1.
   */
  useEffect(() => {
    const stage = stageRef.current
    if (!open || !stage) return
    const observer = new ResizeObserver(([entry]) => {
      const box = entry?.contentRect
      if (!box) return
      setStageSize((previous) => (
        previous.width === box.width && previous.height === box.height
          ? previous
          : { width: box.width, height: box.height }
      ))
    })
    observer.observe(stage)
    return () => observer.disconnect()
  }, [open])

  // The keyboard belongs to the page only while the person has control; otherwise the panel is
  // just chrome and the app keeps its own shortcuts.
  useEffect(() => {
    if (open && controlled) surfaceRef.current?.focus()
    else surfaceRef.current?.blur()
  }, [open, controlled])

  // Reading is leaving nothing behind to protect: Escape closes a panel nobody has taken over.
  // Once it has been taken over, Escape goes to the page (the surface's own handler).
  useEffect(() => {
    if (!open || controlled) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      closeView()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, controlled, closeView])

  const send = useCallback((events: BrowserStreamInput[]) => {
    const streamId = streamRef.current
    if (!streamId || events.length === 0 || !controlled) return
    void window.electronAPI.browserPane.streamInput(streamId, events).catch((err) => {
      // The agent took the tab, or the stream ended: go back to watching.
      setControlled(false)
      setNotice(err instanceof Error ? err.message : String(err))
    })
  }, [controlled])

  /**
   * The wheel is a native listener, not `onWheel`.
   *
   * React registers wheel handlers as passive, so `preventDefault` there is ignored (and logged):
   * the gesture would scroll whatever is behind the pane *and* reach the page. Attached by hand
   * it can claim the gesture, and it is attached once per control change rather than per frame.
   */
  useEffect(() => {
    const surface = surfaceRef.current
    if (!controlled || !surface) return
    const onWheel = (event: WheelEvent) => {
      const picture = canvasRef.current
      const current = frameSizeRef.current
      if (!picture || !current) return
      const box = picture.getBoundingClientRect()
      if (box.width === 0 || box.height === 0) return
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) {
        return
      }
      event.preventDefault()
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1
      send([{
        type: 'wheel',
        x: clamp(Math.round(((event.clientX - box.left) / box.width) * current.width), 0, current.width - 1),
        y: clamp(Math.round(((event.clientY - box.top) / box.height) * current.height), 0, current.height - 1),
        deltaX: event.deltaX * scale,
        deltaY: event.deltaY * scale,
      }])
    }
    surface.addEventListener('wheel', onWheel, { passive: false })
    return () => surface.removeEventListener('wheel', onWheel)
  }, [controlled, send])

  /**
   * Client coordinates → the tab's CSS pixels.
   *
   * Measured on the **image** rather than its container: the picture is fitted into the window
   * with `object-contain`, so the image's own box already excludes the letterbox bars. That is
   * what makes a click land where it looked, at any window size and any tab aspect ratio.
   */
  const toTabPoint = (event: { clientX: number; clientY: number }): { x: number; y: number } | null => {
    const picture = canvasRef.current
    const size = frameSize
    if (!size || !picture) return null
    const box = picture.getBoundingClientRect()
    if (box.width === 0 || box.height === 0) return null
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) {
      return null
    }
    return {
      x: clamp(Math.round(((event.clientX - box.left) / box.width) * size.width), 0, Math.max(0, size.width - 1)),
      y: clamp(Math.round(((event.clientY - box.top) / box.height) * size.height), 0, Math.max(0, size.height - 1)),
    }
  }

  /** Put the locator where the pointer is, in stage coordinates. No state: this runs per move. */
  const moveCursor = (event: { clientX: number; clientY: number }) => {
    const stage = stageRef.current
    const cursor = cursorRef.current
    if (!stage || !cursor) return
    const box = stage.getBoundingClientRect()
    cursor.style.transform = `translate(${event.clientX - box.left}px, ${event.clientY - box.top}px) translate(-50%, -50%)`
    cursor.style.opacity = '1'
  }

  const mouse = (action: 'move' | 'down' | 'up') => (event: React.MouseEvent<HTMLElement>) => {
    // Read-only means read-only: a click on the picture is not a takeover gesture any more.
    // Control is taken with the header's button, deliberately and by name.
    if (!controlled) return
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
  const live = phase === 'live'
  const hasTabs = visibleInstances.length > 0

  /**
   * What the picture measures on screen.
   *
   * `frameSize` is the tab's CSS viewport and changes when the tab is resized, so the basis is
   * never stale. The scale is capped at 1 — the stage may be larger than the page, and a page is
   * not a poster.
   *
   * The size is left exactly as the scale computes it: rounding it would drop a fraction of a
   * pixel on each axis, which shows up as an uneven letterbox and a picture that creeps off
   * centre. Only the resolution label is rounded, and only for reading.
   */
  const fit = frameSize && frameSize.width > 0 && frameSize.height > 0
    && stageSize.width > 0 && stageSize.height > 0
    ? (() => {
        const scale = Math.min(1, stageSize.width / frameSize.width, stageSize.height / frameSize.height)
        return {
          width: frameSize.width * scale,
          height: frameSize.height * scale,
        }
      })()
    : null

  /** The window the watched tab belongs to — the chrome's verbs are per window. */
  const currentInstance = selected
    ? visibleInstances.find((item) => item.id === selected.instanceId)
    : undefined
  const currentTabs = currentInstance?.tabs ?? []
  const currentTab = currentTabs.find((tab) => tab.id === selected?.tabId)
  const currentUrl = currentTab?.url || currentInstance?.url || ''

  /**
   * The address field follows the page, unless somebody is typing in it — replacing the text
   * under the caret would fight the person for the very field they are editing.
   */
  const [address, setAddress] = useState('')
  const [editingAddress, setEditingAddress] = useState(false)
  useEffect(() => {
    if (!editingAddress) setAddress(currentUrl)
  }, [currentUrl, editingAddress])

  /** The list after an action, for the state the push has not described yet (a new tab's id). */
  const reloadList = useCallback(async () => {
    const next = await window.electronAPI.browserPane.list()
    setInstances(next)
    setBrowserInstances(next)
    return next
  }, [setBrowserInstances])

  /** Switch the window's tab and the stream together — the chrome acts on what is on screen. */
  const activateTab = useCallback(async (instanceId: string, tabId: string) => {
    await window.electronAPI.browserPane
      .tabAction({ instanceId, action: 'activate', tabId })
      .catch((err) => setNotice(err instanceof Error ? err.message : String(err)))
    await watch({ instanceId, tabId })
  }, [watch])

  const openNewTab = useCallback(async (instanceId: string) => {
    try {
      await window.electronAPI.browserPane.tabAction({ instanceId, action: 'new' })
      const next = await reloadList()
      const instance = next.find((item) => item.id === instanceId)
      const tabId = instance?.tabs?.find((tab) => tab.active)?.id ?? instance?.tabs?.[0]?.id
      if (tabId) await watch({ instanceId, tabId })
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err))
    }
  }, [reloadList, watch])

  const closeTab = useCallback(async (instanceId: string, tabId: string) => {
    try {
      await window.electronAPI.browserPane.tabAction({ instanceId, action: 'close', tabId })
      const next = await reloadList()
      if (selected?.tabId !== tabId) return
      const instance = next.find((item) => item.id === instanceId)
      const nextTabId = instance?.tabs?.find((tab) => tab.active)?.id ?? instance?.tabs?.[0]?.id
      if (nextTabId) await watch({ instanceId, tabId: nextTabId })
      // No tab left is the window closing; `onStreamEnded` is what says so.
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err))
    }
  }, [reloadList, selected?.tabId, watch])

  const go = useCallback((verb: 'back' | 'forward' | 'reload' | 'stop') => {
    const instanceId = currentInstance?.id
    if (!instanceId) return
    const api = window.electronAPI.browserPane
    const call = verb === 'back' ? api.goBack(instanceId)
      : verb === 'forward' ? api.goForward(instanceId)
      : verb === 'reload' ? api.reload(instanceId)
      : api.stop(instanceId)
    void call.catch((err) => setNotice(err instanceof Error ? err.message : String(err)))
  }, [currentInstance?.id])

  const goToAddress = useCallback(async () => {
    const instanceId = currentInstance?.id
    const target = address.trim()
    if (!instanceId || !target) return
    try {
      // As typed: the server normalises, and a bare word is a search there.
      await window.electronAPI.browserPane.navigate(instanceId, target)
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err))
    }
  }, [address, currentInstance?.id])

  /**
   * Fit mode: ask the tab to reflow to the pane, instead of drawing a bigger page small inside
   * it. Debounced — a window drag is one request when it settles, not sixty.
   *
   * It reflows the page, which is the point; on a tab that is on screen at the hub it also sizes
   * that window, which is the price of the page actually using the whole pane.
   */
  useEffect(() => {
    if (!fitMode || !open || !selected) return
    if (stageSize.width <= 0 || stageSize.height <= 0) return
    const timer = setTimeout(() => {
      void window.electronAPI.browserPane
        .resizeViewport(
          selected.instanceId,
          Math.round(stageSize.width),
          Math.round(stageSize.height),
          selected.tabId,
        )
        .catch((err) => setNotice(err instanceof Error ? err.message : String(err)))
    }, 300)
    return () => clearTimeout(timer)
  }, [fitMode, open, selected, stageSize.width, stageSize.height])

  if (!open) return null

  return (
    /*
      Three rows: the window's own bar, the page's chrome, then whatever is left. Two columns on
      a wide screen — the tab rail and the picture — and one on a narrow one, where the rail is
      hidden and the header's tab picker is the way across windows.
    */
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[100] grid grid-cols-1 grid-rows-[auto_auto_minmax(0,1fr)] bg-background md:grid-cols-[13rem_minmax(0,1fr)]"
    >
      <header className="flex h-12 shrink-0 items-center gap-2.5 border-b border-border/70 px-3 md:col-span-2">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Globe className="h-4 w-4" />
        </span>

        {hasTabs ? (
          <select
            className="h-8 min-w-0 max-w-[440px] flex-1 truncate rounded-lg bg-muted/50 px-2 text-[13px] outline-none transition-colors hover:bg-muted focus:bg-muted"
            value={targetValue}
            onChange={(event) => {
              const [instanceId, tabId] = event.target.value.split('::')
              // Through the window, so its own active tab follows the one being watched and
              // the chrome above (back, reload, address) acts on the page on screen.
              if (instanceId && tabId) void activateTab(instanceId, tabId)
            }}
          >
            {!selected && <option value="">{t('browser.viewerPickTab')}</option>}
            {visibleInstances.map((instance) =>
              (instance.tabs ?? []).map((tab) => (
                <option key={`${instance.id}::${tab.id}`} value={`${instance.id}::${tab.id}`}>
                  {tab.title || tab.url || t('browser.untitledTab')}
                </option>
              )),
            )}
          </select>
        ) : (
          <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
            {loaded ? t('browser.viewerNoTabs') : t('browser.viewerConnecting')}
          </span>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-2">
          {phase !== 'ended' && (
            <span className="hidden items-center gap-1.5 rounded-full border border-border/60 px-2.5 py-1 text-[11.5px] text-muted-foreground sm:inline-flex">
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  live ? 'bg-emerald-500' : 'animate-pulse bg-amber-500',
                )}
              />
              {live
                ? controlled ? t('browser.viewerControlling') : t('browser.viewerLive')
                : t('browser.viewerConnecting')}
              {frameSize && (
                <span className="tabular-nums text-muted-foreground/60">
                  {frameSize.width.toFixed(2)}×{frameSize.height.toFixed(2)}
                </span>
              )}
            </span>
          )}

          {selected && phase !== 'ended' && (
            <button
              type="button"
              onClick={() => { void setControl(!controlled) }}
              disabled={phase === 'connecting'}
              className={cn(
                'inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[12.5px] font-medium transition-colors disabled:opacity-40',
                controlled
                  ? 'border border-accent/40 bg-accent/10 text-accent hover:bg-accent/15'
                  : 'bg-foreground text-background hover:opacity-90',
              )}
            >
              <MousePointerClick className="h-3.5 w-3.5" />
              {controlled ? t('browser.releaseControl') : t('browser.takeOver')}
            </button>
          )}

          <button
            type="button"
            onClick={() => closeView()}
            className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label={t('common.close')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </header>

      {/* Browser chrome: the verbs the window's own toolbar has, acting on the tab on screen. */}
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border/60 px-2.5 md:col-span-2">
        <button
          type="button"
          onClick={() => go('back')}
          disabled={!currentInstance?.canGoBack}
          className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
          aria-label={t('common.back')}
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => go('forward')}
          disabled={!currentInstance?.canGoForward}
          className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
          aria-label={t('common.forward')}
        >
          <ArrowRight className="h-4 w-4" />
        </button>
        {currentInstance?.isLoading ? (
          <button
            type="button"
            onClick={() => go('stop')}
            className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label={t('browser.stopLoading')}
          >
            <Square className="h-3 w-3" />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => go('reload')}
            disabled={!currentInstance}
            className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
            aria-label={t('common.reload')}
          >
            <RotateCw className="h-3.5 w-3.5" />
          </button>
        )}

        {/* The address: what the tab is at, editable, and one Enter away from being where it goes. */}
        <div className="mx-1.5 flex h-8 min-w-0 flex-1 items-center rounded-lg bg-muted/50 px-2.5 transition-colors focus-within:bg-muted">
          <input
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            onFocus={(event) => {
              setEditingAddress(true)
              event.currentTarget.select()
            }}
            onBlur={() => {
              setEditingAddress(false)
              setAddress(currentUrl)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                event.currentTarget.blur()
                void goToAddress()
              } else if (event.key === 'Escape') {
                // Back to the page's address, not out of the viewer.
                event.preventDefault()
                event.stopPropagation()
                setAddress(currentUrl)
                event.currentTarget.blur()
              }
            }}
            placeholder={t('browser.urlPlaceholder')}
            spellCheck={false}
            disabled={!currentInstance}
            className="w-full bg-transparent text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground/50 disabled:opacity-50"
          />
        </div>

        {/* Fit: let the page reflow to the pane, or leave it at its own size. */}
        <button
          type="button"
          onClick={() => setFitMode((value) => !value)}
          disabled={!currentInstance}
          aria-pressed={fitMode}
          aria-label={fitMode ? t('browser.viewerActualSize') : t('browser.viewerFit')}
          className={cn(
            'rounded-lg p-1.5 transition-colors disabled:pointer-events-none disabled:opacity-30',
            fitMode
              ? 'bg-accent/15 text-accent'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground',
          )}
        >
          {fitMode ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
        </button>
      </div>

      {/* Vertical tabs: this window's tabs, the one being watched marked. */}
      <aside className="hidden min-h-0 flex-col overflow-hidden border-r border-border/70 md:flex">
        <div className="flex h-9 shrink-0 items-center justify-between px-3">
          <span className="text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground/70">
            {t('browser.tabs')}
          </span>
          {currentTabs.length > 0 && (
            <span className="tabular-nums text-[10.5px] text-muted-foreground/50">{currentTabs.length}</span>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
          {currentTabs.map((tab) => {
            const watching = tab.id === selected?.tabId
            return (
              <div
                key={tab.id}
                role="button"
                tabIndex={0}
                onClick={() => { if (currentInstance) void activateTab(currentInstance.id, tab.id) }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return
                  event.preventDefault()
                  if (currentInstance) void activateTab(currentInstance.id, tab.id)
                }}
                className={cn(
                  'group flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-[12.5px] transition-colors',
                  watching
                    ? 'bg-foreground/[0.06] text-foreground'
                    : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                )}
              >
                {tab.isLoading ? (
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin opacity-70" />
                ) : tab.favicon ? (
                  <img src={tab.favicon} alt="" className="h-3.5 w-3.5 shrink-0 rounded-[3px] object-cover" />
                ) : (
                  <Globe className="h-3.5 w-3.5 shrink-0 opacity-60" />
                )}
                <span className="min-w-0 flex-1 truncate">
                  {tab.title.trim() || tab.url || t('browser.untitledTab')}
                </span>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation()
                    if (currentInstance) void closeTab(currentInstance.id, tab.id)
                  }}
                  className="shrink-0 rounded p-0.5 text-muted-foreground/60 opacity-0 transition-opacity hover:bg-foreground/10 hover:text-foreground group-hover:opacity-100"
                  aria-label={t('browser.closeTab')}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            )
          })}
          {currentTabs.length === 0 && (
            <p className="px-2 py-3 text-[12px] text-muted-foreground">
              {loaded ? t('browser.viewerNoTabs') : t('browser.viewerConnecting')}
            </p>
          )}
        </div>
        <div className="shrink-0 border-t border-border/60 p-1.5">
          <button
            type="button"
            onClick={() => { if (currentInstance) void openNewTab(currentInstance.id) }}
            disabled={!currentInstance}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[12.5px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
          >
            <Plus className="h-3.5 w-3.5" />
            {t('browser.newTab')}
          </button>
        </div>
      </aside>

      <div ref={stageRef} className="relative min-h-0 min-w-0 overflow-hidden bg-[#0b0c0f]">
        <div
          ref={surfaceRef}
          tabIndex={0}
          className="absolute inset-0 flex cursor-default items-center justify-center outline-none"
          onMouseDown={(event) => {
            // Preventing the default would drop the focus the keyboard needs; take it by hand.
            if (controlled) surfaceRef.current?.focus()
            mouse('down')(event)
          }}
          onMouseUp={mouse('up')}
          onMouseMove={(event) => {
            if (controlled) {
              // The locator marks a point on the page; over the letterbox it would mark nothing.
              if (toTabPoint(event)) moveCursor(event)
              else if (cursorRef.current) cursorRef.current.style.opacity = '0'
            }
            mouse('move')(event)
          }}
          onMouseLeave={() => {
            if (cursorRef.current) cursorRef.current.style.opacity = '0'
          }}
          onContextMenu={(event) => event.preventDefault()}
          onKeyDown={(event) => {
            if (!controlled) return
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
            if (!controlled) return
            event.preventDefault()
            send([{ type: 'key', action: 'up', key: event.key, code: event.code, modifiers: modifiersOf(event) }])
          }}
        >
          {/* One canvas, painted in place. `style` is the measured size, so the picture is never
              blown up past the tab's own pixels; the max-* pair is the placeholder for the moment
              before the stage is measured. */}
          <canvas
            ref={canvasRef}
            style={fit ?? undefined}
            className={cn(
              'max-h-full max-w-full select-none',
              frameSize ? 'animate-[editPopoverFadeIn_180ms_ease-out]' : 'opacity-0',
            )}
          />
        </div>

        {/* The pointer, where it really is: the frames do not carry a cursor of their own. */}
        {controlled && (
          <div
            ref={cursorRef}
            className="pointer-events-none absolute left-0 top-0 z-10 h-5 w-5 rounded-full border border-white/80 bg-white/10 opacity-0 ring-1 ring-black/30 transition-opacity duration-150"
          />
        )}

        {/* Read-only is stated, not implied — including how to leave it. */}
        {live && !controlled && (
          <div className="pointer-events-none absolute inset-x-0 bottom-4 z-10 flex justify-center px-4">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-black/60 px-3 py-1.5 text-[12px] text-white/70 backdrop-blur">
              <Lock className="h-3 w-3" />
              {t('browser.viewerReadOnly')}
            </span>
          </div>
        )}

        {/* A refusal about control or input is news about the session, not a reason to hide the page. */}
        {notice && (
          <div className="absolute inset-x-0 top-0 z-30 flex justify-center px-4 pt-3">
            <div className="flex w-full max-w-xl items-start gap-2 rounded-xl border border-red-400/30 bg-[#2a1113]/95 px-3 py-2.5 text-[12px] text-red-100 shadow-modal-small backdrop-blur">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-300" />
              <span className="min-w-0 flex-1">{notice}</span>
              <button
                type="button"
                onClick={() => setNotice(null)}
                className="shrink-0 rounded-md p-0.5 text-red-200/70 transition-colors hover:bg-white/10 hover:text-red-100"
                aria-label={t('common.close')}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}

        {/* Connected and not painting yet — or not connected yet. Two names, one picture. */}
        {!frameSize && phase !== 'ended' && (!loaded || hasTabs) && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-6 bg-[#0b0c0f]">
            <div className="relative flex h-16 w-16 items-center justify-center">
              <div className="absolute inset-0 rounded-full border border-white/10" />
              <div className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-r-white/15 border-t-white/75" />
              <MonitorPlay className="h-6 w-6 text-white/55" />
            </div>
            <div className="space-y-1.5 px-6 text-center">
              <p className="text-[13.5px] font-medium text-white/90">
                {phase === 'waiting' ? t('browser.viewerWaiting') : t('browser.viewerConnecting')}
              </p>
              <p className="text-[12px] leading-relaxed text-white/40">{t('browser.viewerLoadingHint')}</p>
            </div>
            <div className="h-[3px] w-44 overflow-hidden rounded-full bg-white/10">
              <div className="h-full w-1/2 animate-shimmer-loading rounded-full bg-white/60" />
            </div>
          </div>
        )}

        {/* Nothing to watch at all: the window lives on the server, so this is where it is opened. */}
        {loaded && !hasTabs && phase !== 'ended' && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-[#0b0c0f] px-6">
            <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-white/[0.03] p-7 text-center">
              <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-white/[0.06]">
                <MonitorPlay className="h-5 w-5 text-white/60" />
              </div>
              <p className="text-[13.5px] text-white/90">{t('browser.viewerNoTabs')}</p>
              <p className="mt-1 text-[12px] leading-relaxed text-white/40">{t('browser.viewerNoTabsHint')}</p>
              <button
                type="button"
                onClick={() => { void openBrowser() }}
                className="mt-5 inline-flex h-9 items-center gap-2 rounded-lg bg-white px-4 text-[12.5px] font-medium text-black transition-opacity hover:opacity-90"
              >
                <Globe className="h-4 w-4" />
                {t('browser.openBrowser')}
              </button>
            </div>
          </div>
        )}

        {/* The stream is over. Say why, and offer the one thing worth doing about it. */}
        {phase === 'ended' && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-[#0b0c0f] px-6">
            <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-white/[0.03] p-7 text-center">
              <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-white/[0.06]">
                <TriangleAlert className="h-5 w-5 text-amber-400" />
              </div>
              <p className="text-[13.5px] leading-relaxed text-white/90">{failure ?? t('browser.streamEnded')}</p>
              <div className="mt-5 flex justify-center gap-2">
                {lastTargetRef.current && (
                  <button
                    type="button"
                    onClick={() => { void watch(lastTargetRef.current!) }}
                    className="inline-flex h-9 items-center gap-2 rounded-lg bg-white px-4 text-[12.5px] font-medium text-black transition-opacity hover:opacity-90"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    {t('browser.viewerReconnect')}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => closeView()}
                  className="inline-flex h-9 items-center rounded-lg border border-white/15 px-4 text-[12.5px] text-white/70 transition-colors hover:bg-white/[0.06] hover:text-white"
                >
                  {t('common.close')}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/** The first window's tab to show — the one it is showing, when that is known. */
function firstTab(instances: BrowserInstanceInfo[]): WatchTarget | null {
  for (const instance of instances) {
    const tab = instance.tabs?.find((entry) => entry.active) ?? instance.tabs?.[0]
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
