/**
 * The preview's sound — OpenReel's `RealtimeAudioGraph`, over our document.
 *
 * Nothing is played by a media element. Every sounding clip is decoded once into an `AudioBuffer`,
 * then a `AudioBufferSourceNode` is scheduled ahead of the clock, exactly like the exporter mixes
 * it: same source window (`in` + `clipSourceTime`), same speed (`playbackRate`), same fades and
 * automation (`clipGainAt`), same tone chain (`createAudioEffectChain`). Because scheduling is
 * against the audio context's own clock, the picture (which reads that clock) and the sound cannot
 * drift.
 *
 * The shape is the one OpenReel ships:
 *
 * - a **0.2 s look-ahead**, topped up every 100 ms, so a clip that starts just after the current
 *   frame is already queued instead of arriving a tick late;
 * - **seek stops every source** and re-schedules from the new moment;
 * - **one gain node per track** carries mute/solo, so toggling them never restarts a source;
 * - each clip has its **own tone chain and gain envelope**, so a volume slider or an EQ change is
 *   a parameter write, not a re-schedule.
 *
 * The graph owns no time. It asks `MasterTimelineClock` for the moment and the `AudioContext` for
 * the moment to start at.
 */

import {
  clipGainAt,
  clipSpeed,
  trackAudible,
  type EditClip,
  type EditDocument,
  type EditTrack,
} from '@craft-agent/shared/reel/document'
import { resolveOverlayVolume } from '@craft-agent/shared/reel/overlay'
import type { AudioEffect } from '@craft-agent/shared/reel/audio-effects'
import {
  audioRms,
  gateWindowCurve,
  noiseGateCurve,
  normalizationGain,
} from '@craft-agent/shared/reel/audio-mastering'
import { createAudioEffectChain, type AudioEffectChain } from '@craft-agent/shared/reel/audio-effects-web'
import type { MasterTimelineClock } from './master-clock'

const IMAGE = /\.(png|jpe?g|webp|gif|avif|bmp|tiff?)$/i

/** How far ahead sources are queued, in seconds. */
const LOOK_AHEAD = 0.2
/** How often the look-ahead is topped up, in milliseconds. */
const TICK = 100

/** One moment of the envelope, in clip-local seconds. */
interface GainPoint {
  time: number
  value: number
}

/** A clip (or a media overlay) that can make sound, flattened out of the document. */
interface SoundItem {
  key: string
  trackId: string
  src: string
  /** Timeline seconds. */
  start: number
  duration: number
  /** Source offset at the clip's head. */
  in: number
  speed: number
  effect?: AudioEffect
  /** Timing only; a change means the queued source must be replaced. */
  signature: string
  /** The envelope itself; a change only re-writes the gain, no restart. */
  envelope: string
  points: GainPoint[]
  gainAt: (offset: number) => number
}

interface Scheduled {
  item: SoundItem
  source: AudioBufferSourceNode
  tone: AudioEffectChain
  gain: GainNode
  /** Noise gate and make-up gain, when the clip asks for them. */
  gate?: GainNode
  makeup?: GainNode
  /** Timeline moment the source's head sits at. */
  start: number
  /** Clip-local seconds already behind the source when it was queued. */
  offset: number
}

const clampOffset = (offset: number, duration: number) =>
  Math.min(duration, Math.max(0, offset))

/**
 * Breakpoints of a clip's gain: the ends, the fade edges, every automation keyframe, and the
 * midpoint between two of them. Sampling the midpoint keeps the product of two ramps (a fade over
 * an automation curve) close to the real thing without evaluating the function per frame.
 */
function clipPoints(clip: EditClip): GainPoint[] {
  const duration = clip.duration
  const times = new Set<number>([0, duration])
  const fadeIn = Math.max(0, clip.fade?.fadeIn ?? 0)
  const fadeOut = Math.max(0, clip.fade?.fadeOut ?? 0)
  if (fadeIn > 0 && fadeIn < duration) times.add(fadeIn)
  if (fadeOut > 0 && duration - fadeOut > 0) times.add(duration - fadeOut)
  for (const point of clip.automation ?? []) {
    if (point.time > 0 && point.time < duration) times.add(point.time)
  }
  const sorted = [...times].sort((left, right) => left - right)
  const points: GainPoint[] = []
  for (const [index, time] of sorted.entries()) {
    points.push({ time, value: clipGainAt(clip, time) })
    const next = sorted[index + 1]
    if (next !== undefined) {
      const mid = (time + next) / 2
      points.push({ time: mid, value: clipGainAt(clip, mid) })
    }
  }
  return points
}

/** The envelope key: any of these changing means the written curve is stale. */
const envelopeKey = (clip: EditClip) =>
  `${clip.muted ? 'm' : (clip.volume ?? 1)}|${clip.fade?.fadeIn ?? 0}|${clip.fade?.fadeOut ?? 0}|${JSON.stringify(clip.automation ?? null)}`

/** A clip's timing: the source, the window, the source offset and the rate. */
const timingKey = (clip: EditClip) =>
  `${clip.src}|${clip.start}|${clip.in}|${clip.duration}|${clipSpeed(clip)}|${
    clip.audioEffect?.normalize === true
  }|${clip.audioEffect?.denoise === true}`

const hasSound = (track: EditTrack, clip: EditClip) =>
  track.kind === 'audio' || !IMAGE.test(clip.src)

export class RealtimeAudioGraph {
  private readonly context: AudioContext
  private readonly master: GainNode
  private readonly trackGains = new Map<string, GainNode>()
  private readonly active = new Map<string, Scheduled>()
  /** Decoded sound, keyed by project-relative source path. `null` means "no decodable sound". */
  private readonly buffers = new Map<string, AudioBuffer | null>()
  private readonly decoding = new Map<string, Promise<AudioBuffer | null>>()
  /** Per-source loudness and gate curve, computed once when the sound is decoded. */
  private readonly mastered = new Map<string, { gain: number; gate: Float32Array }>()
  private doc: EditDocument | null = null
  private urlOf: (src: string) => string | null = () => null
  private playing = false
  private timer: ReturnType<typeof setInterval> | null = null
  private lastScheduled = 0

  constructor(private readonly clock: MasterTimelineClock) {
    this.context = clock.context
    this.master = this.context.createGain()
    this.master.connect(this.context.destination)
  }

  /** Re-read the document. Cheap unless a clip's timing actually changed. */
  apply(doc: EditDocument, urlOf: (src: string) => string | null): void {
    this.doc = doc
    this.urlOf = urlOf
    const items = this.itemsOf(doc)

    // One gain per track: mute and solo are live switches, not re-schedules. `overlay` is the
    // lane media overlays share; it is not a document track, so it is never collected.
    const tracks = new Set([...doc.tracks.map((track) => track.id), 'overlay'])
    for (const track of doc.tracks) {
      const gain = this.trackGain(track.id)
      const audible = trackAudible(doc, track)
      if (Math.abs(gain.gain.value - (audible ? 1 : 0)) > 1e-6) {
        this.ramp(gain.gain, audible ? 1 : 0)
      }
    }
    for (const [trackId, gain] of this.trackGains) {
      if (tracks.has(trackId)) continue
      gain.disconnect()
      this.trackGains.delete(trackId)
    }

    for (const item of items.values()) {
      if (!IMAGE.test(item.src)) this.ensureBuffer(item.src)
    }

    let restart = false
    for (const [key, entry] of this.active) {
      const item = items.get(key)
      if (!item || item.signature !== entry.item.signature) {
        this.stop(entry)
        this.active.delete(key)
        restart = true
        continue
      }
      entry.tone.update(item.effect)
      if (item.envelope !== entry.item.envelope) {
        entry.item = item
        this.writeEnvelope(entry)
      }
    }
    if (restart && this.playing) this.lastScheduled = Math.min(this.lastScheduled, this.clock.time)
  }

  /** Start scheduling from the clock's current moment. The clock must already be running. */
  play(): void {
    if (this.playing) return
    this.playing = true
    this.lastScheduled = this.clock.time
    this.tick()
    this.timer = setInterval(() => this.tick(), TICK)
  }

  /** Stop every queued source. Silence is immediate; nothing is left to ring out. */
  pause(): void {
    this.playing = false
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.stopAll()
  }

  /** A seek replaces everything that was queued: the old moment is no longer wanted. */
  seek(time: number): void {
    this.lastScheduled = time
    if (!this.playing) return
    this.stopAll()
    this.tick()
  }

  dispose(): void {
    this.pause()
    for (const gain of this.trackGains.values()) gain.disconnect()
    this.trackGains.clear()
    this.buffers.clear()
    this.decoding.clear()
    this.mastered.clear()
    this.master.disconnect()
  }

  // ── Scheduling ──────────────────────────────────────────────────────────────────────────────

  private tick = (): void => {
    if (!this.playing || !this.clock.playing || !this.doc) return
    const now = this.clock.time
    const until = now + LOOK_AHEAD
    if (until <= this.lastScheduled) return

    for (const item of this.itemsOf(this.doc).values()) {
      if (this.active.has(item.key)) continue
      if (item.start > until || item.start + item.duration <= this.lastScheduled) continue
      const buffer = this.bufferFor(item.src)
      if (!buffer) continue
      this.schedule(item, buffer)
    }
    this.lastScheduled = until
  }

  private schedule(item: SoundItem, buffer: AudioBuffer): void {
    const now = this.clock.time
    const offset = clampOffset(now - item.start, item.duration)
    const remaining = item.duration - offset
    if (remaining <= 0) return

    const sourceOffset = item.in + offset * item.speed
    if (sourceOffset >= buffer.duration - 1e-4) return

    const source = this.context.createBufferSource()
    source.buffer = buffer
    source.playbackRate.value = item.speed

    const tone = createAudioEffectChain(this.context, item.effect)
    const gain = this.context.createGain()
    source.connect(tone.input)

    // Mastering: the gate reads a curve measured from the source, and the make-up gain brings the
    // clip to the same RMS as its neighbours. Both are the numbers the exporter uses.
    const info = this.mastered.get(item.src)
    let tail: AudioNode = tone.output
    let gate: GainNode | undefined
    let makeup: GainNode | undefined
    if (item.effect?.denoise === true && info) {
      gate = this.context.createGain()
      tail.connect(gate)
      tail = gate
    }
    if (item.effect?.normalize === true && info) {
      makeup = this.context.createGain()
      makeup.gain.value = info.gain
      tail.connect(makeup)
      tail = makeup
    }
    tail.connect(gain)
    gain.connect(this.trackGain(item.trackId))

    // How much of the source is still playable at this rate, in timeline seconds.
    const playable = Math.min(remaining, (buffer.duration - sourceOffset) / item.speed)
    const startAt = this.context.currentTime + Math.max(0, item.start - now)
    source.start(startAt, sourceOffset)
    source.stop(startAt + playable)
    if (gate && info) {
      gate.gain.setValueCurveAtTime(
        gateWindowCurve(
          info.gate,
          sourceOffset,
          sourceOffset + playable * item.speed,
          playable,
        ),
        startAt,
        playable,
      )
    }

    const entry: Scheduled = {
      item,
      source,
      tone,
      gain,
      ...(gate ? { gate } : {}),
      ...(makeup ? { makeup } : {}),
      start: item.start,
      offset,
    }
    this.writeEnvelope(entry)

    source.onended = () => {
      if (this.active.get(item.key) !== entry) return
      this.active.delete(item.key)
      this.release(entry)
    }
    this.active.set(item.key, entry)
  }

  /** Write the fade/automation curve onto the clip's own gain, from the moment it is at. */
  private writeEnvelope(entry: Scheduled): void {
    const { item, gain } = entry
    const now = this.clock.time
    const offset = clampOffset(now - item.start, item.duration)
    const at = this.context.currentTime + Math.max(0, item.start - now)
    gain.gain.cancelScheduledValues(at)
    gain.gain.setValueAtTime(item.gainAt(offset), at)
    for (const point of item.points) {
      if (point.time <= offset) continue
      gain.gain.linearRampToValueAtTime(point.value, at + (point.time - offset))
    }
  }

  private itemsOf(doc: EditDocument): Map<string, SoundItem> {
    const items = new Map<string, SoundItem>()
    for (const track of doc.tracks) {
      for (const clip of track.clips) {
        if (!hasSound(track, clip)) continue
        items.set(clip.id, {
          key: clip.id,
          trackId: track.id,
          src: clip.src,
          start: clip.start,
          duration: clip.duration,
          in: clip.in,
          speed: clipSpeed(clip),
          effect: clip.audioEffect,
          signature: timingKey(clip),
          envelope: envelopeKey(clip),
          points: clipPoints(clip),
          gainAt: (offset) => clipGainAt(clip, offset),
        })
      }
    }
    // A media overlay's box can carry sound too; it is mixed like a clip on its own lane.
    for (const overlay of doc.overlays) {
      if (overlay.kind !== 'media' || !overlay.src || IMAGE.test(overlay.src)) continue
      const volume = resolveOverlayVolume(overlay)
      const start = overlay.start
      const duration = overlay.duration
      items.set(`overlay:${overlay.id}`, {
        key: `overlay:${overlay.id}`,
        trackId: 'overlay',
        src: overlay.src,
        start,
        duration,
        in: overlay.in ?? 0,
        speed: 1,
        signature: `${overlay.src}|${start}|${overlay.in ?? 0}|${duration}|1`,
        envelope: `${volume}`,
        points: [
          { time: 0, value: volume },
          { time: duration, value: volume },
        ],
        gainAt: () => volume,
      })
    }
    return items
  }

  private trackGain(trackId: string): GainNode {
    const known = this.trackGains.get(trackId)
    if (known) return known
    const gain = this.context.createGain()
    gain.connect(this.master)
    this.trackGains.set(trackId, gain)
    return gain
  }

  private ramp(param: AudioParam, value: number): void {
    const now = this.context.currentTime
    param.cancelScheduledValues(now)
    param.setValueAtTime(param.value, now)
    param.linearRampToValueAtTime(value, now + 0.02)
  }

  // ── Decoding ────────────────────────────────────────────────────────────────────────────────

  /**
   * The sound inside one source, decoded once. `null` means Chromium could not decode it (an
   * image, or a container with no readable audio track) — that source stays silent, and asking
   * again is free.
   */
  private bufferFor(src: string): AudioBuffer | null {
    if (this.buffers.has(src)) return this.buffers.get(src) ?? null
    this.ensureBuffer(src)
    return null
  }

  private ensureBuffer(src: string): void {
    if (this.buffers.has(src) || this.decoding.has(src)) return
    const url = this.urlOf(src)
    if (!url) {
      this.buffers.set(src, null)
      return
    }
    const promise = fetch(url)
      .then((response) => response.arrayBuffer())
      .then((bytes) => this.context.decodeAudioData(bytes))
      .then((buffer) => {
        const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) =>
          buffer.getChannelData(index),
        )
        this.mastered.set(src, {
          gain: normalizationGain(audioRms(channels)),
          gate: noiseGateCurve(channels, buffer.sampleRate),
        })
        this.buffers.set(src, buffer)
        this.decoding.delete(src)
        return buffer
      })
      .catch(() => {
        this.buffers.set(src, null)
        this.decoding.delete(src)
        return null
      })
    this.decoding.set(src, promise)
  }

  // ── Teardown ────────────────────────────────────────────────────────────────────────────────

  private stop(entry: Scheduled): void {
    entry.source.onended = null
    try {
      entry.source.stop()
    } catch {
      // Already stopped by the end of its own buffer.
    }
    this.release(entry)
  }

  private release(entry: Scheduled): void {
    entry.source.disconnect()
    entry.tone.output.disconnect()
    entry.gate?.disconnect()
    entry.makeup?.disconnect()
    entry.gain.disconnect()
  }

  private stopAll(): void {
    for (const entry of this.active.values()) this.stop(entry)
    this.active.clear()
  }
}
