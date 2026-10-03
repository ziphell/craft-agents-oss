/**
 * The service that holds a conversation's recording together.
 *
 * What is worth pinning is **ending**: every path has to stop the capture, wait for the encoder's
 * tail, and only then let the file settle — and any of them can arrive at the same moment as
 * another. The frames themselves are Chromium's and the file is the recorder's; this is the piece
 * that decides when there is no more of either.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { WebContents } from 'electron'
import { TabRecorder } from '../tab-recorder'
import { SessionRecordings, type StartSessionRecordingOptions } from '../session-recordings'
import type { RecordingEncoder } from '../recording-encoder'

const SESSION = 'session-1'
const TAB = 'tab-1'

function fakeSource(id = 1): WebContents {
  return { id, isDestroyed: () => false, mainFrame: { detached: false } } as unknown as WebContents
}

/** An encoder that records what it was told and hands back one chunk when stopped. */
function fakeEncoder(extension = 'mp4') {
  const calls: string[] = []
  const state = { stopped: false }
  const encoder: RecordingEncoder = {
    extension,
    push: (frame: Buffer) => calls.push(`frame:${frame.length}`),
    stop: async () => {
      calls.push('stop')
      state.stopped = true
    },
  }
  return { encoder, calls, state }
}

/** A capture that can be told to emit frames, and reports when it was stopped. */
function fakeCapture() {
  const calls: string[] = []
  let onFrame: ((frame: { bytes: Buffer; offsetMs: number }) => void) | null = null
  let onEnd: ((reason: string) => void) | null = null
  return {
    calls,
    frame: (bytes: number[]) => onFrame?.({ bytes: Buffer.from(bytes), offsetMs: 0 }),
    endFromOutside: (reason = 'the renderer died') => onEnd?.(reason),
    capture: {
      startScreencast: async (options: any) => {
        calls.push('start')
        onFrame = options.onFrame
        onEnd = options.onEnd
      },
      stopScreencast: async () => { calls.push('stop') },
    },
  }
}

function harness(encoderExtension = 'mp4') {
  const dir = mkdtempSync(join(tmpdir(), 'craft-session-recordings-'))
  const recorder = new TabRecorder()
  const encoders: Array<ReturnType<typeof fakeEncoder>> = []
  const captures: Array<ReturnType<typeof fakeCapture>> = []
  const encoderEnds: Array<(reason: string) => void> = []
  const timers = new Map<number, () => void>()
  let nextTimer = 1

  const service = new SessionRecordings({
    recorder,
    openEncoder: async (options) => {
      const fake = fakeEncoder(encoderExtension)
      encoders.push(fake)
      if (options.onEnd) encoderEnds.push(options.onEnd)
      return fake.encoder
    },
    setTimer: (run) => {
      const id = nextTimer++
      timers.set(id, run)
      return id as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: (timer) => { timers.delete(timer as unknown as number) },
  })

  const start = async (overrides: Partial<StartSessionRecordingOptions> = {}) => {
    const capture = fakeCapture()
    captures.push(capture)
    const result = await service.start({
      sessionId: SESSION,
      tabId: TAB,
      dir,
      source: fakeSource(),
      ttlMs: 30_000,
      size: { width: 640, height: 480 },
      capture: capture.capture,
      ...overrides,
    })
    return { result, capture }
  }

  return { dir, recorder, service, encoders, captures, encoderEnds, start, timers, fireTimer: () => timers.values().next().value?.() }
}

let cleanups: string[] = []
afterEach(() => {
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true })
  cleanups = []
})

describe('SessionRecordings', () => {
  it('arms an encoder, a file and a capture, in that order', async () => {
    const h = harness()
    cleanups.push(h.dir)

    const { result, capture } = await h.start()

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.tabId).toBe(TAB)
    expect(result.state.file.endsWith('.mp4')).toBe(true)
    // The capture starts last: a file that was never created must not have frames arriving.
    expect(capture.calls).toEqual(['start'])
    expect(h.service.isRecording(SESSION, TAB)).toBe(true)
  })

  it('hands every frame to the encoder, and every chunk to the file', async () => {
    const h = harness()
    cleanups.push(h.dir)
    const { capture } = await h.start()

    h.encoders[0]!.encoder.push(Buffer.from([1, 2, 3]))
    capture.frame([9, 9])

    // Both routes reach the encoder: the one a chunk's file sits behind, and the capture's.
    expect(h.encoders[0]!.calls).toEqual(['frame:3', 'frame:2'])
    // The chunk path is the recorder's — this is the same call the encoder makes back.
    const state = h.recorder.stateFor(SESSION, TAB)!
    h.recorder.appendFor(SESSION, TAB, new Uint8Array([7, 7]))
    expect(readFileSync(state.file).length).toBe(2)
  })

  it('puts a real first frame on the canvas before the capture starts', async () => {
    const h = harness()
    cleanups.push(h.dir)
    const order: string[] = []

    const { capture } = await h.start({
      seedFrame: async () => {
        order.push('seed taken')
        return Buffer.from([1, 2, 3, 4, 5])
      },
    })
    for (const call of capture.calls) order.push(`capture ${call}`)

    // The seed is the frame the capture cannot be relied on to supply — a page that is not
    // painting sends it none — and it has to be on the canvas first, so that the encoder's
    // keep-alive has a picture to hold for as long as the recording runs.
    expect(order).toEqual(['seed taken', 'capture start'])
    expect(h.encoders[0]!.calls).toEqual(['frame:5'])
  })

  it('records anyway when the first frame cannot be taken', async () => {
    const h = harness()
    cleanups.push(h.dir)

    const { result } = await h.start({ seedFrame: async () => { throw new Error('no surface to copy') } })

    // A page that cannot be photographed is not a recording that must not happen.
    expect(result.ok).toBe(true)
    expect(h.encoders[0]!.calls).toEqual([])
  })

  it('two endings arriving at once run once', async () => {
    const h = harness()
    cleanups.push(h.dir)
    const { result, capture } = await h.start()
    if (!result.ok) throw new Error('expected to start')

    const [first, second] = await Promise.all([
      h.service.end(SESSION, TAB, 'asked'),
      h.service.end(SESSION, TAB, 'the tab went away'),
    ])

    // One of them did the work; the other found nothing left to do.
    expect([first, second].filter(Boolean).length).toBe(1)
    expect(capture.calls).toEqual(['start', 'stop'])
    expect(h.encoders[0]!.calls).toEqual(['stop'])
    expect(await result.finished).not.toBeNull()
  })

  it('waits for the encoder before letting the file settle', async () => {
    const h = harness()
    cleanups.push(h.dir)
    const { result } = await h.start()
    if (!result.ok) throw new Error('expected to start')

    // A chunk that arrives while the encoder is stopping is still the recording's.
    h.encoders[0]!.encoder.stop = async () => {
      h.recorder.appendFor(SESSION, TAB, new Uint8Array([1]))
    }
    const finished = await h.service.end(SESSION, TAB, 'asked')

    expect(finished?.bytes).toBe(1)
    expect(h.recorder.stateFor(SESSION, TAB)).toBeNull()
  })

  it('ends when its capture ends on its own', async () => {
    const h = harness()
    cleanups.push(h.dir)
    const { result, capture } = await h.start()
    if (!result.ok) throw new Error('expected to start')

    capture.endFromOutside()
    const finished = await result.finished

    expect(finished).not.toBeNull()
    expect(h.encoders[0]!.state.stopped).toBe(true)
    expect(h.service.count()).toBe(0)
  })

  it('ends when its encoder ends on its own — a window that went away', async () => {
    const h = harness()
    cleanups.push(h.dir)
    const { result, capture } = await h.start()
    if (!result.ok) throw new Error('expected to start')

    // What `openRecordingEncoder` reports when its window closes or its renderer dies.
    h.encoderEnds[0]!('its window closed')
    const finished = await result.finished

    expect(finished).not.toBeNull()
    // And the other half is let go of too: a capture left running would hold the CDP session.
    expect(capture.calls).toEqual(['start', 'stop'])
    expect(h.service.count()).toBe(0)
  })

  it('refuses a second recording of the same tab, and answers with the one that is running', async () => {
    const h = harness()
    cleanups.push(h.dir)
    const first = await h.start()

    const second = await h.start()

    expect(second.result.ok).toBe(false)
    if (second.result.ok) return
    expect(second.result.reason).toBe('already-recording')
    if (second.result.reason !== 'already-recording') return
    if (first.result.ok) expect(second.result.state.file).toBe(first.result.state.file)
    // And the refused attempt left nothing behind: no second encoder, no second capture.
    expect(h.encoders.length).toBe(1)
    expect(second.capture.calls).toEqual([])
  })

  it('says so, and leaves nothing running, when this build records into nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'craft-session-recordings-'))
    cleanups.push(dir)
    const recorder = new TabRecorder()
    const capture = fakeCapture()
    const service = new SessionRecordings({ recorder, openEncoder: async () => null })

    const result = await service.start({
      sessionId: SESSION,
      tabId: TAB,
      dir,
      source: fakeSource(),
      ttlMs: 1000,
      size: { width: 100, height: 100 },
      capture: capture.capture,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('no-encoder')
    expect(service.count()).toBe(0)
    expect(capture.calls).toEqual([])
    expect(recorder.stateFor(SESSION, TAB)).toBeNull()
  })

  it('cleans up both halves when the capture refuses to start', async () => {
    const h = harness()
    cleanups.push(h.dir)
    const capture = fakeCapture()
    capture.capture.startScreencast = async () => { throw new Error('no screencast for you') }

    const result = await h.service.start({
      sessionId: SESSION,
      tabId: TAB,
      dir: h.dir,
      source: fakeSource(),
      ttlMs: 1000,
      size: { width: 100, height: 100 },
      capture: capture.capture,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('no-capture')
    if (result.reason === 'already-recording') return
    expect(result.message).toContain('no screencast for you')
    // No entry, no encoder, nothing left running.
    expect(h.recorder.stateFor(SESSION, TAB)).toBeNull()
    expect(h.service.count()).toBe(0)
    expect(h.encoders[0]!.state.stopped).toBe(true)
  })

  it('the deadline ends a recording that nobody stopped', async () => {
    const h = harness()
    cleanups.push(h.dir)
    const { result } = await h.start()
    if (!result.ok) throw new Error('expected to start')

    h.fireTimer()

    expect(await result.finished).not.toBeNull()
    expect(h.service.count()).toBe(0)
  })

  it('ends every recording of a session when the session is gone', async () => {
    const h = harness()
    cleanups.push(h.dir)
    const a = await h.start({ tabId: 'tab-1' })
    const b = await h.start({ tabId: 'tab-2' })

    h.service.endAllFor(SESSION)

    const settle = async (result: Awaited<ReturnType<typeof h.start>>['result']) =>
      result.ok ? await result.finished : null
    expect(await settle(a.result)).not.toBeNull()
    expect(await settle(b.result)).not.toBeNull()
    expect(h.service.count()).toBe(0)
  })

  it('ends every recording of a tab, whoever owns them, and says whether anything was running', async () => {
    const h = harness()
    cleanups.push(h.dir)
    await h.start({ tabId: 'tab-1' })
    await h.start({ tabId: 'tab-2' })

    expect(h.service.endForTabs(['tab-9'])).toBe(false)
    expect(h.service.count()).toBe(2)

    expect(h.service.endForTabs(['tab-1'])).toBe(true)
    expect(h.service.count()).toBe(1)
  })

  it('ends nothing, quietly, for a recording that was never started', async () => {
    const h = harness()
    cleanups.push(h.dir)
    expect(await h.service.end(SESSION, 'nobody', 'asked')).toBeNull()
  })
})
