/**
 * Two details that decide whether an exported MP4 sounds right, ported from OpenReel's
 * `audio-priming.ts` and `mp4-audio-timing.ts`.
 *
 * AAC encoders add a platform-dependent delay before the first real sample, and players do not
 * agree on trimming it. The measurement encodes a known chirp, decodes it back and locates the
 * signal, so the delay is a fact about this machine rather than a guessed 44 ms. The correction
 * then writes an edit list into the MP4's `moov` telling players where the audio actually starts.
 *
 * Both are pure browser code (WebCodecs + MP4 boxes); nothing here knows about the cut.
 */

import {
  ALL_FORMATS,
  AudioBufferSource,
  AudioSampleSink,
  BufferSource,
  BufferTarget,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
} from 'mediabunny'

interface Box {
  type: string
  bytes: Uint8Array
}

const decoder = new TextDecoder()

function children(bytes: Uint8Array): Box[] {
  const boxes: Box[] = []
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let offset = 8; offset < bytes.length; ) {
    if (offset + 8 > bytes.length) throw new Error('Incomplete MP4 timing metadata.')
    const size = view.getUint32(offset)
    if (size < 8 || offset + size > bytes.length) throw new Error('Invalid MP4 timing metadata.')
    boxes.push({
      type: decoder.decode(bytes.subarray(offset + 4, offset + 8)),
      bytes: bytes.slice(offset, offset + size),
    })
    offset += size
  }
  return boxes
}

function box(type: string, payloads: Uint8Array[]): Uint8Array {
  const size = 8 + payloads.reduce((total, bytes) => total + bytes.length, 0)
  const bytes = new Uint8Array(size)
  new DataView(bytes.buffer).setUint32(0, size)
  bytes.set(new TextEncoder().encode(type), 4)
  let offset = 8
  for (const payload of payloads) {
    bytes.set(payload, offset)
    offset += payload.length
  }
  return bytes
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function timescale(header: Uint8Array): number {
  return view(header).getUint32(header[8] === 1 ? 28 : 20)
}

function durationOf(header: Uint8Array, track = false): number {
  const offset = track ? (header[8] === 1 ? 36 : 28) : (header[8] === 1 ? 32 : 24)
  return header[8] === 1 ? Number(view(header).getBigUint64(offset)) : view(header).getUint32(offset)
}

function setDuration(header: Uint8Array, value: number, track = false): void {
  const offset = track ? (header[8] === 1 ? 36 : 28) : (header[8] === 1 ? 32 : 24)
  if (header[8] === 1) {
    view(header).setBigUint64(offset, BigInt(value))
  } else {
    if (value > 0xffffffff) throw new Error('MP4 duration exceeds the timing header capacity.')
    view(header).setUint32(offset, value)
  }
}

/** Preserve all encoded samples and offsets; tell players to skip measured AAC priming and end padding. */
export function applyMp4AudioTiming(
  moov: Uint8Array,
  primingSamples: number,
  sampleRate: number,
  audioFrames: number,
): Uint8Array {
  if (
    ![primingSamples, audioFrames].every((value) => Number.isSafeInteger(value) && value >= 0) ||
    !Number.isFinite(sampleRate) ||
    sampleRate <= 0
  ) {
    throw new Error('Invalid audio timing.')
  }
  const movieChildren = children(moov)
  const movieHeader = movieChildren.find((child) => child.type === 'mvhd')
  if (!movieHeader) throw new Error('MP4 movie timing header is missing.')
  const movieScale = timescale(movieHeader.bytes)
  let audioTracks = 0
  for (const track of movieChildren.filter((child) => child.type === 'trak')) {
    const trackChildren = children(track.bytes)
    const media = trackChildren.find((child) => child.type === 'mdia')
    if (!media) continue
    const mediaChildren = children(media.bytes)
    const handler = mediaChildren.find((child) => child.type === 'hdlr')
    if (!handler || decoder.decode(handler.bytes.subarray(16, 20)) !== 'soun') continue
    if (trackChildren.some((child) => child.type === 'edts')) {
      throw new Error('MP4 audio already contains an edit list.')
    }
    const mediaHeader = mediaChildren.find((child) => child.type === 'mdhd')
    const trackHeader = trackChildren.find((child) => child.type === 'tkhd')
    if (!mediaHeader || !trackHeader) throw new Error('MP4 audio timing header is missing.')
    const segmentDuration = Math.round((audioFrames / sampleRate) * movieScale)
    const mediaStart = Math.round((primingSamples / sampleRate) * timescale(mediaHeader.bytes))
    const edit = new Uint8Array(28)
    const editView = view(edit)
    edit[0] = 1 // version 1 supports long recordings
    editView.setUint32(4, 1)
    editView.setBigUint64(8, BigInt(segmentDuration))
    editView.setBigInt64(16, BigInt(mediaStart))
    editView.setInt16(24, 1) // media rate 1.0
    setDuration(trackHeader.bytes, segmentDuration, true)
    track.bytes = box('trak', [...trackChildren.map((child) => child.bytes), box('edts', [box('elst', [edit])])])
    audioTracks++
  }
  if (audioTracks !== 1) throw new Error('Expected one mixed audio track in the MP4 export.')
  const movieDuration = Math.max(
    ...movieChildren
      .filter((child) => child.type === 'trak')
      .map((track) => {
        const header = children(track.bytes).find((child) => child.type === 'tkhd')
        if (!header) throw new Error('MP4 track timing header is missing.')
        return durationOf(header.bytes, true)
      }),
  )
  setDuration(movieHeader.bytes, movieDuration)
  return box('moov', movieChildren.map((child) => child.bytes))
}

/** Locate a known signal after a lossy round trip, in PCM sample units. */
function measureSignalDelay(
  reference: Float32Array,
  decoded: Float32Array,
  signalStart: number,
  signalLength: number,
  maxDelay: number,
): number {
  let bestDelay = 0
  let bestScore = -Infinity
  let referenceEnergy = 0
  for (let index = 0; index < signalLength; index += 1) {
    referenceEnergy += reference[signalStart + index]! ** 2
  }
  for (let delay = 0; delay <= maxDelay; delay += 1) {
    if (signalStart + delay + signalLength > decoded.length) break
    let dot = 0
    let energy = 0
    for (let index = 0; index < signalLength; index += 1) {
      const value = decoded[signalStart + delay + index]!
      dot += reference[signalStart + index]! * value
      energy += value * value
    }
    const score = dot / Math.sqrt(Math.max(1e-20, referenceEnergy * energy))
    if (score > bestScore) {
      bestScore = score
      bestDelay = delay
    }
  }
  if (bestScore < 0.8) throw new Error('Could not verify audio encoder timing. Try WebM or another browser.')
  return bestDelay
}

/**
 * Measure this machine's AAC encoder delay once per configuration.
 *
 * The probe is a short chirp encoded through the same MediaBunny stack the export uses; decoding
 * it pack by pack (rather than with `decodeAudioData`, which may trim on its own) gives the delay
 * the file actually carries.
 */
export async function measureAacPriming(config: {
  sampleRate: number
  channels: number
}): Promise<number> {
  const context = new OfflineAudioContext(config.channels, 16384, config.sampleRate)
  const buffer = context.createBuffer(config.channels, 16384, config.sampleRate)
  const reference = buffer.getChannelData(0)
  const signalStart = 4096
  const signalLength = 4096
  for (let index = 0; index < signalLength; index += 1) {
    const t = index / config.sampleRate
    const phase = 2 * Math.PI * (700 * t + ((2500 * config.sampleRate) / signalLength) * t * t)
    reference[signalStart + index] = 0.6 * Math.sin(phase) * Math.sin((Math.PI * index) / signalLength) ** 2
  }
  for (let channel = 1; channel < config.channels; channel += 1) {
    buffer.copyToChannel(reference, channel)
  }

  const target = new BufferTarget()
  const output = new Output({ format: new Mp4OutputFormat(), target })
  const source = new AudioBufferSource({ codec: 'aac', quality: QUALITY_HIGH })
  output.addAudioTrack(source)
  let finalized = false
  try {
    await output.start()
    await source.add(buffer)
    source.close()
    await output.finalize()
    finalized = true
    if (!target.buffer) throw new Error('Audio timing probe produced no data.')

    const input = new Input({ source: new BufferSource(target.buffer), formats: ALL_FORMATS })
    try {
      const track = await input.getPrimaryAudioTrack()
      if (!track) throw new Error('Audio timing probe produced no audio track.')
      const decoded = new Float32Array(buffer.length + 8192)
      for await (const sample of new AudioSampleSink(track).samples()) {
        try {
          const pcm = sample.toAudioBuffer()
          if (pcm.sampleRate !== config.sampleRate) throw new Error('Audio timing probe changed its sample rate.')
          const offset = Math.round(sample.timestamp * config.sampleRate)
          if (offset < 0 || offset + pcm.length > decoded.length) {
            throw new Error('Audio timing probe exceeded its sample window.')
          }
          decoded.set(pcm.getChannelData(0), offset)
        } finally {
          sample.close()
        }
      }
      return measureSignalDelay(reference, decoded, signalStart, signalLength, 8192)
    } finally {
      input.dispose()
    }
  } finally {
    source.close()
    if (!finalized) await output.cancel().catch(() => undefined)
  }
}
