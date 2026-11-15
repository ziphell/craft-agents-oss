/**
 * The timeline's one clock — `AudioContext.currentTime`, ported from OpenReel's
 * `MasterTimelineClock`.
 *
 * A preview has two things that must agree: the picture under the playhead and the sound that is
 * already scheduled. Wall-clock RAF time and the audio context drift apart, so the audio clock is
 * the truth here: every frame asks this class, and the audio graph schedules against the same
 * `currentTime`. Pausing stores the moment; seeking resets it; nobody else keeps a second time.
 *
 * The clock is deliberately tiny: play / pause / seek / subscribe. Duration is a limit, not a
 * property — the document owns it, the clock only stops at it.
 */

export type ClockListener = (time: number, playing: boolean) => void

export class MasterTimelineClock {
  readonly context: AudioContext
  private offset = 0
  private startedAt = 0
  private running = false
  private limit = Number.POSITIVE_INFINITY
  private listeners = new Set<ClockListener>()
  private frame = 0

  constructor(context?: AudioContext) {
    this.context = context ?? new AudioContext()
  }

  /** The moment the timeline is at, in seconds. */
  get time(): number {
    if (!this.running) return this.offset
    return Math.min(this.limit, this.offset + this.context.currentTime - this.startedAt)
  }

  get playing(): boolean {
    return this.running
  }

  /** Where the clock stops — the cut's own duration. */
  setLimit(seconds: number): void {
    this.limit = Math.max(0.1, seconds)
  }

  async play(): Promise<void> {
    if (this.running) return
    if (this.context.state === 'suspended') await this.context.resume()
    // Replaying from the very end starts over, like every player.
    if (this.offset >= this.limit - 1e-6) this.offset = 0
    this.startedAt = this.context.currentTime
    this.running = true
    this.emit()
    this.tick()
  }

  pause(): void {
    if (!this.running) return
    this.offset = this.time
    this.running = false
    cancelAnimationFrame(this.frame)
    this.emit()
  }

  seek(seconds: number): void {
    this.offset = Math.min(this.limit, Math.max(0, seconds))
    this.startedAt = this.context.currentTime
    this.emit()
  }

  /** Listeners are told the time every frame while playing, and on every state change. */
  subscribe(listener: ClockListener): () => void {
    this.listeners.add(listener)
    listener(this.time, this.running)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.time, this.running)
  }

  private tick = (): void => {
    if (!this.running) return
    if (this.time >= this.limit - 1e-6) {
      this.offset = this.limit
      this.running = false
      this.emit()
      return
    }
    this.emit()
    this.frame = requestAnimationFrame(this.tick)
  }
}
