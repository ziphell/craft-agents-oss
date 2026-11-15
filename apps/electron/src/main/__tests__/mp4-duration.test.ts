/**
 * Tests for settling a recording's declared duration.
 *
 * The fixtures are built by hand rather than taken from a recording: what is being pinned is the
 * field layout of the four boxes this rewrites (version 0 and version 1 alike), and a real file
 * would only be one sample of that.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readMp4DeclaredDurations, settleMp4Duration } from '../mp4-duration'

function box(type: string, body: Buffer): Buffer {
  const out = Buffer.alloc(8 + body.length)
  out.writeUInt32BE(8 + body.length, 0)
  out.write(type, 4, 'latin1')
  body.copy(out, 8)
  return out
}

/** `mvhd`/`mdhd` layout: creation, modification, timescale, duration. */
function headerBox(type: 'mvhd' | 'mdhd', version: 0 | 1, timescale: number, duration: number): Buffer {
  const wide = version === 1
  const body = Buffer.alloc(4 + (wide ? 8 + 8 : 4 + 4) + 4 + (wide ? 8 : 4) + 64)
  body.writeUInt8(version, 0)
  body.writeUInt32BE(timescale, wide ? 20 : 12)
  if (wide) body.writeBigUInt64BE(BigInt(duration), 24)
  else body.writeUInt32BE(duration, 16)
  return box(type, body)
}

/** `tkhd` carries a track ID and a reserved pair where the others carry a timescale. */
function tkhdBox(version: 0 | 1, duration: number): Buffer {
  const wide = version === 1
  const body = Buffer.alloc(4 + (wide ? 8 + 8 : 4 + 4) + 4 + 4 + (wide ? 8 : 4) + 64)
  body.writeUInt8(version, 0)
  body.writeUInt32BE(1, wide ? 20 : 12)
  if (wide) body.writeBigUInt64BE(BigInt(duration), 28)
  else body.writeUInt32BE(duration, 20)
  return box('tkhd', body)
}

/** A file shaped like a recording: an ftyp, a moov with one track, then media data. */
function recordingLike(version: 0 | 1, movieDuration = 0, mediaDuration = 0): Buffer {
  const moov = box(
    'moov',
    Buffer.concat([
      headerBox('mvhd', version, 1000, movieDuration),
      box(
        'trak',
        Buffer.concat([
          tkhdBox(version, movieDuration),
          box('mdia', Buffer.concat([headerBox('mdhd', version, 30000, mediaDuration), box('minf', Buffer.alloc(16))])),
        ]),
      ),
    ]),
  )
  return Buffer.concat([box('ftyp', Buffer.from('isom0000', 'latin1')), moov, box('mdat', Buffer.alloc(64))])
}

describe('settleMp4Duration', () => {
  let dir: string
  const pathOf = (name: string): string => join(dir, name)

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'craft-mp4-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('sets the movie, track and media durations to what the recording ran', () => {
    const file = pathOf('recording.mp4')
    writeFileSync(file, recordingLike(1))

    expect(settleMp4Duration(file, 23_327)).toBe(true)

    const declared = readMp4DeclaredDurations(file)
    // Each field in its own timescale, and all three saying the same thing.
    expect(declared.movie).toBeCloseTo(23.327, 3)
    expect(declared.track).toBeCloseTo(23.327, 3)
    expect(declared.media).toBeCloseTo(23.327, 3)
  })

  it('reads a version 0 header the same way', () => {
    const file = pathOf('recording-v0.mp4')
    writeFileSync(file, recordingLike(0))

    expect(settleMp4Duration(file, 5_033)).toBe(true)

    const declared = readMp4DeclaredDurations(file)
    expect(declared.movie).toBeCloseTo(5.033, 3)
    expect(declared.track).toBeCloseTo(5.033, 3)
    expect(declared.media).toBeCloseTo(5.033, 3)
  })

  it('rewrites a header that already states a wrong duration', () => {
    const file = pathOf('stale.mp4')
    // What the muxer actually wrote for a 12s recording: mvhd 0, and a ten-second track.
    writeFileSync(file, recordingLike(1, 0, 12_000))
    expect(readMp4DeclaredDurations(file).movie).toBe(0)

    expect(settleMp4Duration(file, 12_012)).toBe(true)
    expect(readMp4DeclaredDurations(file).movie).toBeCloseTo(12.012, 3)
  })

  it('leaves a file it cannot parse exactly as it was', () => {
    const file = pathOf('not-an-mp4.bin')
    const original = Buffer.from('this is not a container at all, and it is left alone')
    writeFileSync(file, original)

    expect(settleMp4Duration(file, 4_000)).toBe(false)
    expect(readFileSync(file).equals(original)).toBe(true)
  })

  it('refuses without a duration to write, and without a file', () => {
    const file = pathOf('recording.mp4')
    const original = recordingLike(1)
    writeFileSync(file, original)

    expect(settleMp4Duration(file, 0)).toBe(false)
    expect(settleMp4Duration(file, -1)).toBe(false)
    expect(settleMp4Duration(pathOf('missing.mp4'), 1_000)).toBe(false)
    // A refusal writes nothing, so the header is still the one the muxer left.
    expect(readFileSync(file).equals(original)).toBe(true)
  })
})
