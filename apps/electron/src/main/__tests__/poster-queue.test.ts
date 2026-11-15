import { describe, expect, it } from 'bun:test'
import { createFailureGate, createLane } from '../poster-queue'

/** A task that says when it started and finished, and ends when the test lets it. */
function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('a lane', () => {
  it('runs no more than its limit at once', async () => {
    const lane = createLane(2)
    const gates = [deferred(), deferred(), deferred(), deferred()]
    let running = 0
    let peak = 0

    const done = gates.map((gate) =>
      lane.run(async () => {
        running++
        peak = Math.max(peak, running)
        await gate.promise
        running--
      }),
    )

    await tick()
    expect(running).toBe(2)
    expect(lane.active()).toBe(2)
    expect(lane.waiting()).toBe(2)

    gates[0].resolve()
    await tick()
    expect(running).toBe(2)
    expect(lane.waiting()).toBe(1)

    gates[1].resolve()
    gates[2].resolve()
    gates[3].resolve()
    await Promise.all(done)

    expect(peak).toBe(2)
    expect(lane.active()).toBe(0)
    expect(lane.waiting()).toBe(0)
  })

  it('hands a finished slot straight over — a task queued in the same tick cannot steal it', async () => {
    const lane = createLane(1)
    const first = deferred()
    const second = deferred()
    let peak = 0
    let running = 0

    const a = lane.run(async () => {
      running++
      peak = Math.max(peak, running)
      await first.promise
      running--
    })
    const b = lane.run(async () => {
      running++
      peak = Math.max(peak, running)
      await second.promise
      running--
    })

    await tick()
    expect(lane.active()).toBe(1)

    // A third arrival in the same turn as the completion must wait for the slot, not take it.
    first.resolve()
    const c = lane.run(async () => {
      running++
      peak = Math.max(peak, running)
    })
    await tick()

    expect(peak).toBe(1)
    expect(lane.active()).toBe(1)
    second.resolve()
    await Promise.all([a, b, c])
    expect(peak).toBe(1)
    expect(lane.active()).toBe(0)
  })

  it('releases the slot when a task throws, and re-throws what it threw', async () => {
    const lane = createLane(1)
    await expect(
      lane.run(async () => {
        throw new Error('the window was destroyed')
      }),
    ).rejects.toThrow('the window was destroyed')
    expect(lane.active()).toBe(0)
    expect(await lane.run(async () => 'fine')).toBe('fine')
  })

  it('refuses a limit that could never run anything', () => {
    expect(() => createLane(0)).toThrow()
    expect(() => createLane(Number.POSITIVE_INFINITY)).toThrow()
  })
})

describe('the failure gate', () => {
  it('blocks a key until its time is up, then lets it through again', () => {
    const gate = createFailureGate(1000)
    gate.fail('poster-1', 5000)

    expect(gate.blocked('poster-1', 5000)).toBe(true)
    expect(gate.blocked('poster-1', 5999)).toBe(true)
    expect(gate.blocked('poster-1', 6000)).toBe(false)
    expect(gate.blocked('poster-1', 5999)).toBe(false)
  })

  it('only blocks the key that failed', () => {
    const gate = createFailureGate(1000)
    gate.fail('a', 0)
    expect(gate.blocked('b', 0)).toBe(false)
  })

  it('forgets a key a success cleared, and drops expired entries', () => {
    const gate = createFailureGate(1000)
    gate.fail('a', 0)
    gate.fail('b', 0)
    gate.clear('a')
    expect(gate.size()).toBe(1)
    gate.sweep(2000)
    expect(gate.size()).toBe(0)
    expect(gate.blocked('b', 2000)).toBe(false)
  })
})
