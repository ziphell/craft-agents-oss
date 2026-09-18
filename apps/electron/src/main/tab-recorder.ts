/**
 * Recording a tab, the way a person records it: press the button, drive the page, press
 * it again.
 *
 * This is the human half of what the agent could never do on its own (plan §20.3's
 * revision): a recording is only worth anything if somebody can say "now" from outside
 * the thing being recorded, and the person is the one who can. So the act is a button on
 * the window's chrome, and the file lands in the **session's own `records/`** — not in a
 * prototype's `research/`, because whose evidence it is is a later question (`sample-video`
 * answers it if the agent wants frames out of it).
 *
 * The picture comes from the window's own session: the toolbar asks for display media, and
 * the display-media handler hands back the tab this was armed with (see
 * `BrowserPaneManager`). What arrives here is the encoded bytes, in order.
 *
 * Bytes rather than a stream held open by the caller: the chunks come from a renderer, so
 * the only thing that has to be true is that they are appended in the order they were
 * produced and that a half-written recording is still a playable one. A `WriteStream` gives
 * both — the file is a valid webm up to whatever was flushed when the recording ended.
 */

import { createWriteStream, existsSync, mkdirSync, type WriteStream } from 'node:fs'
import { join } from 'node:path'
import type { WebContents, WebFrameMain } from 'electron'

/** What the chrome shows while a recording is running. */
export interface TabRecordingState {
  /** Absolute path the file is being written to. */
  file: string
  /**
   * Whose conversation it is being filed under, for the button's label.
   *
   * `null` for a tab that belongs to nobody — the person's own browsing, which is filed
   * with the rest of their downloads (see `resolveRecordsDir`).
   */
  sessionName: string | null
  /** Epoch ms, so the chrome can count up from it without a timer from here. */
  startedAt: number
  bytes: number
}

/** What a finished recording was. */
export interface FinishedRecording {
  file: string
  bytes: number
  seconds: number
}

export interface StartRecordingOptions {
  /** The directory the file goes in. Created if it is not there. */
  dir: string
  /** The conversation's name, when the recording is being filed under one. */
  sessionName?: string | null
  /** The tab's contents — the picture. */
  source: WebContents
  /** Extension of the file, without the dot. */
  extension?: string
}

export class TabRecorder {
  private recording: {
    state: TabRecordingState
    stream: WriteStream
    /** The tab being recorded — kept for its identity and for the picture itself. */
    source: WebContents
  } | null = null

  /**
   * What a display-media request should be answered with, or `null` to refuse it.
   *
   * The single door onto the screen: every `getDisplayMedia` in this partition comes
   * through here — a third-party page's included — and only the tab a person armed
   * answers anything. That is why an armed recording is the *only* thing that can be
   * captured, and why the permission is not left open for pages to ask for.
   *
   * The frame rather than the web contents: Electron captures a `WebFrameMain`, which is
   * what a `getDisplayMedia` answer takes.
   */
  armedSource(): WebFrameMain | null {
    const source = this.recording?.source
    if (!source || source.isDestroyed()) return null
    return source.mainFrame.detached ? null : source.mainFrame
  }

  /** The recording in progress, as the chrome reads it. */
  state(): TabRecordingState | null {
    return this.recording?.state ?? null
  }

  /**
   * Start recording one tab into one session's `records/`.
   *
   * A recording already running is finished first rather than dropped: the person pressed
   * the button again, and the bytes already written are worth keeping.
   */
  start(options: StartRecordingOptions): TabRecordingState {
    if (this.recording) this.stop()

    mkdirSync(options.dir, { recursive: true })
    const file = nextRecordingPath(options.dir, new Date(), options.extension ?? 'webm')

    const state: TabRecordingState = {
      file,
      sessionName: options.sessionName ?? null,
      startedAt: Date.now(),
      bytes: 0,
    }
    this.recording = {
      state,
      stream: createWriteStream(file),
      source: options.source,
    }
    return state
  }

  /** One encoded chunk, in the order the renderer produced it. */
  append(chunk: Uint8Array): void {
    if (!this.recording) return
    const buffer = Buffer.from(chunk)
    this.recording.state.bytes += buffer.length
    this.recording.stream.write(buffer)
  }

  /**
   * Stop and hand back what was written, or `null` when nothing was running.
   *
   * The stream is ended rather than destroyed, so everything accepted before this point
   * is on disk: a recording that ends because the tab was closed must still be a file.
   */
  stop(): FinishedRecording | null {
    const current = this.recording
    if (!current) return null
    this.recording = null

    current.stream.end()
    return {
      file: current.state.file,
      bytes: current.state.bytes,
      seconds: Math.max(0, Math.round((Date.now() - current.state.startedAt) / 1000)),
    }
  }

  /**
   * Stop if the tab being recorded is one of these.
   *
   * A recording follows a tab, so the tab going away ends it — with what was captured
   * kept, because the person was recording something and some of it happened. More than one
   * id because a whole window can go away, and a window takes its tabs with it.
   */
  stopIfSource(...webContentsIds: number[]): FinishedRecording | null {
    const recorded = this.recording?.source.id
    return recorded !== undefined && webContentsIds.includes(recorded) ? this.stop() : null
  }
}

/**
 * `records/20260918-143012.webm` — named by the moment it started, which is what a person
 * looking at a directory of recordings can actually use to find one. A name already taken
 * gets a suffix rather than being overwritten: two recordings of the same demo are two
 * recordings.
 */
function nextRecordingPath(dir: string, at: Date, extension: string): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  const stem =
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`

  let candidate = join(dir, `${stem}.${extension}`)
  for (let suffix = 2; existsSync(candidate); suffix += 1) {
    candidate = join(dir, `${stem}-${suffix}.${extension}`)
  }
  return candidate
}
