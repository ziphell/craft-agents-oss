/**
 * A screencast, on its own.
 *
 * What is worth pinning is the three-part contract `BrowserCDP` owes a recording: the stream is
 * asked for with the size it should cost, **every frame is acked** (Chromium waits for the ack
 * between frames, so without it the stream delivers one and stops), and **the session is held
 * for as long as the stream runs** — which is the part a static page would otherwise lose, since
 * it produces no frames and therefore no acks for the idle timer to notice.
 *
 * The frames themselves are Chromium's; what is tested here is that they are passed on with the
 * moment they were taken, and that a stream which has been stopped keeps nothing.
 */

import { describe, it, expect, jest, afterEach } from 'bun:test'
import type { WebContents } from 'electron'
import { BrowserCDP } from '../browser-cdp'

function createFakeDebugger() {
  const calls: Array<{ method: string; params: any }> = []
  const listeners = new Map<string, Array<(...args: any[]) => void>>()
  let attached = false

  const add = (event: string, listener: (...args: any[]) => void) => {
    const list = listeners.get(event) ?? []
    list.push(listener)
    listeners.set(event, list)
  }

  const emit = (event: string, ...args: any[]) => {
    for (const listener of [...(listeners.get(event) ?? [])]) listener({}, ...args)
  }

  const fake = {
    debugger: {
      attach: () => { attached = true },
      detach: () => { attached = false; emit('detach') },
      isAttached: () => attached,
      on: add,
      removeListener: (event: string, listener: (...args: any[]) => void) => {
        listeners.set(event, (listeners.get(event) ?? []).filter((entry) => entry !== listener))
      },
      sendCommand: async (method: string, params: any) => {
        calls.push({ method, params })
        return {}
      },
    },
  }

  return {
    webContents: fake as unknown as WebContents,
    calls,
    isAttached: () => attached,
    /** One frame, as Electron delivers it: the data, the session, and when it was taken. */
    frame: (sessionId: string, data: string, atSeconds: number) =>
      emit('message', 'Page.screencastFrame', { data, sessionId, metadata: { timestamp: atSeconds } }),
    /** The session ending without us asking — the page's renderer dying. */
    endSessionFromOutside: () => { attached = false; emit('detach') },
    listenerCount: (event: string) => (listeners.get(event) ?? []).length,
  }
}

afterEach(() => {
  jest.useRealTimers()
})

describe('BrowserCDP screencast', () => {
  it('asks for a jpeg stream at the size it was given', async () => {
    const fake = createFakeDebugger()
    const cdp = new BrowserCDP(fake.webContents)

    await cdp.startScreencast({ onFrame: () => {}, quality: 55, maxWidth: 800, maxHeight: 600 })

    const start = fake.calls.find((call) => call.method === 'Page.startScreencast')
    expect(start?.params).toMatchObject({ format: 'jpeg', quality: 55, maxWidth: 800, maxHeight: 600 })
    await cdp.stopScreencast()
  })

  it('hands each frame on with the moment it was taken, and acks it', async () => {
    const fake = createFakeDebugger()
    const cdp = new BrowserCDP(fake.webContents)
    const seen: Array<{ bytes: Buffer; offsetMs: number }> = []

    await cdp.startScreencast({ onFrame: (frame) => seen.push(frame) })

    // A second apart in the page's own clock, so the offsets must be too — the origin itself is
    // when the stream started, which the test does not need to know.
    const base = Math.floor(Date.now() / 1000) + 1
    fake.frame('frame-1', Buffer.from([1, 2, 3]).toString('base64'), base)
    fake.frame('frame-2', Buffer.from([4]).toString('base64'), base + 1)
    // The ack is fire-and-forget — the stream must not wait on the round trip — so it lands a
    // tick later.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(seen.length).toBe(2)
    expect(Array.from(seen[0]!.bytes)).toEqual([1, 2, 3])
    expect(seen[0]!.offsetMs).toBeGreaterThanOrEqual(0)
    expect(seen[1]!.offsetMs - seen[0]!.offsetMs).toBe(1000)

    // Both frames acked, each with the session it came from: this is what keeps them coming.
    const acks = fake.calls.filter((call) => call.method === 'Page.screencastFrameAck')
    expect(acks.map((ack) => ack.params.sessionId)).toEqual(['frame-1', 'frame-2'])

    await cdp.stopScreencast()
  })

  it('ignores frames that arrive after the stream was stopped', async () => {
    const fake = createFakeDebugger()
    const cdp = new BrowserCDP(fake.webContents)
    const seen: number[] = []

    await cdp.startScreencast({ onFrame: () => seen.push(1) })
    fake.frame('s', 'AA==', Math.floor(Date.now() / 1000))
    await cdp.stopScreencast()
    fake.frame('s', 'AA==', Math.floor(Date.now() / 1000))

    expect(seen.length).toBe(1)
    expect(fake.calls.some((call) => call.method === 'Page.stopScreencast')).toBe(true)
    // The listener is not left behind: a later frame must not reach a recording that ended.
    expect(fake.listenerCount('message')).toBe(0)
  })

  it('stopping twice is safe, and starting again replaces the stream', async () => {
    const fake = createFakeDebugger()
    const cdp = new BrowserCDP(fake.webContents)

    await cdp.stopScreencast()
    await cdp.startScreencast({ onFrame: () => {} })
    await cdp.startScreencast({ onFrame: () => {} })
    await cdp.stopScreencast()
    await cdp.stopScreencast()

    expect(fake.listenerCount('message')).toBe(0)
    expect(fake.calls.filter((call) => call.method === 'Page.startScreencast').length).toBe(2)
    expect(fake.calls.filter((call) => call.method === 'Page.stopScreencast').length).toBe(2)
  })

  it('a stream that never started leaves no listener behind', async () => {
    const fake = createFakeDebugger()
    const failing = {
      ...fake.webContents,
      debugger: {
        ...(fake.webContents as any).debugger,
        sendCommand: async (method: string) => {
          if (method === 'Page.startScreencast') throw new Error('no screencast for you')
          return {}
        },
      },
    } as unknown as WebContents
    const cdp = new BrowserCDP(failing)

    await expect(cdp.startScreencast({ onFrame: () => {} })).rejects.toThrow('no screencast for you')
    expect(fake.listenerCount('message')).toBe(0)
  })

  it('holds the session for as long as the stream runs, and lets go when it stops', async () => {
    jest.useFakeTimers()
    const fake = createFakeDebugger()
    const cdp = new BrowserCDP(fake.webContents)

    await cdp.startScreencast({ onFrame: () => {} })

    // Past the idle window with no frames at all — the static page's case, where there are no
    // acks either. The stream is what keeps the session, so this must not detach.
    jest.advanceTimersByTime(60_000)
    expect(fake.isAttached()).toBe(true)

    await cdp.stopScreencast()
    jest.advanceTimersByTime(60_000)
    expect(fake.isAttached()).toBe(false)
  })

  it('tells the caller when the session ends under it', async () => {
    const fake = createFakeDebugger()
    const cdp = new BrowserCDP(fake.webContents)
    const ended: string[] = []

    await cdp.startScreencast({ onFrame: () => {}, onEnd: (reason) => ended.push(reason) })
    fake.endSessionFromOutside()

    expect(ended.length).toBe(1)
    expect(ended[0]).toContain('session ended')
    // And a frame after that belongs to nothing.
    expect(fake.listenerCount('message')).toBe(0)
  })
})
