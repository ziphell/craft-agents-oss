/**
 * Recording a tab, the way a person records it: press the button, drive the page, press
 * it again.
 *
 * This is the human half of what the agent could never do on its own (plan §20.3's
 * revision): a recording is only worth anything if somebody can say "now" from outside
 * the thing being recorded, and the person is the one who can. So the act is a button on
 * the window's chrome, and the file lands in their **downloads folder** — not in a
 * session's, not in the workspace's, and not in a prototype's `research/`. Whose it is is
 * a later question: a tab's owner says who opened it, not who a recording of it is for, so
 * the file is simply the person's own, and a conversation gets it the way it gets any file
 * (`sample-video` is what turns one into frames under a prototype).
 *
 * The picture comes from the window's own session: the toolbar asks for display media, and
 * the display-media handler hands back the tab this was armed with (see
 * `BrowserPaneManager`). What arrives here is the encoded bytes, in order.
 *
 * Bytes rather than a stream held open by the caller: the chunks come from a renderer, so
 * the only things that have to be true are that they are appended in the order they were
 * produced and that a half-written recording is still a playable one. Appending each one as
 * it arrives gives both — the file is a valid webm up to the last chunk, and "stop" has
 * nothing left to flush (a stream would return before its buffer reached the disk, which is
 * a recording that is still short by a second the moment it says it is done).
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WebContents, WebFrameMain } from 'electron'

/** What the chrome shows while a recording is running. */
export interface TabRecordingState {
  /** Absolute path the file is being written to. */
  file: string
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
  /** The tab's contents — the picture. */
  source: WebContents
  /** Extension of the file, without the dot. */
  extension?: string
}

export class TabRecorder {
  private recording: {
    state: TabRecordingState
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
      startedAt: Date.now(),
      bytes: 0,
    }
    this.recording = {
      state,
      source: options.source,
    }
    return state
  }

  /** One encoded chunk, in the order the renderer produced it. */
  append(chunk: Uint8Array): void {
    if (!this.recording) return
    const buffer = Buffer.from(chunk)
    this.recording.state.bytes += buffer.length
    appendFileSync(this.recording.state.file, buffer)
  }

  /**
   * Stop and hand back what was written, or `null` when nothing was running.
   *
   * Nothing is closed or flushed here: every chunk was on disk when it was accepted, so a
   * recording that ends because the tab was closed is already a file.
   */
  stop(): FinishedRecording | null {
    const current = this.recording
    if (!current) return null
    this.recording = null

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
 *
 * Picking the name **is** claiming it: the file is created here with `wx`, so two recordings
 * in the same second cannot choose the same one and no earlier recording is ever truncated.
 * (Asking "is it there?" and creating it afterwards leaves exactly that gap.)
 */
function nextRecordingPath(dir: string, at: Date, extension: string): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  const stem =
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`

  for (let suffix = 1; ; suffix += 1) {
    const name = suffix === 1 ? `${stem}.${extension}` : `${stem}-${suffix}.${extension}`
    const candidate = join(dir, name)
    try {
      writeFileSync(candidate, '', { flag: 'wx' })
      return candidate
    } catch {
      // Taken — try the next suffix. (`existsSync` is not the check: what it would ask
      // about is a file this very loop just made.)
    }
  }
}
