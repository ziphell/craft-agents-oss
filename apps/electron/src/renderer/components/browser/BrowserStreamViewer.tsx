/**
 * The browser a viewer sees, full screen.
 *
 * A remote window's browser — and the web UI's — is the workspace's browser on **its server**
 * (see docs/browser-view-streaming.md). There is nothing to raise on this machine, so a tab is
 * watched as a stream of frames and input goes back over the same socket.
 *
 * One tab at a time: Chromium's screencast is one stream per CDP session, and the manager fans
 * one tab's capture out to however many viewers ask for it.
 *
 * Two rules this component keeps visible in its UI:
 * - The picture is the page: what is on screen is what a click hits, and typing in the address
 *   bar is the same address bar the window has. Watching is not controlling, though: a tab an
 *   agent holds is shown with its lock, and unlocking that lock is how a person takes the wheel.
 * - The picture is fitted, not cropped: a frame is letterboxed inside the pane, and every
 *   pointer coordinate is mapped through the image's own box so a click lands where it looks.
 *
 * It is a fullscreen overlay in the app's sense of the word: the window's own caption buttons go
 * away while it is up (the same counted request the preview overlays make), it brings one close
 * button instead, and it portals to `document.body` — inside the app's shell its top row would
 * share the window's drag region with the top bar, and the close button there would not be a
 * button at all (see `PreviewHeader`, which every other overlay's header comes from).
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useAtomValue, useSetAtom } from 'jotai'
import { requestWindowControlsHidden, releaseWindowControlsHidden, usePlatform } from '@craft-agent/ui'
import { cn } from '@/lib/utils'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  Globe,
  Loader2,
  Lock,
  Maximize2,
  Minimize2,
  MonitorPlay,
  Plus,
  RefreshCw,
  RotateCw,
  TriangleAlert,
  X,
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from '@/components/ui/styled-dropdown'
import {
  browserViewRequestAtom,
  closeBrowserViewAtom,
  filterInstancesForWorkspace,
  setBrowserInstancesAtom,
} from '@/atoms/browser-pane'
import { browserProfilesAtom, DEFAULT_BROWSER_PROFILE_ID, refreshBrowserProfilesAtom } from '@/atoms/browser-profiles'
import type {
  BrowserInstanceInfo,
  BrowserStreamFrame,
  BrowserStreamInput,
} from '../../../shared/types'

type BrowserTabSummary = NonNullable<BrowserInstanceInfo['tabs']>[number]

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

/** A first frame this late means the capture is not coming: retry, then say so. */
const FIRST_FRAME_TIMEOUT_MS = 9_000

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
  const browserProfiles = useAtomValue(browserProfilesAtom)
  const refreshBrowserProfiles = useSetAtom(refreshBrowserProfilesAtom)
  const open = request.open

  const [instances, setInstances] = useState<BrowserInstanceInfo[]>([])
  /** Whether a list has been read at all — "none open" and "not asked yet" are different screens. */
  const [loaded, setLoaded] = useState(false)
  const [selected, setSelected] = useState<WatchTarget | null>(null)
  /** The same target, readable from callbacks that run before a render. */
  const selectedRef = useRef<WatchTarget | null>(null)
  selectedRef.current = selected
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
  /** A refusal from the server — news, not a reason to cover the picture. */
  const [notice, setNotice] = useState<string | null>(null)
  /** Why the stream is over. */
  const [failure, setFailure] = useState<string | null>(null)

  /** The stream this panel owns. A ref, because frame callbacks arrive outside React's render. */
  const streamRef = useRef<string | null>(null)
  /** Whether the server has accepted input on this stream. */
  const controlRef = useRef(false)
  /** Whether the watched tab is held by an agent — the lock, and the reason input is refused. */
  const heldRef = useRef(false)
  const acquiringRef = useRef(false)
  /** Whether a frame has been painted — a capture that dies before one is a capture that never ran. */
  const sawFrameRef = useRef(false)
  const stallRef = useRef<ReturnType<typeof setTimeout> | null>(null)
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
  /**
   * A start request is in flight, so frames reaching this panel have no stream id to match yet.
   *
   * The server takes the seed still the moment the capture is asked for, and it travels the same
   * socket as the answer to that request — so on a warm page the picture can arrive *first*.
   * Dropping it leaves a still page (a new tab, a blank page) on "waiting for the picture" for
   * good, which is what reopening the viewer on such a tab did.
   */
  const startingRef = useRef(false)
  /** A frame that arrived before its stream was named, kept for `watch` to adopt. */
  const unclaimedFrameRef = useRef<BrowserStreamFrame | null>(null)
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
  const visibleInstances = filterInstancesForWorkspace(instances, workspaceId ?? null)
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

  /** The first frame is the only proof a capture is alive; this is the timer that says it is not. */
  const clearStallTimer = useCallback(() => {
    if (stallRef.current) {
      clearTimeout(stallRef.current)
      stallRef.current = null
    }
  }, [])

  const stop = useCallback(async () => {
    const streamId = streamRef.current
    streamRef.current = null
    startingRef.current = false
    unclaimedFrameRef.current = null
    controlRef.current = false
    heldRef.current = false
    sawFrameRef.current = false
    clearStallTimer()
    clearPicture()
    if (cursorRef.current) cursorRef.current.style.opacity = '0'
    if (reconnectRef.current.timer) {
      clearTimeout(reconnectRef.current.timer)
      reconnectRef.current.timer = null
    }
    enterPhase('idle')
    if (streamId) {
      await window.electronAPI.browserPane.streamStop(streamId).catch(() => {})
    }
  }, [clearPicture, clearStallTimer, enterPhase])

  /**
   * Ask the server for input on this stream.
   *
   * Control is taken when the tab is free, so watching a free tab is the same as operating it.
   * A tab an agent holds is different: that lock is the agent's, and it is not taken from
   * under it by this panel (`heldRef`, refreshed from the state push). The lock in the rail is
   * the way in — clicking it releases the hold and then asks for control (`takeOver`).
   */
  const acquireControl = useCallback(async (streamId: string) => {
    if (controlRef.current || acquiringRef.current) return
    acquiringRef.current = true
    try {
      await window.electronAPI.browserPane.streamControl(streamId, true)
      if (streamRef.current === streamId) {
        controlRef.current = true
        setNotice(null)
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err))
    } finally {
      acquiringRef.current = false
    }
  }, [])

  /**
   * Take the wheel on a held tab.
   *
   * The purple lock is the agent's claim, and unlocking it is the person asking for their own
   * half back: the claim stays (sibling conversations are still kept out), the overlay goes,
   * and this stream asks for input. The agent keeps working — the highlight stays — but the
   * tab is the person's to type into again.
   */
  const takeOver = useCallback(async (instanceId: string, tabId: string) => {
    try {
      await window.electronAPI.browserPane.tabAction({ instanceId, action: 'release', tabId })
      const streamId = streamRef.current
      const target = selectedRef.current
      if (!streamId || target?.instanceId !== instanceId || target.tabId !== tabId) return
      // The dismissal is the takeover request; the state push it causes also clears `heldRef`.
      // Asking here as well is the fast path, and a refusal (the claim changed under us)
      // leaves the lock in place rather than starting a retry fight with it.
      controlRef.current = false
      await acquireControl(streamId)
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err))
    }
  }, [acquireControl])

  /**
   * Paint one frame of this panel's stream, and take it as proof the stream is real.
   *
   * Called from the frame listener for the ordinary case, and from `watch` for a frame that
   * arrived before the start's answer named its stream (`unclaimedFrameRef`) — a seed of a still
   * page is the only picture that page will ever send, so dropping it costs the whole view.
   */
  const handleFrame = useCallback((incoming: BrowserStreamFrame) => {
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
      sawFrameRef.current = true
      clearStallTimer()
      enterPhase('live')
    }
    // Ask again only while the tab is free. A held tab is not taken over from under the
    // agent by a stream ticking; the lock in the rail is the way in.
    const streamId = streamRef.current
    if (streamId && !controlRef.current && !heldRef.current) void acquireControl(streamId)
    drawLatest()
  }, [acquireControl, clearStallTimer, drawLatest, enterPhase])

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
    // The target is claimed *before* the stop: stopping is an await, and a list that arrives in
    // that gap must not read "nothing selected, nothing streaming" and start a second watch of
    // the same panel (the auto-pick effect's guard is exactly those two facts).
    setSelected(target)
    selectedRef.current = target
    await stop()
    enterPhase('connecting')
    startingRef.current = true
    let started: Awaited<ReturnType<typeof window.electronAPI.browserPane.streamStart>>
    try {
      started = await window.electronAPI.browserPane.streamStart(target)
    } catch (err) {
      startingRef.current = false
      // The common refusals are "already being recorded" and "the tab is gone" — say it.
      setSelected(null)
      setFailure(err instanceof Error ? err.message : String(err))
      enterPhase('ended')
      return
    }
    startingRef.current = false

    streamRef.current = started.streamId
    sawFrameRef.current = false
    // Connected, but nothing painted yet — a still page can take a moment to send its first
    // frame, and that is a different state to "not connected".
    enterPhase('waiting')
    // The start result carries the lock and whether the person already dismissed their half
    // of it. A held tab that has not been dismissed is not claimed by this stream; a dismissed
    // one is the person's to use even though the agent's claim is still there.
    heldRef.current = started.lockedBy != null && !started.overlayDismissed
    if (!heldRef.current) void acquireControl(started.streamId)
    clearStallTimer()
    stallRef.current = setTimeout(() => {
      stallRef.current = null
      if (streamRef.current !== started.streamId) return
      streamRef.current = null
      controlRef.current = false
      clearPicture()
      void window.electronAPI.browserPane.streamStop(started.streamId).catch(() => {})
      const next = lastTargetRef.current
      if (next && reconnectRef.current.attempts < 1) {
        reconnectRef.current.attempts += 1
        enterPhase('connecting')
        reconnectRef.current.timer = setTimeout(() => {
          reconnectRef.current.timer = null
          void watch(next, true)
        }, 400)
        return
      }
      setSelected(null)
      setFailure(t('browser.viewerNoFrames'))
      enterPhase('ended')
    }, FIRST_FRAME_TIMEOUT_MS)

    // A picture that beat the start's answer — the seed of a still page, usually — belongs to
    // this stream if it names it: paint it now, or the pane waits for a repaint that never comes.
    const early = unclaimedFrameRef.current
    unclaimedFrameRef.current = null
    if (early && early.streamId === streamRef.current) handleFrame(early)
  }, [stop, enterPhase, acquireControl, clearStallTimer, clearPicture, handleFrame, t])

  /**
   * Open — or bring up — the window of one profile on the server, and watch its tab.
   *
   * `show` is off because this is a *viewing* act: the window belongs to the server, and the
   * person doing it is looking through this viewer, not at that machine. Bringing it up there
   * would put a window on someone else's desktop and take the focus from whatever they were
   * doing — so it is born hidden and its tab lives in the parking window, exactly what an agent
   * opening the browser does. `profileId` is the window's whole identity on the host — one window
   * per workspace per profile — so asking again for the same one reuses it rather than making a
   * second. No id means the workspace's default.
   */
  const openBrowser = useCallback(async (profileId?: string) => {
    try {
      const instanceId = await window.electronAPI.browserPane.create({
        show: false,
        ...(profileId ? { profileId } : {}),
      })
      const next = await window.electronAPI.browserPane.list()
      setInstances(next)
      setBrowserInstances(next)
      const instance = next.find((item) => item.id === instanceId)
      const tab = instance?.tabs?.find((entry) => entry.active) ?? instance?.tabs?.[0]
      if (tab) await watch({ instanceId, tabId: tab.id })
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err))
    }
  }, [setBrowserInstances, watch])

  // Names for the rail; a profile can be created or renamed while the app is open.
  useEffect(() => {
    if (!open) return
    void refreshBrowserProfiles()
  }, [open, refreshBrowserProfiles])

  // A fullscreen overlay puts the window's own controls away while it is up — the counted
  // request the preview overlays use, so a preview closing under this one cannot bring them
  // back over it. On Windows those are the app's buttons (`App` stops drawing them); on macOS
  // it is the traffic lights, hidden by the main process. A *layout* effect, so the buttons are
  // gone in the same commit that paints this overlay rather than a frame after it.
  const { onSetTrafficLightsVisible } = usePlatform()
  const setWindowControls = useRef(onSetTrafficLightsVisible)
  useEffect(() => {
    setWindowControls.current = onSetTrafficLightsVisible
  }, [onSetTrafficLightsVisible])
  useLayoutEffect(() => {
    if (!open) return
    if (requestWindowControlsHidden()) setWindowControls.current?.(false)
    return () => {
      if (releaseWindowControlsHidden()) setWindowControls.current?.(true)
    }
  }, [open])

  // Frames for whichever stream this panel owns, and a fresh list whenever a window changes.
  useEffect(() => {
    if (!open) return
    const offFrame = window.electronAPI.browserPane.onStreamFrame((incoming) => {
      const streamId = streamRef.current
      if (!streamId) {
        // Not named yet: the start's answer is still in flight. Keep the newest picture so
        // `watch` can adopt it — for a still page this is the only frame there will ever be.
        if (startingRef.current) {
          unclaimedFrameRef.current = incoming
          return
        }
        return
      }
      if (incoming.streamId !== streamId) return
      handleFrame(incoming)
    })
    // The stream can end without us: its tab was closed, its window went away, or capture lost
    // its session. A few silent retries first — most of these are a tab reload or a capture
    // hiccup, and "reconnect" is a poor first answer to both.
    const offEnded = window.electronAPI.browserPane.onStreamEnded((streamId) => {
      if (streamId !== streamRef.current) return
      streamRef.current = null
      controlRef.current = false
      const sawFrame = sawFrameRef.current
      sawFrameRef.current = false
      clearStallTimer()
      clearPicture()
      const target = lastTargetRef.current
      const attempt = reconnectRef.current.attempts
      if (target && attempt < 3) {
        reconnectRef.current.attempts = attempt + 1
        enterPhase('connecting')
        // A capture that died without a single frame is usually a page that was still
        // navigating (a brand-new tab, a reload): its renderer swap ends the capture. Retrying
        // on a slower cadence than the backoff for a stream that had been painting is what gets
        // past it — and the wait has to outlast that load, not just be "soon".
        const delay = sawFrame ? 1_000 * 2 ** attempt : 800 * (attempt + 1)
        reconnectRef.current.timer = setTimeout(() => {
          reconnectRef.current.timer = null
          void watch(target, true)
        }, delay)
        return
      }
      setSelected(null)
      setFailure(t('browser.streamEnded'))
      enterPhase('ended')
    })
    // The window moved on without us: a new tab, a link followed on it, the agent activating
    // another one. What the window *shows* is what this viewer is for, so the stream follows —
    // otherwise the chrome (address, back, reload) acts on one tab while the picture is another,
    // which reads as "the address bar does nothing".
    const offState = window.electronAPI.browserPane.onStateChanged((info) => {
      setInstances((previous) => {
        const index = previous.findIndex((item) => item.id === info.id)
        if (index === -1) return [...previous, info]
        const next = [...previous]
        next[index] = info
        return next
      })
      const target = selectedRef.current
      if (!target || target.instanceId !== info.id) return
      const watched = info.tabs?.find((tab) => tab.id === target.tabId)
      if (watched) {
        const wasHeld = heldRef.current
        heldRef.current = watched.lockedBy !== null && !watched.overlayDismissed
        // The person got the tab back (dismissed the overlay, or the agent let go): it is
        // theirs again, so the stream asks for control without a second gesture.
        if (wasHeld && !heldRef.current && !controlRef.current) {
          const streamId = streamRef.current
          if (streamId) void acquireControl(streamId)
        }
      }
      const active = info.tabs?.find((tab) => tab.active)?.id
      if (!active || active === target.tabId) return
      void watch({ instanceId: info.id, tabId: active })
    })
    // A window that went away is not a row in the rail. The watched one ends through
    // `onStreamEnded`; this is for the others.
    const offRemoved = window.electronAPI.browserPane.onRemoved((id) => {
      setInstances((previous) => previous.filter((item) => item.id !== id))
    })
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
      offRemoved()
      offReconnected()
    }
  }, [open, load, enterPhase, t, drawLatest, clearPicture, clearStallTimer, watch, acquireControl, handleFrame])

  // Closing the panel (or leaving the page) ends the stream; a viewer is not a background job.
  // It does not end the *browser*: the window and its tabs are the server's, and the shared list
  // is what the top bar's badge and the composer's chip read. Emptying it here is what turned the
  // badge back into "open browser" the moment this panel closed, with the window still running.
  useEffect(() => {
    if (open) return
    void stop()
    setSelected(null)
    setFailure(null)
    setNotice(null)
  }, [open, stop])
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

  // The keyboard belongs to the page once there is a page. Not while the address bar is being
  // used: the person is typing there, and taking the focus would eat the first keystroke.
  useEffect(() => {
    if (!open || phase !== 'live') return
    if (document.activeElement instanceof HTMLInputElement) return
    surfaceRef.current?.focus()
  }, [open, phase])

  // Escape closes the viewer, as it does every other fullscreen overlay. It is not forwarded to
  // the page: the overlay is what a person is looking at, and "leave" has to be one keystroke.
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      closeView()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, closeView])

  const send = useCallback((events: BrowserStreamInput[]) => {
    const streamId = streamRef.current
    if (!streamId || events.length === 0) return
    if (!controlRef.current) {
      // A held tab is not typed into, and not taken over by typing either: the lock is the
      // gesture. A free tab is claimed on the first input that beats the control request.
      if (!heldRef.current) void acquireControl(streamId)
      return
    }
    void window.electronAPI.browserPane.streamInput(streamId, events).catch((err) => {
      // The agent took the tab, or the stream ended: say why and try again on the next frame.
      controlRef.current = false
      setNotice(err instanceof Error ? err.message : String(err))
    })
  }, [acquireControl])

  /**
   * The wheel is a native listener, not `onWheel`.
   *
   * React registers wheel handlers as passive, so `preventDefault` there is ignored (and logged):
   * the gesture would scroll whatever is behind the pane *and* reach the page. Attached by hand
   * it can claim the gesture, and it is attached once per phase rather than per frame.
   */
  useEffect(() => {
    const surface = surfaceRef.current
    if (phase !== 'live' || !surface) return
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
  }, [phase, send])

  /**
   * Client coordinates → the tab's CSS pixels.
   *
   * Measured on the **picture** rather than its container: the picture is fitted into the pane,
   * so its own box already excludes the letterbox bars. That is what makes a click land where
   * it looked, at any window size and any tab aspect ratio.
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
    if (phaseRef.current !== 'live') return
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

  const live = phase === 'live'
  const hasTabs = visibleInstances.length > 0

  /**
   * What the picture measures on screen.
   *
   * `frameSize` is the tab's CSS viewport and changes when the tab is resized, so the basis is
   * never stale. The scale is capped at 1 in both modes — the pane may be larger than the page,
   * and a page is not a poster. Fit mode changes how big the *page* is (it reflows to the pane);
   * it does not license blowing the picture up past its own pixels, so a pane the host cannot
   * fill is letterboxed rather than magnified.
   *
   * The size is left exactly as the scale computes it: rounding it would drop a fraction of a
   * pixel on each axis, which shows up as an uneven letterbox and a picture that creeps off
   * centre. Only the labels are rounded, and only for reading.
   */
  const fit = frameSize && frameSize.width > 0 && frameSize.height > 0
    && stageSize.width > 0 && stageSize.height > 0
    ? (() => {
        const scale = Math.min(1, stageSize.width / frameSize.width, stageSize.height / frameSize.height)
        return {
          width: frameSize.width * scale,
          height: frameSize.height * scale,
          scale,
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
   * under the caret would fight the person for the very field they are editing. A navigation
   * that was just sent also keeps its text until the page reports the new address.
   */
  const [address, setAddress] = useState('')
  const [editingAddress, setEditingAddress] = useState(false)
  const navigatingRef = useRef(false)
  useEffect(() => {
    if (editingAddress) return
    navigatingRef.current = false
    setAddress(currentUrl)
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
    // The window's own state push may have moved the viewer already (`onStateChanged`); a second
    // watch here would stop the stream it just started.
    const current = selectedRef.current
    if (current?.instanceId === instanceId && current.tabId === tabId) return
    await watch({ instanceId, tabId })
  }, [watch])

  /**
   * A new tab starts on the window's empty-state document. The window's own state push is what
   * moves this viewer onto it (see `onStateChanged`), so a new tab needs no second decision
   * here; the check after the pause is the fallback for a push that never arrives, and it waits
   * long enough for the empty-state load to commit — a capture started before that commit dies
   * with the renderer swap it causes.
   */
  const openNewTab = useCallback(async (instanceId: string) => {
    try {
      await window.electronAPI.browserPane.tabAction({ instanceId, action: 'new' })
      await sleep(600)
      const next = await reloadList()
      const active = next.find((item) => item.id === instanceId)?.tabs?.find((tab) => tab.active)?.id
      const target = selectedRef.current
      if (active && (!target || target.instanceId !== instanceId || target.tabId !== active)) {
        await watch({ instanceId, tabId: active })
      }
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
    // The window the stream is on, not a lookup that can be a beat behind a new tab.
    const instanceId = currentInstance?.id ?? selected?.instanceId
    const target = address.trim()
    if (!instanceId || !target) return
    navigatingRef.current = true
    try {
      // As typed: the server normalises, and a bare word is a search there.
      await window.electronAPI.browserPane.navigate(instanceId, target)
    } catch (err) {
      navigatingRef.current = false
      setAddress(currentUrl)
      setNotice(err instanceof Error ? err.message : String(err))
    }
  }, [address, currentInstance?.id, selected?.instanceId, currentUrl])

  /**
   * Fit mode: ask the tab to reflow to the pane, instead of drawing a bigger page small inside
   * it. Debounced — a window drag is one request when it settles, not sixty.
   *
   * It reflows the page, which is the point. On a tab that is on screen at the hub that means
   * sizing the hub's window, which the desktop may keep within the screen; a tab in the parking
   * window can simply be given the size. Either way the page's viewport is the host's answer,
   * and the picture is shown at no more than 1:1 (`fit`), so a pane the host cannot fill is
   * letterboxed rather than magnified.
   *
   * The request is re-sent when `frameSize` changes, and when the window's visibility or
   * minimized state changes: those are the page saying its viewport moved under us — the tab went
   * into the hub's window or back into the parking window (minimise, hide, restore), or the
   * window was resized. Without that, coming back from the parking window left fit at whatever
   * size the visible window had last allowed.
   */
  useEffect(() => {
    if (!fitMode || !open || !selected) return
    if (stageSize.width <= 0 || stageSize.height <= 0) return
    const width = Math.round(stageSize.width)
    const height = Math.round(stageSize.height)
    const timer = setTimeout(() => {
      void window.electronAPI.browserPane
        .resizeViewport(selected.instanceId, width, height, selected.tabId)
        .catch((err) => setNotice(err instanceof Error ? err.message : String(err)))
    }, 250)
    return () => clearTimeout(timer)
  }, [
    fitMode,
    open,
    selected,
    stageSize.width,
    stageSize.height,
    frameSize?.width,
    frameSize?.height,
    currentInstance?.isVisible,
    currentInstance?.isMinimized,
  ])

  if (!open) return null

  const statusLabel = phase === 'live'
    ? t('browser.viewerLive')
    : phase === 'waiting'
      ? t('browser.viewerWaiting')
      : phase === 'ended'
        ? t('browser.viewerEnded')
        : t('browser.viewerConnecting')

  /**
   * The bar is the browser's title; the profile is what it can be switched by.
   *
   * The tab on screen already names itself in the rail and in the address field, so a third
   * copy here read as a duplicate row rather than a title. With only the built-in profile there
   * is nothing to switch to, and the bar says just "Browser"; once there are several, it says
   * which one is on screen and becomes the switch.
   */
  const activeProfileId = currentInstance
    ? (currentInstance.profileId ?? DEFAULT_BROWSER_PROFILE_ID)
    : undefined
  const knownProfile = activeProfileId
    ? browserProfiles.find((profile) => profile.id === activeProfileId)
    : undefined
  /**
   * Every profile the bar can switch to: the registry, plus a window whose profile has been
   * deleted — that window is still usable, so leaving it out would strand it.
   */
  const profileChoices = [
    ...browserProfiles.map((profile) => ({ id: profile.id, name: profile.name })),
    ...visibleInstances
      .map((instance) => instance.profileId ?? DEFAULT_BROWSER_PROFILE_ID)
      .filter((id, index, all) => all.indexOf(id) === index)
      .filter((id) => !browserProfiles.some((profile) => profile.id === id))
      .map((id) => ({ id, name: t('composer.browserProfileMissing') })),
  ]
  const profileName = knownProfile?.name
    ?? (activeProfileId && browserProfiles.length > 0
      ? t('composer.browserProfileMissing')
      : undefined)
  const headerLabel = profileName && profileChoices.length > 1
    ? `${t('browser.viewerTitle')} · ${profileName}`
    : t('browser.viewerTitle')
  const tabCountOf = (profileId: string): number =>
    visibleInstances.find(
      (instance) => (instance.profileId ?? DEFAULT_BROWSER_PROFILE_ID) === profileId,
    )?.tabs?.length ?? 0

  return createPortal(
    /*
      Rows: the viewer's own bar, then the rail and the page side by side. The status line is
      the *page's*, so it sits at the bottom of the page's column — the rail keeps its full
      height, and the line reports on the picture rather than on the window.

      Portaled to `document.body`, like every other fullscreen overlay: inside the app's shell
      its top edge would sit under the bar that is the window's drag region, and a click meant
      for this overlay's own header would be read by the OS as a click on the title bar.
    */
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('browser.viewerTitle')}
      className="fixed inset-0 flex flex-col bg-background"
      style={{ zIndex: 'var(--z-fullscreen, 350)', WebkitAppRegion: 'no-drag' } as CSSProperties}
    >
      {/* The bar is the handle: it is the window's title bar while this overlay is up. Only the
          controls opt out, so the profile switch and the close button are buttons and not places
          to drag from. The profile sits in the middle — the bar's one subject — and the close
          button is pinned right so the two never trade places with the label's length. */}
      <header
        className="relative flex h-12 shrink-0 items-center justify-center border-b border-border/70 px-3"
        style={{ WebkitAppRegion: 'drag' } as CSSProperties}
      >
        <div className="flex min-w-0 max-w-[min(60%,28rem)] items-center justify-center">
          {profileChoices.length > 1 ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="flex h-8 min-w-0 items-center gap-1.5 rounded-lg px-2 text-[13px] font-medium text-foreground transition-colors hover:bg-muted"
                  style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
                  title={headerLabel}
                  aria-label={t('browser.switchProfile')}
                >
                  <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{headerLabel}</span>
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
                </button>
              </DropdownMenuTrigger>
              {/* Above the overlay (z 350): this menu belongs to it, not to the app behind it. */}
              <StyledDropdownMenuContent
                align="center"
                className="min-w-48"
                style={{ zIndex: 'var(--z-floating-menu, 400)' }}
              >
                {profileChoices.map((profile) => {
                  const count = tabCountOf(profile.id)
                  return (
                    <StyledDropdownMenuItem
                      key={profile.id}
                      onSelect={() => {
                        // Already looking at it: re-watching would stop and restart the stream
                        // for no change on screen.
                        if (profile.id === activeProfileId) return
                        void openBrowser(profile.id)
                      }}
                    >
                      <Check
                        className={cn(
                          'h-3.5 w-3.5 shrink-0',
                          profile.id === activeProfileId ? 'opacity-100' : 'opacity-0',
                        )}
                      />
                      <span className="min-w-0 flex-1 truncate">{profile.name}</span>
                      {count > 0 && (
                        <span className="ml-2 shrink-0 tabular-nums text-[11px] text-muted-foreground/60">
                          {count}
                        </span>
                      )}
                    </StyledDropdownMenuItem>
                  )
                })}
              </StyledDropdownMenuContent>
            </DropdownMenu>
          ) : (
            <span
              className="flex h-8 min-w-0 items-center gap-1.5 px-2 text-[13px] font-medium text-foreground"
              title={headerLabel}
            >
              <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{headerLabel}</span>
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => closeView()}
          className="absolute right-3 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
          aria-label={t('common.close')}
          title={t('common.closeEsc')}
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        {/*
          The watched window's tabs. Other windows are reached through the profile switch in the
          bar — one window per profile — so this is a tab list, not a list of every window's
          tabs with headings to tell the identical ones apart.
        */}
        <aside className="flex w-40 shrink-0 flex-col overflow-hidden border-r border-border/70 md:w-52">
          <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2 pt-1.5">
            {currentInstance && currentInstance.tabs?.map((tab) => (
              <TabRow
                key={tab.id}
                tab={tab}
                watching={selected?.instanceId === currentInstance.id && selected.tabId === tab.id}
                onActivate={() => { void activateTab(currentInstance.id, tab.id) }}
                onClose={() => { void closeTab(currentInstance.id, tab.id) }}
                closeLabel={t('browser.closeTab')}
                untitledLabel={t('browser.untitledTab')}
                agentWorkingLabel={t('browser.tabInUse')}
                agentDrivenLabel={t('browser.tabDriven')}
                takeOverLabel={t('browser.takeOverTab')}
                onTakeOver={
                  selected?.instanceId === currentInstance.id && selected.tabId === tab.id
                    ? () => { void takeOver(currentInstance.id, tab.id) }
                    : undefined
                }
              />
            ))}
            {!hasTabs && (
              <p className="px-2 py-3 text-[12px] text-muted-foreground">
                {loaded ? t('browser.viewerNoTabs') : t('browser.viewerConnecting')}
              </p>
            )}
            {/* A new tab is one more row in the list, directly under the last one — where the
                tab it adds will appear. Pinned to the rail's bottom it read as a control of the
                rail rather than as part of the window's tab strip. */}
            {currentInstance && (
              <button
                type="button"
                onClick={() => { void openNewTab(currentInstance.id) }}
                className="mt-0.5 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[12.5px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
              >
                <Plus className="h-3.5 w-3.5" />
                {t('browser.newTab')}
              </button>
            )}
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* Browser chrome: the verbs the window's own toolbar has, acting on the tab on screen. */}
          <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border/60 px-2.5">
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
                {/* The same box as the reload mark: swapping a 12px square for a 14px glyph
                    moved the address field a pixel every time a page started loading. */}
                <X className="h-3.5 w-3.5" />
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
                  if (!navigatingRef.current) setAddress(currentUrl)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    setEditingAddress(false)
                    void goToAddress()
                    event.currentTarget.blur()
                  } else if (event.key === 'Escape') {
                    // Back to the page's address, not out of the viewer.
                    event.preventDefault()
                    event.stopPropagation()
                    setEditingAddress(false)
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
          </div>

          <div ref={stageRef} className="relative min-h-0 flex-1 overflow-hidden bg-[#0b0c0f]">
            <div
              ref={surfaceRef}
              tabIndex={0}
              className="absolute inset-0 flex cursor-default items-center justify-center outline-none"
              onMouseDown={(event) => {
                // Preventing the default would drop the focus the keyboard needs; take it by hand.
                surfaceRef.current?.focus()
                mouse('down')(event)
              }}
              onMouseUp={mouse('up')}
              onMouseMove={(event) => {
                // The locator marks a point on the page; over the letterbox it would mark nothing.
                if (toTabPoint(event)) moveCursor(event)
                else if (cursorRef.current) cursorRef.current.style.opacity = '0'
                mouse('move')(event)
              }}
              onMouseLeave={() => {
                if (cursorRef.current) cursorRef.current.style.opacity = '0'
              }}
              onContextMenu={(event) => event.preventDefault()}
              onKeyDown={(event) => {
                if (event.key === 'Escape') return
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
                if (event.key === 'Escape') return
                event.preventDefault()
                send([{ type: 'key', action: 'up', key: event.key, code: event.code, modifiers: modifiersOf(event) }])
              }}
            >
              {/* One canvas, painted in place. `style` is the measured size, so the picture is never
                  blown up past the tab's own pixels; the max-* pair is the placeholder for the
                  moment before the stage is measured. */}
              <canvas
                ref={canvasRef}
                style={fit ? { width: fit.width, height: fit.height } : undefined}
                className={cn(
                  'max-h-full max-w-full select-none',
                  frameSize ? 'animate-[editPopoverFadeIn_180ms_ease-out]' : 'opacity-0',
                )}
              />
            </div>

            {/* The pointer, where it really is: the frames do not carry a cursor of their own. */}
            {live && (
              <div
                ref={cursorRef}
                className="pointer-events-none absolute left-0 top-0 z-10 h-5 w-5 rounded-full border border-white/80 bg-white/10 opacity-0 ring-1 ring-black/30 transition-opacity duration-150"
              />
            )}

            {/* A refusal from the server is news about the session, not a reason to hide the page. */}
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

            {/* Connected and not painting yet — or not connected yet. One line, because the
                phase is not something a person acts on; the status line at the bottom already
                carries the same state for when this overlay is gone. */}
            {!frameSize && phase !== 'ended' && (!loaded || hasTabs) && (
              <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-6 bg-[#0b0c0f]">
                <div className="relative flex h-16 w-16 items-center justify-center">
                  <div className="absolute inset-0 rounded-full border border-white/10" />
                  <div className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-r-white/15 border-t-white/75" />
                  <MonitorPlay className="h-6 w-6 text-white/55" />
                </div>
                <p className="px-6 text-center text-[13.5px] font-medium text-white/90">
                  {phase === 'waiting' ? t('browser.viewerWaiting') : t('browser.viewerConnecting')}
                </p>
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

          {/* The status line: how the picture is arriving, and at what size. It belongs to the
              page, so it closes the page's column — the rail runs past it to the window's edge. */}
          <footer className="flex h-8 shrink-0 items-center gap-3 border-t border-border/70 bg-muted/30 px-3 text-[11px] text-muted-foreground">
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <span
                className={cn(
                  'h-1.5 w-1.5 shrink-0 rounded-full',
                  live ? 'bg-emerald-500' : phase === 'ended' ? 'bg-red-400' : 'animate-pulse bg-amber-500',
                )}
              />
              {/* While the loading overlay is up it already says what is happening; the strip
                  keeps the dot (and a spinner) rather than repeating the sentence below it. */}
              {(live || phase === 'ended') && <span className="truncate">{statusLabel}</span>}
              {!live && phase !== 'ended' && <Loader2 className="h-3 w-3 shrink-0 animate-spin opacity-60" />}
            </span>
            <span className="ml-auto shrink-0 tabular-nums">
              {frameSize ? `${Math.round(frameSize.width)}×${Math.round(frameSize.height)}` : '—'}
              {fit && ` · ${Math.round(fit.scale * 100)}%`}
            </span>
            {/* Fit: let the page reflow to the pane, or draw it at its own size. Named, because
                an icon alone does not say which of the two it is; the status line is where the
                picture is described, so the switch sits with the size it changes. */}
            <button
              type="button"
              onClick={() => setFitMode((value) => !value)}
              disabled={!currentInstance}
              aria-pressed={fitMode}
              title={fitMode ? t('browser.viewerFit') : t('browser.viewerActualSize')}
              className={cn(
                'flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[10.5px] transition-colors disabled:pointer-events-none disabled:opacity-40',
                fitMode
                  ? 'bg-accent/15 text-accent'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              {fitMode ? <Maximize2 className="h-3 w-3" /> : <Minimize2 className="h-3 w-3" />}
              <span className="hidden sm:inline">{fitMode ? t('browser.viewerFit') : t('browser.viewerActualSize')}</span>
            </button>
          </footer>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/** One tab in the rail: the page, and — on hover — its close button. */
function TabRow({
  tab,
  watching,
  onActivate,
  onClose,
  closeLabel,
  untitledLabel,
  agentWorkingLabel,
  agentDrivenLabel,
  takeOverLabel,
  onTakeOver,
}: {
  tab: BrowserTabSummary
  watching: boolean
  onActivate: () => void
  onClose: () => void
  closeLabel: string
  untitledLabel: string
  agentWorkingLabel: string
  agentDrivenLabel: string
  takeOverLabel: string
  /** Present only on the tab being watched: unlocking is a takeover of *this* page. */
  onTakeOver?: () => void
}) {
  // Two facts, two marks: the highlight says an agent is holding this tab right now (it stays
  // through the person's dismissal — the claim did not move), the purple lock is only the part
  // of the hold the person can still dismiss, and the dot says the tab was driven earlier and
  // is not being worked on now.
  const working = tab.lockedBy !== null
  const holding = tab.lockedBy !== null && !tab.overlayDismissed
  const driven = !working && tab.drivenBy !== null
  const label = tab.title.trim() || tab.url || untitledLabel

  // Switching happens on **press**, not on release: a tab strip switches as the pointer goes
  // down. Waiting for the click made a press that slid a little feel like nothing happened, and a
  // release outside the row cancelled a switch the person had already committed to. Keyboard
  // activation has no pointerdown, so Enter/Space stay on `onKeyDown`.
  return (
    <div
      role="button"
      tabIndex={0}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        onActivate()
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        onActivate()
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
      <span className="relative min-w-0 flex-1" title={working ? agentWorkingLabel : undefined}>
        <span className="block truncate">{label}</span>
        {working && (
          <span aria-hidden className="tab-title-shimmer pointer-events-none absolute inset-0 truncate">
            {label}
          </span>
        )}
      </span>
      {/* The row switches on pointerdown, so a press that starts here would switch the tab
          before this button sees its click. The lock is about this tab, not about moving to it. */}
      {holding && onTakeOver && (
        <button
          type="button"
          aria-label={takeOverLabel}
          title={takeOverLabel}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation()
            onTakeOver()
          }}
          className="shrink-0 rounded p-0.5 text-accent transition-colors hover:bg-accent/10"
        >
          <Lock className="h-3 w-3" />
        </button>
      )}
      {driven && (
        <span
          aria-label={agentDrivenLabel}
          title={agentDrivenLabel}
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
        />
      )}
      {/* Closing must not also switch to the tab being closed. */}
      <button
        type="button"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation()
          onClose()
        }}
        className="shrink-0 rounded p-0.5 text-muted-foreground/60 opacity-0 transition-opacity hover:bg-foreground/10 hover:text-foreground group-hover:opacity-100"
        aria-label={closeLabel}
      >
        <X className="h-3 w-3" />
      </button>
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
