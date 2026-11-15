/**
 * Separating a recording's sound, as a page script — written once for both hosts.
 *
 * The decoder is Chromium's, the same one that samples frames: the desktop runs this in a hidden
 * window, a hub in its render host. Nothing here needs ffmpeg, which is what makes "take the sound
 * out of this clip" work on a machine that has only the app.
 *
 * The answer is a WAV at {@link AUDIO_SAMPLE_RATE}, mono, 16-bit — exactly what `asr-tool` reads.
 * PCM is pulled back in chunks rather than returned as one string: ten minutes of speech is ~19 MB,
 * and serializing that through one `executeJavaScript` reply is how a window dies of memory.
 */

/** What speech recognition wants, and what this writes: 16 kHz mono. */
export const AUDIO_SAMPLE_RATE = 16_000

export interface AudioExtractReply {
  error?: string
  /** `file` is "this recording cannot be read at all", as opposed to "it has no sound". */
  errorKind?: 'file'
  durationMs?: number
  sampleRate?: number
  byteLength?: number
}

export interface ExtractedAudio {
  durationMs: number
  sampleRate: number
  byteLength: number
}

/**
 * Decode a recording into mono PCM and park it on `window.__craftAudioPcm`.
 *
 * The two contexts are deliberate. `decodeAudioData` belongs to a context and resamples to its
 * rate, so the first one is where the file's own rate becomes 16 kHz. The second exists for the
 * channel count: a buffer source feeding a one-channel destination is downmixed by the browser,
 * which is the same arithmetic a person would do by hand and one less place to get it wrong.
 */
export function buildAudioExtractScript(
  url: string,
  sampleRate: number = AUDIO_SAMPLE_RATE,
): string {
  return `(async () => {
  // The file comes in as bytes, and which way works depends on the page's origin: a data: page in
  // the desktop window needs XHR under \`webSecurity: false\`, a file: page in the render host takes
  // either. Trying both costs one failed request and removes a host-specific branch from here.
  const read = async () => {
    const viaXhr = await new Promise((resolve) => {
      try {
        const request = new XMLHttpRequest()
        request.open('GET', ${JSON.stringify(url)}, true)
        request.responseType = 'arraybuffer'
        request.onload = () => resolve(request.response || null)
        request.onerror = () => resolve(null)
        request.send()
      } catch (error) {
        resolve(null)
      }
    })
    if (viaXhr && viaXhr.byteLength > 0) return viaXhr
    try {
      const response = await fetch(${JSON.stringify(url)})
      if (response.ok) return await response.arrayBuffer()
    } catch (error) {
      // Fall through to the refusal below.
    }
    return null
  }

  const bytes = await read()
  if (!bytes || bytes.byteLength === 0) {
    return { error: 'this host could not read the file', errorKind: 'file' }
  }

  let decoded
  try {
    const decodeContext = new OfflineAudioContext(1, 1, ${sampleRate})
    decoded = await decodeContext.decodeAudioData(bytes)
  } catch (error) {
    return { error: 'the recording has no audio track this browser can decode', errorKind: 'file' }
  }
  if (!decoded || !(decoded.duration > 0)) {
    return { error: 'the recording has no sound', errorKind: 'file' }
  }

  const frames = Math.max(1, Math.ceil(decoded.duration * ${sampleRate}))
  const renderContext = new OfflineAudioContext(1, frames, ${sampleRate})
  const source = renderContext.createBufferSource()
  source.buffer = decoded
  source.connect(renderContext.destination)
  source.start()
  const rendered = await renderContext.startRendering()
  const channel = rendered.getChannelData(0)

  const pcm = new Uint8Array(channel.length * 2)
  const view = new DataView(pcm.buffer)
  for (let index = 0; index < channel.length; index += 1) {
    const value = Math.max(-1, Math.min(1, channel[index]))
    view.setInt16(index * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true)
  }

  window.__craftAudioPcm = pcm
  window.__craftAudioChunk = (offset, length) => {
    const slice = window.__craftAudioPcm.subarray(offset, offset + length)
    let binary = ''
    const step = 0x8000
    for (let index = 0; index < slice.length; index += step) {
      binary += String.fromCharCode.apply(null, slice.subarray(index, index + step))
    }
    return btoa(binary)
  }

  return {
    durationMs: Math.round(decoded.duration * 1000),
    sampleRate: ${sampleRate},
    byteLength: pcm.length,
  }
})()`
}

/** Read one slice of the parked PCM back, as base64. */
export function audioChunkExpression(offset: number, length: number): string {
  return `__craftAudioChunk(${offset}, ${length})`
}

/** How much PCM one round trip carries: 4 MB is ~5 MB of base64 and ~2 minutes of speech. */
export const AUDIO_CHUNK_BYTES = 4 * 1024 * 1024

/**
 * What the page answered, as the value a caller uses.
 *
 * A clip with no audio track is the ordinary failure here — a screen recording of a silent demo —
 * so it says that rather than "no frames came back".
 */
export function decodeAudioReply(raw: AudioExtractReply | null | undefined): ExtractedAudio {
  if (raw?.error) {
    const remedy =
      raw.errorKind === 'file'
        ? ''
        : ' Chromium reads mp4 (H.264), webm, most mov files and m4a; HEVC needs a hardware decoder.'
    throw new Error(`Could not read the sound: ${raw.error}.${remedy}`)
  }
  const sampleRate = raw?.sampleRate ?? AUDIO_SAMPLE_RATE
  const byteLength = raw?.byteLength ?? 0
  if (byteLength <= 0) throw new Error('Could not read the sound: the recording has no audio track.')
  return {
    durationMs: raw?.durationMs ?? 0,
    sampleRate,
    byteLength,
  }
}

/** The PCM as a 16-bit mono WAV — the file `asr-tool` takes. */
export function wavBytes(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const header = new Uint8Array(44)
  const view = new DataView(header.buffer)
  const write = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      header[offset + index] = text.charCodeAt(index)
    }
  }
  write(0, 'RIFF')
  view.setUint32(4, 36 + pcm.byteLength, true)
  write(8, 'WAVE')
  write(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  write(36, 'data')
  view.setUint32(40, pcm.byteLength, true)

  const file = new Uint8Array(44 + pcm.byteLength)
  file.set(header, 0)
  file.set(pcm, 44)
  return file
}
