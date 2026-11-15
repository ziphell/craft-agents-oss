/**
 * How many posters may be made at once, and which ones may not be asked for again.
 *
 * Two small rules, kept out of `creation-thumbnailer.ts` because they are pure: they do not know
 * what a poster is, only that some work is expensive to start and that a task which failed once
 * will usually fail again.
 *
 * **Why lanes.** A poster is drawn either by a process that already exists (pdfium rasterising a
 * page, 60 ms) or by a hidden window that has to be created, loaded, settled and captured
 * (1–2 s). Putting both through one queue meant forty PDFs each waited behind an office document
 * they had nothing in common with — the grid filled in the order of the *list*, not the order of
 * the *cost*. So: a lane per kind of work, with a limit that says what starting one costs.
 *
 * A slot is **handed over**, not released and re-taken: `run()` decrements only when nobody is
 * waiting, and a waiter takes the slot the finishing task gives it. Otherwise a task queued in the
 * same microtask as a completion could see the freed slot and take it first, and the lane would run
 * one more than its limit.
 */

/** A lane: at most `limit` tasks at a time, the rest in arrival order. */
export interface Lane {
  run<T>(task: () => Promise<T>): Promise<T>
  /** How many tasks are running right now — for tests and for an honest log line. */
  active(): number
  /** How many are waiting — same. */
  waiting(): number
}

export function createLane(limit: number): Lane {
  if (!Number.isFinite(limit) || limit < 1) throw new Error(`a lane needs a limit of at least 1, not ${limit}`)
  let running = 0
  const queued: Array<() => void> = []

  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      if (running < limit) running++
      // A waiter is handed the slot its predecessor gives up, so it does not count it again.
      else await new Promise<void>((resolve) => queued.push(resolve))
      try {
        return await task()
      } finally {
        const next = queued.shift()
        if (next) next()
        else running--
      }
    },
    active: () => running,
    waiting: () => queued.length,
  }
}

/**
 * The failures a session will not repeat.
 *
 * A poster that cannot be made leaves nothing on disk, so nothing exists to remember it by — and
 * the card asks again on every visit, which is a window opened, loaded, and thrown away for a file
 * that has already refused. (Both real cases on this machine were of that shape: a markdown poster
 * whose bundle path did not exist, and a PDF whose window was destroyed mid-capture.)
 *
 * In memory rather than on disk, on purpose: a failure is often about *this run* (a missing build,
 * a busy GPU), so a restart should try again. The time limit is what keeps a flaky capture from
 * being written off for good.
 */
export interface FailureGate {
  /** True while this key is still written off. */
  blocked(key: string, now?: number): boolean
  /** Write a key off for `ttlMs` from `now`. */
  fail(key: string, now?: number): void
  /** Forget a key — a success, or a document whose version changed. */
  clear(key: string): void
  /** Drop expired entries, so the map cannot grow without bound. */
  sweep(now?: number): void
  size(): number
}

export function createFailureGate(ttlMs: number): FailureGate {
  const until = new Map<string, number>()
  return {
    blocked(key, now = Date.now()) {
      const expiry = until.get(key)
      if (expiry === undefined) return false
      if (expiry > now) return true
      until.delete(key)
      return false
    },
    fail(key, now = Date.now()) {
      until.set(key, now + ttlMs)
    },
    clear(key) {
      until.delete(key)
    },
    sweep(now = Date.now()) {
      for (const [key, expiry] of until) if (expiry <= now) until.delete(key)
    },
    size: () => until.size,
  }
}
