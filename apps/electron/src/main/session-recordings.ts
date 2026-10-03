/**
 * A conversation's recordings: what is running, and what ends them.
 *
 * Three pieces meet here, and none of them knows about the others:
 *
 *   `BrowserCDP.startScreencast`   the frames — the page as a stream (`browser-cdp.ts`)
 *   `openRecordingEncoder`         the file's encoder, a hidden window (`recording-encoder.ts`)
 *   `TabRecorder`                  the file, and the `(owner, tab)` entry that names it
 *
 * **Ending is the part that has to be in one place.** A recording can end because someone asked,
 * because its deadline arrived, because the tab went away, because the session did, or because
 * its own capture or encoder died — and every one of those has to run the same three steps in the
 * same order: stop the capture, stop the encoder (**and wait for its tail**, or the file is short
 * by the last quarter-second), and only then let the entry settle. Spread that out and the
 * failure is a film that ends mid-action, or a hidden window that outlives the recording.
 *
 * The service is therefore the only writer for a conversation's recordings. `TabRecorder` is
 * still the single writer for the *person's*, which never comes through here: the button, its
 * display-media door and its downloads folder are all that path's own (`browser-toolbar.tsx`).
 */

import type { WebContents } from 'electron'
import type { TabRecorder, TabRecordingState, FinishedRecording } from './tab-recorder.ts'
import type { RecordingEncoder } from './recording-encoder.ts'

/** Why a recording ended. Kept as words because it is reported to whoever asked. */
export type EndReason = 'asked' | 'deadline' | 'the tab went away' | 'the session went away' | 'its capture ended' | 'stop failed'

export interface StartSessionRecordingOptions {
  sessionId: string
  /** The tab being recorded. Named, never guessed — this is what a stop has to match. */
  tabId: string
  /** Where the file goes. The caller owns this convention (a session's `records/`). */
  dir: string
  /** The tab's contents — what the file's entry records as the source. */
  source: WebContents
  /** How long, in ms. Required, and the only thing that bounds a recording. */
  ttlMs: number
  /** The tab's own CDP session, where the capture runs. */
  capture: {
    startScreencast: (options: {
      onFrame: (frame: { bytes: Buffer; offsetMs: number }) => void
      onEnd?: (reason: string) => void
    }) => Promise<void>
    stopScreencast: () => Promise<void>
  }
  /** The size to encode at — the tab's view, in device pixels. */
  size: { width: number; height: number }
  /**
   * One JPEG of the tab as it is now, for the recording's **first** frame.
   *
   * The capture cannot be relied on to supply it: Chromium sends a screencast frame when the
   * page paints, so a page that is sitting still sends none — and the encoder's canvas then
   * holds nothing but its own black fill. Measured: a recording of a page that had not painted
   * came back one frame long, 33 ms, entirely black, while the paint path (`screenshot`) had the
   * picture all along. Absent, or `null`, is allowed: a recording without a first picture is
   * still a recording.
   */
  seedFrame?: () => Promise<Buffer | null>
}

/** What starting did. A refusal names itself, because the caller has to say something useful. */
export type StartSessionRecordingResult =
  | { ok: true; state: TabRecordingState; finished: Promise<FinishedRecording | null> }
  | { ok: false; reason: 'already-recording'; state: TabRecordingState }
  | { ok: false; reason: 'no-encoder' | 'no-capture'; message: string }

/**
 * Whichever the ambient timers return — node's `Timeout`, or the DOM's number.
 *
 * Named once because the two libs are both in play here: `typeof setTimeout` written in two
 * places resolves against both overloads in one and one in the other, and the mismatch is a
 * type error that says nothing about the code.
 */
export type RecordingTimer = ReturnType<typeof setTimeout>

export interface SessionRecordingDeps {
  recorder: TabRecorder
  /** Opens an encoder for one recording; `null` when this build records into nothing it knows. */
  openEncoder: (options: {
    width: number
    height: number
    onChunk: (bytes: Uint8Array) => void
    onEnd: (reason: string) => void
  }) => Promise<RecordingEncoder | null>
  /** Timers, injected so a test can move the clock instead of waiting for it. */
  setTimer?: (run: () => void, ms: number) => RecordingTimer
  clearTimer?: (timer: RecordingTimer) => void
}

interface LiveSessionRecording {
  state: TabRecordingState
  encoder: RecordingEncoder
  capture: StartSessionRecordingOptions['capture']
  timer: RecordingTimer
  /** Resolves when this recording ends, however it ends — what `--wait` waits on. */
  settle: (finished: FinishedRecording | null) => void
  finished: Promise<FinishedRecording | null>
  /** True once `end` has begun, so a second ending (deadline + teardown) does not run it twice. */
  ending: boolean
}

export class SessionRecordings {
  private readonly live = new Map<string, LiveSessionRecording>()

  constructor(private readonly deps: SessionRecordingDeps) {}

  /** `sessionId` + `tabId` as one key. One spelling, for the reason `TabRecorder` says. */
  private static key(sessionId: string, tabId: string): string {
    return `${sessionId}\u0000${tabId}`
  }

  /** Whether this conversation is already recording this tab. */
  isRecording(sessionId: string, tabId: string): boolean {
    return this.live.has(SessionRecordings.key(sessionId, tabId))
  }

  /**
   * Wait for one to end, without having asked it to.
   *
   * The `wait` form of a start gets this by making that call block. This is for the other case:
   * someone who wants to be *told*, later, that a recording they set going is over. `null` when
   * nothing is recording that key — including when it already ended, in which case whoever asks
   * has missed it rather than being owed an answer.
   */
  waitFor(sessionId: string, tabId: string): Promise<FinishedRecording | null> | null {
    return this.live.get(SessionRecordings.key(sessionId, tabId))?.finished ?? null
  }

  /** Every recording in flight — the load the status面 reports, and what the tests read. */
  count(): number {
    return this.live.size
  }

  /**
   * Begin one. The order is: encoder first (it decides the container, and the file's extension
   * comes from it), then the file, then the capture.
   *
   * Capture last on purpose — a recording whose file never got created must not leave frames
   * arriving for nothing, and the encoder is the piece that can refuse (a build that records
   * into no container it knows).
   */
  async start(options: StartSessionRecordingOptions): Promise<StartSessionRecordingResult> {
    const key = SessionRecordings.key(options.sessionId, options.tabId)

    const existing = this.deps.recorder.stateFor(options.sessionId, options.tabId)
    if (existing) return { ok: false, reason: 'already-recording', state: existing }

    const encoder = await this.deps.openEncoder({
      width: options.size.width,
      height: options.size.height,
      // Frames go straight through: the file is the recording's, and this is only the encoder.
      onChunk: (bytes) => this.deps.recorder.appendFor(options.sessionId, options.tabId, bytes),
      onEnd: (reason) => { void this.end(options.sessionId, options.tabId, `its encoder ended (${reason})` as EndReason) },
    })

    if (!encoder) {
      return {
        ok: false,
        reason: 'no-encoder',
        message: 'This build cannot record into a container it knows.',
      }
    }

    const state = this.deps.recorder.startFor(options.sessionId, {
      tabId: options.tabId,
      dir: options.dir,
      source: options.source,
      extension: encoder.extension,
    })

    let settle!: (finished: FinishedRecording | null) => void
    const finished = new Promise<FinishedRecording | null>((resolve) => { settle = resolve })

    const setTimer = this.deps.setTimer ?? ((run: () => void, ms: number): RecordingTimer => setTimeout(run, ms))
    const live: LiveSessionRecording = {
      state,
      encoder,
      capture: options.capture,
      timer: setTimer(() => { void this.end(options.sessionId, options.tabId, 'deadline') }, options.ttlMs),
      settle,
      finished,
      ending: false,
    }
    this.live.set(key, live)

    // The first frame, put on the canvas before the capture starts so that a page which never
    // paints still records a picture of itself (`seedFrame`). Pushed after the entry exists: the
    // recorder drops bytes for a `(session, tab)` it does not know.
    const seed = options.seedFrame ? await options.seedFrame().catch(() => null) : null
    if (seed) encoder.push(seed)

    try {
      await options.capture.startScreencast({
        onFrame: (frame) => encoder.push(frame.bytes),
        onEnd: (reason) => { void this.end(options.sessionId, options.tabId, `its capture ended (${reason})` as EndReason) },
      })
    } catch (error) {
      // A capture that never started is a recording that never was: the entry and the encoder
      // both have to go, and the caller has to hear about it.
      await this.end(options.sessionId, options.tabId, 'its capture ended' as EndReason)
      return {
        ok: false,
        reason: 'no-capture',
        message: error instanceof Error ? error.message : String(error),
      }
    }

    return { ok: true, state, finished }
  }

  /**
   * End one, and answer with what it left on disk — or `null` when there was nothing to end.
   *
   * Idempotent: an ending already under way is not run again (the deadline and a tab closing in
   * the same tick is the ordinary case, not a strange one).
   */
  async end(sessionId: string, tabId: string, reason: EndReason): Promise<FinishedRecording | null> {
    const key = SessionRecordings.key(sessionId, tabId)
    const live = this.live.get(key)
    if (!live || live.ending) return null
    live.ending = true
    this.live.delete(key)

    const clearTimer = this.deps.clearTimer ?? ((timer: RecordingTimer): void => { clearTimeout(timer as never) })
    clearTimer(live.timer)

    // Capture first: nothing more should arrive while the file is being closed.
    try {
      await live.capture.stopScreencast()
    } catch {
      // Already gone — the reason it ended is what the caller will hear.
    }

    // Then the encoder, and this one is awaited for the tail. Every chunk before it is on disk;
    // the last one is the one a teardown would drop (`recording-encoder-page.ts`).
    try {
      await live.encoder.stop()
    } catch {
      // Nothing left to do about it: the file holds what arrived.
    }

    const finished = this.deps.recorder.stopFor(sessionId, tabId)
    live.settle(finished)
    return finished
  }

  /**
   * End everything a session owns, because the session is gone.
   *
   * Not awaited by its callers: a session being torn down has no one left to wait, and each
   * recording's own `finished` promise is what anything still interested listens to.
   */
  endAllFor(sessionId: string): void {
    for (const [key, live] of this.live) {
      if (!key.startsWith(`${sessionId}\u0000`)) continue
      const tabId = live.state.tabId
      void this.end(sessionId, tabId, 'the session went away')
    }
  }

  /**
   * End every recording whose tab is one of these — the tab went away, or its window did.
   *
   * Returns whether anything was running, so the caller can decide whether the chrome needs
   * telling as well.
   */
  endForTabs(tabIds: string[]): boolean {
    let ended = false
    for (const [, live] of this.live) {
      if (!tabIds.includes(live.state.tabId)) continue
      ended = true
      const sessionId = live.state.owner.kind === 'session' ? live.state.owner.sessionId : ''
      void this.end(sessionId, live.state.tabId, 'the tab went away')
    }
    return ended
  }
}
