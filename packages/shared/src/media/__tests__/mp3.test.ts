import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { encodeWavFileToMp3, readWavPcm } from '../mp3.ts'

/** A 16 kHz mono, 16-bit PCM WAV with a quiet sine in it — the shape the extractor writes. */
function writeWav(path: string, seconds: number, sampleRate = 16_000): void {
  const frames = Math.round(seconds * sampleRate)
  const data = Buffer.alloc(frames * 2)
  for (let index = 0; index < frames; index += 1) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 4000), index * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(data.length, 40)
  writeFileSync(path, Buffer.concat([header, data]))
}

describe('WAV → MP3', () => {
  test('reads the PCM the extractor wrote', () => {
    const dir = mkdtempSync(join(tmpdir(), 'craft-mp3-'))
    try {
      const wav = join(dir, 'a.wav')
      writeWav(wav, 0.5)
      const pcm = readWavPcm(new Uint8Array(readFileSync(wav)))
      expect(pcm.sampleRate).toBe(16_000)
      expect(pcm.channels).toHaveLength(1)
      expect(pcm.channels[0]!.length).toBe(8_000)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('compresses to MP3 at the speech profile, with the duration kept', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'craft-mp3-'))
    try {
      const wav = join(dir, 'a.wav')
      writeWav(wav, 1)
      const { bytes, durationMs } = await encodeWavFileToMp3(wav, 32)

      expect(durationMs).toBe(1_000)
      // Roughly 4 KB a second at 32 kbps, plus the Xing/LAME header frame.
      expect(bytes.length).toBeGreaterThan(3_000)
      expect(bytes.length).toBeLessThan(12_000)
      const head = Buffer.from(bytes.subarray(0, 4)).toString('latin1')
      expect(head === 'LAME' || bytes[0] === 0xff).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('refuses a WAV width it cannot read instead of guessing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'craft-mp3-'))
    try {
      const wav = join(dir, 'a.wav')
      writeWav(wav, 0.1)
      const bytes = readFileSync(wav)
      bytes.writeUInt16LE(24, 34) // claim 24-bit
      expect(() => readWavPcm(new Uint8Array(bytes))).toThrow('16-bit PCM')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
