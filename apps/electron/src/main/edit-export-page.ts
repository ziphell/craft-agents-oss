/**
 * The page that renders a cut — **not bound to the wall clock**.
 *
 * This is the difference between recording and encoding. `MediaRecorder` follows real time: a
 * thirty-second cut takes thirty seconds, and every pause for loading the next source is written
 * into the film. Here each frame is decoded from its source, drawn at the composition's own
 * timestamp, and handed to `VideoEncoder` through MediaBunny — so the file's length is the
 * timeline's own length, gaps included, and the export runs as fast as decoding allows.
 *
 * Sound is mixed, not captured: every audio-bearing clip (sound tracks, and the audio inside video
 * clips) is decoded once and rendered in 15-second chunks through `OfflineAudioContext`, with the
 * same `start` / `in` / `duration` the document holds. The chunks go into one audio track. A cut
 * with no decodable sound encodes silent.
 *
 * Two details are ported from OpenReel because they decide whether the result is right:
 *
 * - **codec probing** — `getFirstEncodableVideoCodec` / `getFirstEncodableAudioCodec` pick what
 *   this machine can actually encode, instead of assuming H.264/AAC.
 * - **AAC priming** — the encoder's delay is measured and written into the MP4's edit list, so the
 *   sound starts where the picture does. See `edit-export-timing.ts`.
 *
 * Bundled separately (`scripts/electron-build-export-page.ts`) because it imports MediaBunny and
 * runs in a hidden window; the host loads it from `edit-export-page.js`.
 *
 * The only bridge to the main process is the preload's `window.editExport`: bytes in (a `file://`
 * page cannot `fetch` its own neighbours), chunks out (with their file offset, because a muxer
 * writes into a file rather than appending blindly), progress, done.
 */

import {
  ALL_FORMATS,
  AudioBufferSource,
  BlobSource,
  CanvasSource,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  StreamTarget,
  VideoSampleSink,
  WebMOutputFormat,
  type AudioCodec,
  type VideoCodec,
} from 'mediabunny'
import { createMp3Encoder } from 'wasm-media-encoders'
import { applyMp4AudioTiming, measureAacPriming } from './edit-export-timing'
import { automationGainAt, type VolumePoint } from '../../../../packages/shared/src/reel/ducking'
import {
  clipSourceTime,
  type ClipTransform,
  type CropRect,
  type EditMask,
  type TransformKeyframe,
  type TransitionKind,
} from '../../../../packages/shared/src/reel/document'
import type { EditOverlay } from '../../../../packages/shared/src/reel/overlay'
import {
  drawComposition,
  type Picture,
} from '../../../../packages/shared/src/reel/canvas-compositor'
import type { ClipEffect } from '../../../../packages/shared/src/reel/effects'
import type { AudioEffect } from '../../../../packages/shared/src/reel/audio-effects'
import { createAudioEffectChain } from '../../../../packages/shared/src/reel/audio-effects-web'
import {
  audioRms,
  gateWindowCurve,
  noiseGateCurve,
  normalizationGain,
} from '../../../../packages/shared/src/reel/audio-mastering'

export interface ExportClip {
  path: string
  in: number
  duration: number
  /** Where this piece sits on the timeline. The render keeps the gaps. */
  start: number
  kind: 'video' | 'image' | 'audio'
  /** Higher tracks cover lower ones when pictures overlap. */
  track: number
  /** 0..1; omitted means full. */
  volume?: number
  /** The clip's own sound is off — a detached audio clip is what plays instead. */
  muted?: boolean
  /** Seconds of fade at each end of the clip's sound. */
  fadeIn?: number
  fadeOut?: number
  /** Volume keyframes inside the clip (ducking and hand-written automation). */
  automation?: VolumePoint[]
  /** Placement of the picture inside the composition. */
  transform?: ClipTransform
  /** 0..1; omitted means fully opaque. */
  opacity?: number
  /** Placement over time; when present it replaces `transform`/`opacity`. */
  keyframes?: TransformKeyframe[]
  /** A window onto the source, in fractions of its frame. */
  crop?: CropRect
  /** A held frame: the source time stays at `in`. */
  freeze?: true
  /** Colour grading; the same filter string the preview puts on the canvas. */
  effect?: ClipEffect
  /** Tone of this clip's own sound; the preview builds the same chain. */
  audioEffect?: AudioEffect
  /** Playback speed; the picture and its sound both run at this rate. */
  speed?: number
  /** The transition that brings this clip in from the clip immediately before it. */
  transition?: { kind: TransitionKind; duration: number }
  /** The track is hidden: its sound is mixed, its picture is not drawn. */
  hidden?: boolean
  /** Shape masks over this clip, applied after its transform. */
  masks?: EditMask[]
}

export interface ExportJob {
  clips: ExportClip[]
  /** Subtitles, styled text and picture-in-picture boxes above the tracks. */
  overlays: EditOverlay[]
  width: number
  height: number
  fps: number
  /**
   * `mp4` (H.264 + AAC), `webm` (VP9 + Opus), or `mp3` (sound only, LAME through WASM — a bare
   * frame stream, so nothing is muxed). The caller names the file, so it picks this.
   */
  container: 'mp4' | 'webm' | 'mp3'
  /**
   * Mix the sound and write no picture — the same timeline, as an audio file (`.m4a` in an MP4
   * container). The picture loop is skipped entirely, so the export costs only the audio render.
   * `mp3` implies this: an MP3 cannot carry a picture.
   */
  audioOnly?: boolean
}

interface Bridge {
  sendChunk: (bytes: Uint8Array, position: number) => void
  progress: (ratio: number) => void
  finish: (message: string | null) => void
  readFile: (path: string) => Promise<Uint8Array>
}

declare global {
  interface Window {
    editExport: Bridge
    __render: (job: ExportJob) => Promise<void>
  }
}

const bridge = () => window.editExport

/** One read per file: a clip used twice must not cross the IPC boundary twice. */
const readCache = new Map<string, Promise<Uint8Array<ArrayBuffer>>>()
function bytesOf(path: string): Promise<Uint8Array<ArrayBuffer>> {
  const known = readCache.get(path)
  if (known) return known
  const reading = (async () => {
    const bytes = await bridge().readFile(path)
    // An exact copy, so `buffer` is the file and nothing else.
    const copy = new Uint8Array(bytes.byteLength)
    copy.set(bytes)
    return copy
  })()
  readCache.set(path, reading)
  return reading
}

/** A still picture, as opposed to a clip with frames. */
const STILL = /\.(png|jpe?g|webp|gif|avif|bmp|svg)$/i

/**
 * Why a source cannot be read, in words a caller can act on.
 *
 * MediaBunny's own message names the codec at best; what the caller needs is the file and the
 * remedy. The decoder is Chromium's, so the limits are Chromium's: HEVC needs a hardware decoder
 * and ProRes is not read at all.
 */
function undecodable(path: string, error: unknown): Error {
  const why = error instanceof Error ? error.message : String(error)
  return new Error(
    `${path}: ${why}. Chromium reads H.264/VP9 and most MOV; HEVC needs a hardware decoder, ` +
      'and ProRes is not supported — convert the source to H.264 MP4 and export again.',
  )
}

/** The gain at a clip-relative moment: linear fade in, linear fade out, whichever is lower. */
function fadeGainAt(
  volume: number,
  duration: number,
  fadeIn: number,
  fadeOut: number,
  local: number,
): number {
  const inValue = fadeIn > 0 ? Math.min(1, Math.max(0, local / fadeIn)) : 1
  const outValue = fadeOut > 0 ? Math.min(1, Math.max(0, (duration - local) / fadeOut)) : 1
  return volume * Math.min(inValue, outValue)
}

/** How much of the timeline one audio render covers. Long cuts do not become one huge buffer. */
const AUDIO_CHUNK_SECONDS = 15
const SAMPLE_RATE = 48_000
const CHANNELS = 2

window.__render = async (job: ExportJob) => {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(2, Math.round(job.width))
  canvas.height = Math.max(2, Math.round(job.height))
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) {
    bridge().finish('this window has no 2d canvas')
    return
  }
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  /** Sound only: the picture loop is empty, so no frame is ever drawn or encoded. */
  const audioOnly = job.audioOnly === true || job.container === 'mp3'

  const duration = Math.max(
    job.clips.reduce((end, clip) => Math.max(end, clip.start + clip.duration), 0),
    job.overlays.reduce((end, overlay) => Math.max(end, overlay.start + overlay.duration), 0),
  )
  if (duration <= 0) {
    bridge().finish('this cut has no duration')
    return
  }

  try {
    // ── Sound: decode each source once, then mix in chunks ───────────────────────────────────
    /** One sound source on the timeline: a clip's own audio, or a picture-in-picture's. */
    interface Sound {
      path: string
      start: number
      in: number
      duration: number
      volume: number
      fadeIn: number
      fadeOut: number
      automation?: VolumePoint[]
      audioEffect?: AudioEffect
      speed: number
    }
    const sounds: Sound[] = [
      ...job.clips
        .filter((clip) => clip.kind !== 'image' && !clip.muted && (clip.volume ?? 1) > 0)
        .map((clip) => ({
          path: clip.path,
          start: clip.start,
          in: clip.in,
          duration: clip.duration,
          volume: Math.min(1, Math.max(0, clip.volume ?? 1)),
          fadeIn: Math.max(0, clip.fadeIn ?? 0),
          fadeOut: Math.max(0, clip.fadeOut ?? 0),
          speed: Math.min(100, Math.max(0.1, clip.speed ?? 1)),
          ...(clip.automation?.length ? { automation: clip.automation } : {}),
          ...(clip.audioEffect ? { audioEffect: clip.audioEffect } : {}),
        })),
      // A picture-in-picture carries sound only when it says so; the panel keeps it silent by
      // default, so an added box never talks over the picture unexpectedly.
      ...job.overlays
        .filter(
          (overlay) =>
            overlay.kind === 'media' &&
            !!overlay.src &&
            !STILL.test(overlay.src) &&
            overlay.muted === false &&
            (overlay.volume ?? 1) > 0,
        )
        .map((overlay) => ({
          path: overlay.src!,
          start: overlay.start,
          in: overlay.in ?? 0,
          duration: overlay.duration,
          volume: Math.min(1, Math.max(0, overlay.volume ?? 1)),
          fadeIn: 0,
          fadeOut: 0,
          speed: 1,
        })),
    ]
    const decoded = new Map<string, AudioBuffer>()
    if (sounds.length > 0) {
      const decoding = new OfflineAudioContext(CHANNELS, 1, SAMPLE_RATE)
      for (const sound of sounds) {
        if (decoded.has(sound.path)) continue
        try {
          const bytes = await bytesOf(sound.path)
          decoded.set(sound.path, await decoding.decodeAudioData(bytes.buffer))
        } catch {
          // A source without a decodable audio track is silent, not a failed export.
        }
      }
    }

    // Loudness and gate curves, measured once per source — the same numbers the preview uses.
    const mastered = new Map<string, { gain: number; gate: Float32Array }>()
    for (const [path, buffer] of decoded) {
      const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) =>
        buffer.getChannelData(index),
      )
      mastered.set(path, {
        gain: normalizationGain(audioRms(channels)),
        gate: noiseGateCurve(channels, buffer.sampleRate),
      })
    }

    // Sound is rendered only after the encoder is ready: one 15-second chunk at a time goes into
    // the audio track, so a long cut is never held as one giant buffer.
    let audioFrames = 0

    if (audioOnly && decoded.size === 0) {
      throw new Error('This cut has no sound to export — unmute a clip or add audio first.')
    }

    /**
     * One 15-second slice of the mix, rendered offline.
     *
     * Shared by both audio paths: the muxed track (MP4/WebM) and the bare MP3 stream, so a change
     * to gain, effect or speed reaches both.
     */
    const renderSoundChunk = async (start: number, length: number): Promise<AudioBuffer> => {
      const offline = new OfflineAudioContext(
        CHANNELS,
        Math.max(1, Math.ceil(length * SAMPLE_RATE)),
        SAMPLE_RATE,
      )
      for (const sound of sounds) {
        const buffer = decoded.get(sound.path)
        if (!buffer) continue
        const from = Math.max(sound.start, start)
        const to = Math.min(sound.start + sound.duration, start + length)
        if (to <= from) continue
        const offset = Math.max(0, sound.in + (from - sound.start) * sound.speed)
        const playable = Math.min(to - from, Math.max(0, (buffer.duration - offset) / sound.speed))
        if (playable <= 0.01) continue

        const gain = offline.createGain()
        const levelAt = (time: number) =>
          fadeGainAt(sound.volume, sound.duration, sound.fadeIn, sound.fadeOut, time - sound.start) *
          automationGainAt(sound.automation, time - sound.start)
        gain.gain.setValueAtTime(levelAt(from), from - start)
        // Fade edges and keyframes inside this chunk become ramp targets; a chunk boundary
        // re-schedules the level, so the envelope is continuous across 15-second pieces.
        if (sound.fadeIn > 0 || sound.fadeOut > 0 || sound.automation?.length) {
          const edges = [
            sound.start + sound.fadeIn,
            sound.start + sound.duration - sound.fadeOut,
            ...(sound.automation ?? []).map((point) => sound.start + point.time),
          ]
            .filter((time) => time > from && time < to)
            .sort((left, right) => left - right)
          for (const time of edges) {
            gain.gain.linearRampToValueAtTime(levelAt(time), time - start)
          }
        }
        gain.connect(offline.destination)
        const node = offline.createBufferSource()
        node.buffer = buffer
        // Varispeed, the same as the preview: the pitch follows the speed.
        node.playbackRate.value = sound.speed
        // The tone chain sits between the source and the gain stage, exactly as in the preview.
        const chain = createAudioEffectChain(offline, sound.audioEffect)
        node.connect(chain.input)
        let tail: AudioNode = chain.output
        const info = mastered.get(sound.path)
        let gate: GainNode | undefined
        if (sound.audioEffect?.denoise === true && info) {
          gate = offline.createGain()
          tail.connect(gate)
          tail = gate
        }
        if (sound.audioEffect?.normalize === true && info) {
          const makeup = offline.createGain()
          makeup.gain.value = info.gain
          tail.connect(makeup)
          tail = makeup
        }
        tail.connect(gain)
        if (gate && info) {
          gate.gain.setValueCurveAtTime(
            gateWindowCurve(
              info.gate,
              offset,
              offset + playable * sound.speed,
              playable,
            ),
            from - start,
            playable,
          )
        }
        // `duration` is counted in the buffer's own seconds, so a speeded clip asks for
        // `playable × speed` of source — the timeline length is `playable`.
        node.start(from - start, offset, playable * sound.speed)
      }
      return offline.startRendering()
    }

    // ── MP3: a bare frame stream, so LAME writes the file directly ────────────────────────────
    // No muxer is involved: each encoded frame is appended at its own offset.
    if (job.container === 'mp3') {
      const encoder = await createMp3Encoder()
      encoder.configure({ sampleRate: SAMPLE_RATE, channels: CHANNELS, bitrate: 128 })
      let position = 0
      const write = (bytes: Uint8Array): void => {
        if (bytes.length === 0) return
        // The encoder owns the view it returns; copy before the next call replaces it.
        const copy = bytes.slice()
        bridge().sendChunk(copy, position)
        position += copy.length
      }
      for (let start = 0; start < duration; start += AUDIO_CHUNK_SECONDS) {
        const length = Math.min(AUDIO_CHUNK_SECONDS, duration - start)
        const chunk = await renderSoundChunk(start, length)
        const left = chunk.getChannelData(0)
        const right = chunk.numberOfChannels > 1 ? chunk.getChannelData(1) : left
        write(encoder.encode([left, right]))
        bridge().progress(((start + length) / duration) * 0.98)
      }
      write(encoder.finalize())
      bridge().progress(1)
      bridge().finish(null)
      return
    }

    // ── Container, and what this machine can encode into it ──────────────────────────────────
    // A holder rather than a plain `let`: the callback runs inside the muxer, and TypeScript's
    // control-flow narrowing would otherwise think this stays null after `finalize()`.
    const movie: { current: { bytes: Uint8Array; position: number } | null } = { current: null }
    const format =
      job.container === 'webm'
        ? new WebMOutputFormat()
        : new Mp4OutputFormat({
            fastStart: false,
            onMoov: (bytes, position) => {
              movie.current = { bytes, position }
            },
          })

    // Preference order first, then anything else the format can mux — this is the same “probe,
    // never assume” rule OpenReel uses, so a machine without H.264 still exports.
    const videoPreference = job.container === 'webm' ? ['vp9', 'vp8', 'av1'] : ['avc', 'hevc', 'av1', 'vp9']
    const supportedVideo = format.getSupportedVideoCodecs()
    const videoCandidates = [
      ...(videoPreference.filter((codec) => supportedVideo.includes(codec as VideoCodec)) as VideoCodec[]),
      ...supportedVideo.filter((codec) => !videoPreference.includes(codec)),
    ]
    // An audio-only job never asks the machine for a picture codec.
    let videoCodec: VideoCodec | null = null
    if (!audioOnly) {
      videoCodec = await getFirstEncodableVideoCodec(videoCandidates, {
        width: canvas.width,
        height: canvas.height,
        frameRate: job.fps,
        quality: QUALITY_HIGH,
      })
      if (!videoCodec) {
        throw new Error(
          `This machine cannot encode ${job.container.toUpperCase()} at ${canvas.width}×${canvas.height}. Try WebM.`,
        )
      }
    }

    let audioCodec: AudioCodec | null = null
    if (decoded.size > 0) {
      const audioPreference = job.container === 'webm' ? ['opus', 'vorbis', 'aac', 'mp3'] : ['aac', 'mp3', 'opus', 'vorbis']
      const supportedAudio = format.getSupportedAudioCodecs() as AudioCodec[]
      const audioCandidates = [
        ...(audioPreference.filter((codec) => supportedAudio.includes(codec as AudioCodec)) as AudioCodec[]),
        ...supportedAudio.filter((codec) => !audioPreference.includes(codec)),
      ]
      audioCodec = await getFirstEncodableAudioCodec(audioCandidates, {
        numberOfChannels: CHANNELS,
        sampleRate: SAMPLE_RATE,
        quality: QUALITY_HIGH,
      })
      if (!audioCodec) {
        throw new Error(`This machine cannot encode audio for ${job.container.toUpperCase()}.`)
      }
    }

    // AAC priming is a property of this machine's encoder. A probe that cannot verify itself
    // only costs the correction, not the export.
    let audioPriming: number | null = null
    if (audioCodec === 'aac' && job.container !== 'webm') {
      try {
        audioPriming = await measureAacPriming({ sampleRate: SAMPLE_RATE, channels: CHANNELS })
      } catch (error) {
        console.warn('[edit-export] audio priming could not be measured:', error)
      }
    }

    // ── Picture: one frame per output moment ──────────────────────────────────────────────────
    // An audio-only job renders no frames at all; the loop below is simply empty.
    const frames = audioOnly ? 0 : Math.max(1, Math.ceil(duration * job.fps))

    // ── Output: sound is submitted before the first frame, as OpenReel does ───────────────────
    const writable = new WritableStream<{ type: 'write'; data: Uint8Array; position: number }>({
      write(chunk) {
        bridge().sendChunk(chunk.data, chunk.position)
      },
    })
    const output = new Output({
      format,
      target: new StreamTarget(writable, { chunked: true }),
    })
    const videoSource = videoCodec
      ? new CanvasSource(canvas, { codec: videoCodec, quality: QUALITY_HIGH })
      : null
    const audioSource = audioCodec
      ? new AudioBufferSource({ codec: audioCodec, quality: QUALITY_HIGH })
      : null
    if (videoSource) output.addVideoTrack(videoSource, { frameRate: job.fps })
    if (audioSource) output.addAudioTrack(audioSource)
    await output.start()

    if (audioSource) {
      // Sound first, as OpenReel's backend does: the muxer sees the audio track complete before
      // the first picture frame.
      for (let start = 0; start < duration; start += AUDIO_CHUNK_SECONDS) {
        const length = Math.min(AUDIO_CHUNK_SECONDS, duration - start)
        const chunk = await renderSoundChunk(start, length)
        await audioSource.add(chunk)
        audioFrames += chunk.length
        // With no picture to follow, the mix is the whole export.
        bridge().progress(
          audioOnly ? ((start + length) / duration) * 0.98 : 0.01 + ((start + length) / duration) * 0.04,
        )
      }
    }

    const frame = 1 / Math.max(1, job.fps)
    const sinks = new Map<string, Promise<VideoSampleSink | null>>()
    const bitmaps = new Map<string, Promise<ImageBitmap | null>>()

    /** One decoder per source file, opened only when a frame actually needs it. */
    const sinkOf = (path: string): Promise<VideoSampleSink | null> => {
      const known = sinks.get(path)
      if (known) return known
      const opening = (async () => {
        try {
          const input = new Input({
            formats: ALL_FORMATS,
            source: new BlobSource(new Blob([await bytesOf(path)])),
          })
          const track = await input.getPrimaryVideoTrack()
          return track ? new VideoSampleSink(track) : null
        } catch (error) {
          throw undecodable(path, error)
        }
      })()
      sinks.set(path, opening)
      return opening
    }

    const bitmapOf = (path: string): Promise<ImageBitmap | null> => {
      const known = bitmaps.get(path)
      if (known) return known
      const opening = (async () => {
        try {
          return await createImageBitmap(new Blob([await bytesOf(path)]))
        } catch (error) {
          throw undecodable(path, error)
        }
      })()
      bitmaps.set(path, opening)
      return opening
    }

    /** One decoded frame as a `Picture`, so the shared compositor can paint it. */
    const pictureFrom = async (
      path: string,
      kind: 'video' | 'image',
      sourceTime: number,
    ): Promise<Picture | null> => {
      if (kind === 'image') {
        const bitmap = await bitmapOf(path)
        return bitmap
          ? {
              width: bitmap.width,
              height: bitmap.height,
              draw: (target, x, y, width, height) => target.drawImage(bitmap, x, y, width, height),
            }
          : null
      }
      const sink = await sinkOf(path)
      const sample = sink ? await sink.getSample(sourceTime) : null
      if (!sample) return null
      return {
        width: sample.displayWidth,
        height: sample.displayHeight,
        draw: (target, x, y, width, height) => sample.draw(target, x, y, width, height),
        release: () => sample.close(),
      }
    }

    for (let index = 0; index < frames; index += 1) {
      const time = index / job.fps
      // The same painter the preview uses; only where a frame comes from differs.
      await drawComposition({
        ctx,
        canvas,
        clips: job.clips,
        overlays: job.overlays,
        time,
        pictureOf: (clip, local) =>
          pictureFrom(clip.path, clip.kind === 'image' ? 'image' : 'video', clipSourceTime(clip, local)),
        overlayPictureOf: (overlay, local) =>
          overlay.src
            ? pictureFrom(
                overlay.src,
                STILL.test(overlay.src) ? 'image' : 'video',
                (overlay.in ?? 0) + local,
              )
            : null,
      })

      // `add` resolving is the backpressure signal: it waits until the encoder and the muxer are
      // ready for another frame, so a long export does not pile up frames in memory.
      if (videoSource) await videoSource.add(time, frame)
      bridge().progress(0.05 + ((index + 1) / frames) * 0.95)
    }

    videoSource?.close()
    audioSource?.close()
    await output.finalize()

    // The MP4 was written with the encoder's own delay; tell players to skip it.
    if (audioPriming !== null && movie.current && audioFrames > 0) {
      try {
        const corrected = applyMp4AudioTiming(movie.current.bytes, audioPriming, SAMPLE_RATE, audioFrames)
        bridge().sendChunk(corrected, movie.current.position)
      } catch (error) {
        console.warn('[edit-export] audio timing could not be corrected:', error)
      }
    }

    bridge().progress(1)
    bridge().finish(null)
  } catch (error) {
    // The host awaits this promise, so rejecting is what makes a failure a failure even when the
    // separate `done` message loses the race with the end of this call.
    bridge().finish(error instanceof Error ? error.message : String(error))
    throw error
  }
}
