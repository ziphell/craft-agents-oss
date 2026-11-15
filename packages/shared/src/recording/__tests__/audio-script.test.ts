import { describe, expect, it } from 'bun:test'
import {
  AUDIO_SAMPLE_RATE,
  audioChunkExpression,
  buildAudioExtractScript,
  decodeAudioReply,
  wavBytes,
} from '../audio-script.ts'

describe('the sound of a recording, as bytes', () => {
  it('writes a 16-bit mono WAV header over the PCM', () => {
    const pcm = new Uint8Array([1, 2, 3, 4])
    const wav = wavBytes(pcm, AUDIO_SAMPLE_RATE)
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)

    expect(wav.byteLength).toBe(44 + pcm.byteLength)
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe('RIFF')
    expect(String.fromCharCode(...wav.slice(8, 12))).toBe('WAVE')
    expect(String.fromCharCode(...wav.slice(36, 40))).toBe('data')
    expect(view.getUint16(20, true)).toBe(1) // PCM
    expect(view.getUint16(22, true)).toBe(1) // mono
    expect(view.getUint32(24, true)).toBe(AUDIO_SAMPLE_RATE)
    expect(view.getUint16(34, true)).toBe(16)
    expect(view.getUint32(40, true)).toBe(pcm.byteLength)
    expect([...wav.slice(44)]).toEqual([1, 2, 3, 4])
  })

  it('reads the page’s answer, and refuses one with no sound in it', () => {
    expect(decodeAudioReply({ durationMs: 65_000, sampleRate: 16_000, byteLength: 2_080_000 })).toEqual({
      durationMs: 65_000,
      sampleRate: 16_000,
      byteLength: 2_080_000,
    })

    expect(() => decodeAudioReply({ error: 'the recording has no sound', errorKind: 'file' })).toThrow(
      'Could not read the sound',
    )
    expect(() => decodeAudioReply({ durationMs: 1, sampleRate: 16_000, byteLength: 0 })).toThrow(
      'no audio track',
    )
  })

  it('asks for the file it was given, at the rate the transcriber wants', () => {
    const script = buildAudioExtractScript('file:///tmp/clip.mp4')
    expect(script).toContain('"file:///tmp/clip.mp4"')
    expect(script).toContain(`OfflineAudioContext(1, 1, ${AUDIO_SAMPLE_RATE})`)
    expect(script).toContain('__craftAudioChunk')
    expect(audioChunkExpression(8, 16)).toBe('__craftAudioChunk(8, 16)')
  })
})
