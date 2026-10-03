/**
 * Recording a tab: the person presses a button, a conversation asks for one.
 *
 * A recording is only worth anything if somebody can say "now" from outside the thing being
 * recorded. The person can, which is why their act is a button on the window's chrome, and
 * why their file lands in their **downloads folder** — not in a session's, not in the
 * workspace's. Whose it is is a later question: a tab's owner says who opened it, not who a
 * recording of it is for, so the file is simply the person's own, and a conversation gets it
 * the way it gets any file (`video_tool` is what turns one into frames).
 *
 * The picture comes from the window's own session: the toolbar asks for display media, and
 * the display-media handler hands back the tab this was armed with (see `BrowserPaneManager`).
 * What arrives here is the encoded bytes, in order.
 *
 * Bytes rather than a stream held open by the caller: the chunks come from a renderer, so
 * the only things that have to be true are that they are appended in the order they were
 * produced and that "stop" has nothing left to flush (a stream would return before its
 * buffer reached the disk, which is a recording that is still short by a second the moment
 * it says it is done).
 *
 * Beside the film there is a **sidecar**: what the page did while it was being recorded
 * (`recording-sidecar.ts`). It is opened and closed here for the same reason the bytes are
 * written here — this class is the only thing that knows which files a recording owns.
 *
 * **More than one recording can be in flight.** A recording's identity is `(owner, tab)`:
 * the person is one owner, and a conversation is another, so the same tab can be recorded
 * by both at once and neither is the other's business. The person's side is addressed
 * **without a key** — there is one at a time, and nothing on that path has a tab id in hand
 * (the button arms whatever is on screen, and the stop comes back through a channel that
 * carries only the window). A conversation's side is **keyed**, because that path names the
 * tab it means.
 *
 * What is *not* here: when a recording stops on its own. The caller decides that (the tab
 * closing, the window going away, a deadline), and `stopIfSource` is the one thing that
 * cannot wait for it — nobody is left to press anything.
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WebContents, WebFrameMain } from 'electron'
import { settleMp4Duration } from './mp4-duration.ts'
import {
  appendSidecarEvent,
  closeSidecar,
  openSidecar,
  sidecarPathFor,
  type RecordingEvent,
} from './recording-sidecar.ts'

/** Who a recording belongs to: the person, or one conversation. */
export type RecordingOwner =
  | { kind: 'person' }
  | { kind: 'session'; sessionId: string }

/** The person's, as a value — the toolbar's button and its display-media door. */
export const PERSON_OWNER: RecordingOwner = { kind: 'person' }

/** What the chrome shows while a recording is running. */
export interface TabRecordingState {
  owner: RecordingOwner
  /** The tab being recorded. Part of the recording's identity, and what a command names. */
  tabId: string
  /** Absolute path the file is being written to. */
  file: string
  /** Epoch ms, so the chrome can count up from it without a timer from here. */
  startedAt: number
  bytes: number
}

/** What a finished recording was. */
export interface FinishedRecording {
  owner: RecordingOwner
  tabId: string
  file: string
  bytes: number
  seconds: number
}

export interface StartRecordingOptions {
  /** The tab being recorded. */
  tabId: string
  /** The directory the file goes in. Created if it is not there. */
  dir: string
  /** The tab's contents — the picture. */
  source: WebContents
  /** Extension of the file, without the dot. */
  extension?: string
}

/** A recording in flight: what the chrome reads, and what it is recording. */
interface LiveRecording {
  state: TabRecordingState
  /** The tab being recorded — kept for its identity and for the picture itself. */
  source: WebContents
  /** The observation log beside the film (`recording-sidecar.ts`) — written by this class alone. */
  sidecar: string
}

function ownerKey(owner: RecordingOwner): string {
  return owner.kind === 'person' ? PERSON_KEY : sessionKey(owner.sessionId)
}

/**
 * A conversation's key.
 *
 * Spelled once: the registry is keyed by strings, and two spellings of the same key is how a
 * lookup comes back empty for a recording that is right there.
 */
function sessionKey(sessionId: string): string {
  return `session:${sessionId}`
}

/** The person's key, as a value — there is one owner of that name. */
const PERSON_KEY = 'person'

/**
 * The same event, with what was typed taken out.
 *
 * For a recording nobody is watching (see `noteEvent`): that a field was filled is the step, and
 * the characters in it are somebody's own business.
 */
function withoutValue(event: RecordingEvent): RecordingEvent {
  if (event.type !== 'fill' || event.value === undefined) return event
  return { type: 'fill', target: event.target }
}

export class TabRecorder {
  /** `ownerKey` → `tabId` → the recording. Two owners may hold the same tab, so neither is a key. */
  private readonly live = new Map<string, Map<string, LiveRecording>>()

  /**
   * Told when a recording ends, however it ended.
   *
   * Set by the pane manager, which is the only thing that knows both the recording and the window
   * it is in. It exists because **ending has more than one door** — somebody pressed stop, the
   * deadline arrived, the tab went away, the session did — and every one of them has to run the
   * same follow-up: the page's observer comes back out (`recording-observer.ts`). Hooking only the
   * doors a caller happens to remember is exactly how a listener outlives its recording.
   */
  onRecordingEnded: ((tabId: string) => void) | null = null

  /**
   * What a display-media request should be answered with, or `null` to refuse it.
   *
   * The single door onto the screen: every `getDisplayMedia` in this partition comes
   * through here — a third-party page's included — and only the tab a person armed
   * answers anything. That is why an armed recording is the *only* thing that can be
   * captured, and why the permission is not left open for pages to ask for.
   *
   * **The person's, and only the person's**: `getDisplayMedia` is the human door (the
   * agent's is CDP screencast), so a conversation's recording never answers here.
   *
   * The frame rather than the web contents: Electron captures a `WebFrameMain`, which is
   * what a `getDisplayMedia` answer takes.
   */
  armedSource(): WebFrameMain | null {
    const source = this.onlyFor(PERSON_KEY)?.source
    if (!source || source.isDestroyed()) return null
    return source.mainFrame.detached ? null : source.mainFrame
  }

  /** The person's recording, as the chrome reads it — the one row the toolbar shows. */
  state(): TabRecordingState | null {
    return this.onlyFor(PERSON_KEY)?.state ?? null
  }

  /** Every recording in flight, whoever owns it — the status面 behind the toolbar's one row. */
  states(): TabRecordingState[] {
    const all: TabRecordingState[] = []
    for (const tabs of this.live.values()) {
      for (const recording of tabs.values()) all.push(recording.state)
    }
    return all
  }

  /** One conversation's recording of one tab, or `null` when there is none. */
  stateFor(sessionId: string, tabId: string): TabRecordingState | null {
    return this.live.get(sessionKey(sessionId))?.get(tabId)?.state ?? null
  }

  /**
   * Start recording one tab for the person.
   *
   * A recording already running is finished first rather than dropped: the person pressed
   * the button again, and the bytes already written are worth keeping. That is also what
   * keeps the person to one recording at a time, whatever tab they were on.
   */
  start(options: StartRecordingOptions): TabRecordingState {
    this.stop()
    return this.arm(PERSON_OWNER, options)
  }

  /**
   * Start recording one tab for a conversation.
   *
   * Only this exact `(session, tab)` is finished first — a conversation recording two tabs
   * at once is two recordings, and starting the second must not end the first. Whether an
   * already-running one is replaced at all is the caller's call: the command asks
   * `stateFor` first, so "the same key again" answers with the one that is running.
   */
  startFor(sessionId: string, options: StartRecordingOptions): TabRecordingState {
    const owner: RecordingOwner = { kind: 'session', sessionId }
    this.stopFor(sessionId, options.tabId)
    return this.arm(owner, options)
  }

  /** One encoded chunk, in the order the renderer produced it — the person's recording. */
  append(chunk: Uint8Array): void {
    const recording = this.onlyFor(PERSON_KEY)
    if (recording) this.write(recording, chunk)
  }

  /** One encoded chunk for a conversation's recording of one tab. */
  appendFor(sessionId: string, tabId: string, chunk: Uint8Array): void {
    const recording = this.live.get(sessionKey(sessionId))?.get(tabId)
    if (recording) this.write(recording, chunk)
  }

  /**
   * One thing the page did while this tab is being recorded.
   *
   * **Every** recording of that tab gets it: the person's and a conversation's are two
   * recordings of one page, and the page did one thing. Nothing happens when no recording covers
   * the tab — this sits on the ordinary navigation and network paths, which run either way.
   *
   * Called by the pane manager, which is where those facts arrive; written here, because the
   * recorder is the one thing that knows which files a recording owns.
   */
  noteEvent(tabId: string, event: RecordingEvent): void {
    const now = Date.now()
    for (const tabs of this.live.values()) {
      const recording = tabs.get(tabId)
      if (!recording) continue
      // **Only the person's own recording is told what was typed.** A conversation records a tab
      // the person cannot see, and nobody can be asked to consent to a recording they are not
      // watching — the picture is already that price (video-plan §7); the keystrokes are not
      // worth paying it for. A conversation still gets *that* a field was filled.
      const reported = recording.state.owner.kind === 'person' ? event : withoutValue(event)
      appendSidecarEvent(recording.sidecar, now - recording.state.startedAt, reported)
    }
  }

  /**
   * Stop the person's recording and hand back what was written, or `null` when nothing was
   * running.
   *
   * Nothing is closed or flushed here: every chunk was on disk when it was accepted, so a
   * recording that ends because the tab was closed is already a file.
   */
  stop(): FinishedRecording | null {
    const recording = this.onlyFor(PERSON_KEY)
    return recording ? this.finish(PERSON_KEY, recording) : null
  }

  /** Stop one conversation's recording of one tab. */
  stopFor(sessionId: string, tabId: string): FinishedRecording | null {
    const key = sessionKey(sessionId)
    const recording = this.live.get(key)?.get(tabId)
    return recording ? this.finish(key, recording) : null
  }

  /**
   * Stop every recording whose tab is one of these, in whatever order they were started.
   *
   * A recording follows a tab, so the tab going away ends it — with what was captured
   * kept, because somebody was recording something and some of it happened. More than one
   * id because a whole window can go away, and a window takes its tabs with it; and more
   * than one recording because the same tab can be under more than one owner.
   *
   * This is the one stop nobody can defer to a caller: once the tab is gone there is
   * nothing left to ask.
   */
  stopIfSource(...webContentsIds: number[]): FinishedRecording[] {
    const finished: FinishedRecording[] = []
    for (const [key, tabs] of this.live) {
      for (const [tabId, recording] of tabs) {
        if (!webContentsIds.includes(recording.source.id)) continue
        const stopped = this.finish(key, recording)
        if (stopped) finished.push(stopped)
      }
    }
    return finished
  }

  /** The one recording an owner has when it can only have one — the person. */
  private onlyFor(ownerKey: string): LiveRecording | undefined {
    const tabs = this.live.get(ownerKey)
    if (!tabs) return undefined
    // The person records one thing at a time, so the first is the only one.
    for (const recording of tabs.values()) return recording
    return undefined
  }

  private arm(owner: RecordingOwner, options: StartRecordingOptions): TabRecordingState {
    mkdirSync(options.dir, { recursive: true })
    const file = nextRecordingPath(options.dir, new Date(), options.extension ?? 'mp4')
    const startedAt = Date.now()

    // The film's clock and the sidecar's are one clock, by construction: both begin here, so a
    // reader never has to line two timelines up (`recording-sidecar.ts` why).
    const sidecar = sidecarPathFor(file)
    openSidecar({ file: sidecar, startedAt, tabId: options.tabId })

    const state: TabRecordingState = {
      owner,
      tabId: options.tabId,
      file,
      startedAt,
      bytes: 0,
    }

    const key = ownerKey(owner)
    let tabs = this.live.get(key)
    if (!tabs) {
      tabs = new Map()
      this.live.set(key, tabs)
    }
    tabs.set(options.tabId, { state, source: options.source, sidecar })
    return state
  }

  private write(recording: LiveRecording, chunk: Uint8Array): void {
    const buffer = Buffer.from(chunk)
    recording.state.bytes += buffer.length
    appendFileSync(recording.state.file, buffer)
  }

  private finish(key: string, recording: LiveRecording): FinishedRecording | null {
    const tabs = this.live.get(key)
    if (!tabs?.delete(recording.state.tabId)) return null
    if (tabs.size === 0) this.live.delete(key)

    // How long it ran — the one thing the file cannot work out for itself. The muxer's own
    // duration bookkeeping is not to be trusted (it writes milliseconds into a media-tick field,
    // and on some recordings zeroes the movie duration outright: `mp4-duration.ts` has the
    // measurements), so the header is settled from this clock before the file is handed back.
    // Appending never moves the header, so this is safe even for the person's recording, whose
    // last chunk may still be on its way.
    const elapsedMs = Math.max(0, Date.now() - recording.state.startedAt)
    settleMp4Duration(recording.state.file, elapsedMs)

    // Last line of the log, so a reader can tell a whole sidecar from one cut off mid-recording.
    closeSidecar(recording.sidecar, elapsedMs, Math.round(elapsedMs / 1000))

    // Every ending passes here — whoever asked for it, and for whatever reason.
    this.onRecordingEnded?.(recording.state.tabId)

    return {
      owner: recording.state.owner,
      tabId: recording.state.tabId,
      file: recording.state.file,
      bytes: recording.state.bytes,
      seconds: Math.round(elapsedMs / 1000),
    }
  }
}

/**
 * `records/20260918-143012.mp4` — named by the moment it started, which is what a person
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
