/**
 * WAV → MP3, in this process.
 *
 * The app does not ship ffmpeg (see `local-sherpa.ts` for the one optional use), so compressing a
 * recording for a model call needs an encoder that travels with the app. LAME compiled to WASM is
 * that encoder: ~130 KB, no native build, and fast enough that a meeting compresses in seconds.
 *
 * Only what this codebase produces is read: 16-bit PCM WAV, mono or stereo, at whatever rate the
 * extractor wrote. Anything else is refused by name rather than fed to the encoder as noise.
 */

import { readFileSync } from 'node:fs'
import { createMp3Encoder } from 'wasm-media-encoders'

export interface WavPcm {
  sampleRate: number
  channels: Float32Array[]
}

/**
 * The PCM inside a WAV, as float channels.
 *
 * Chunks are walked rather than assuming a 44-byte header: a `LIST` chunk may precede `fmt `, which
 * recorders do write. PCM 8/24/32-bit is not this function's job — the extractor writes 16-bit, and
 * silently mis-reading another width is worse than a refusal.
 */
export function readWavPcm(bytes: Uint8Array): WavPcm {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.byteLength < 12) throw new Error('Not a WAV file: too short.')
  const tag = (at: number): string => String.fromCharCode(...bytes.subarray(at, at + 4))
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file: missing RIFF/WAVE header.')

  let channels = 0
  let sampleRate = 0
  let bits = 0
  let format = 0
  let data: Uint8Array | null = null

  let offset = 12
  while (offset + 8 <= view.byteLength) {
    const id = tag(offset)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (id === 'fmt ' && body + 16 <= view.byteLength) {
      format = view.getUint16(body, true)
      channels = view.getUint16(body + 2, true)
      sampleRate = view.getUint32(body + 4, true)
      bits = view.getUint16(body + 14, true)
    } else if (id === 'data') {
      data = bytes.subarray(body, Math.min(body + size, view.byteLength))
      break
    }
    offset = body + size + (size % 2)
  }

  if (format !== 1 || bits !== 16) {
    throw new Error(`Only 16-bit PCM WAV can be compressed here (this file is format ${format}, ${bits}-bit).`)
  }
  if (channels < 1 || channels > 2 || sampleRate <= 0) throw new Error('WAV header names no usable channels or rate.')
  if (!data) throw new Error('WAV file has no data chunk.')

  const pcmBytes = data
  const frames = Math.floor(pcmBytes.byteLength / 2 / channels)
  const samples: Float32Array[] = []
  for (let channel = 0; channel < channels; channel += 1) samples.push(new Float32Array(frames))
  const pcm = new DataView(pcmBytes.buffer, pcmBytes.byteOffset, pcmBytes.byteLength)
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const value = pcm.getInt16((frame * channels + channel) * 2, true)
      samples[channel]![frame] = value / 32768
    }
  }
  return { sampleRate, channels: samples }
}

/** The CBR steps LAME accepts. 32 kbps is the speech default; music can ask for more. */
export type Mp3Bitrate = 8 | 16 | 24 | 32 | 40 | 48 | 64 | 80 | 96 | 112 | 128 | 160 | 192 | 224 | 256 | 320

/** MP3 frames for these channels. */
export async function encodeMp3(options: {
  channels: Float32Array[]
  sampleRate: number
  bitrate?: Mp3Bitrate
}): Promise<Uint8Array> {
  const channelCount = Math.min(2, Math.max(1, options.channels.length)) as 1 | 2
  const encoder = await createMp3Encoder()
  encoder.configure({
    sampleRate: options.sampleRate,
    channels: channelCount,
    // LAME's own frame is 1152 samples; ten frames a call is the sweet spot for speed and memory.
    bitrate: options.bitrate ?? 32,
  })

  const blocks: Uint8Array[] = []
  const blockSize = 1152 * 10
  const length = options.channels[0]?.length ?? 0
  for (let start = 0; start < length; start += blockSize) {
    const view = options.channels.slice(0, channelCount).map((channel) => channel.subarray(start, start + blockSize))
    const encoded = encoder.encode(view)
    // The encoder owns the view it returns; copy before the next call replaces it.
    if (encoded.length) blocks.push(encoded.slice())
  }
  const tail = encoder.finalize()
  if (tail.length) blocks.push(tail.slice())

  const total = blocks.reduce((sum, block) => sum + block.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const block of blocks) {
    out.set(block, offset)
    offset += block.length
  }
  return out
}

/** The WAV a recording extractor wrote, compressed for a model request. */
export async function encodeWavFileToMp3(
  path: string,
  bitrate: Mp3Bitrate = 32,
): Promise<{ bytes: Uint8Array; durationMs: number }> {
  const pcm = readWavPcm(readFileSync(path))
  const bytes = await encodeMp3({ channels: pcm.channels, sampleRate: pcm.sampleRate, bitrate })
  const durationMs = Math.round(((pcm.channels[0]?.length ?? 0) / pcm.sampleRate) * 1000)
  return { bytes, durationMs }
}
