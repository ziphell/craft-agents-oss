/**
 * Make a recorded mp4's declared duration agree with how long the recording actually ran.
 *
 * Why this exists: the container is written by **Chromium's `MediaRecorder`** (the encoder is a
 * hidden window's canvas → `captureStream` → `MediaRecorder` — see `recording-encoder-page.ts`),
 * and its duration bookkeeping is not something a player can rely on. Measured on this machine
 * (0.13.3, Windows), every field it writes for a recording that ran 23.327s:
 *
 *   `mvhd`  timescale=1000  duration=23327  → 23.327s  ✅
 *   `tkhd`  (movie timescale 1000) = 23327  → 23.327s  ✅
 *   `mdhd`  timescale=30000 duration=23327  → 0.778s   ❌ milliseconds in a media-tick field
 *
 * and it is worse than that one field: on two recordings of 12.0s and 14.6s the same muxer wrote
 * `mvhd.duration = 0` and `tkhd.duration = 10004` (ten seconds, stale). The **samples** are right
 * in every case — `moof/traf/trun` carries per-sample durations in the media timescale and they
 * add up to the real length — which is why Chromium itself reads these files correctly while a
 * system player shows a number that does not match what it plays.
 *
 * So the value that is known for certain is the one the recorder itself kept: from the moment it
 * started to the moment it stopped. That is what every duration field is set to, in the timescale
 * each one declares. Nothing is re-encoded and no box moves — only the duration fields of the
 * header that is already on disk are rewritten, in place, which is why this is safe to run on a
 * file whose last chunks may still be arriving (`TabRecorder` appends; the header does not move).
 *
 * A file it cannot parse is left exactly as it was: a recording that plays is worth more than a
 * header this did not understand.
 */

import { closeSync, fstatSync, openSync, readSync, writeSync } from 'node:fs'

/**
 * How much of the front of the file to look through for `moov`.
 *
 * A live/fragmented mp4 puts `moov` before the media data (measured: every recording this app
 * makes), and it is a few hundred bytes of track headers — so this is already far more than the
 * box can be, and it stops a long recording from being read into memory to find it.
 */
const HEADER_PREFIX_BYTES = 4 * 1024 * 1024

/** One box in the file, with the offsets the fields below are measured from. */
interface Box {
  type: string
  /** Absolute file offset of the box's first byte. */
  start: number
  /** Absolute file offset just past the box. */
  end: number
  /** Absolute file offset of the body, i.e. past the size+type (and 64-bit size) header. */
  bodyStart: number
}

/** The boxes that start inside `[from, to)`, in the order they appear. */
function boxesIn(buffer: Buffer, from: number, to: number): Box[] {
  const boxes: Box[] = []
  let at = from
  while (at + 8 <= to) {
    const size32 = buffer.readUInt32BE(at)
    const type = buffer.toString('latin1', at + 4, at + 8)
    let header = 8
    let size = size32
    if (size32 === 1) {
      // 64-bit size — `largesize` follows the type.
      if (at + 16 > to) break
      size = Number(buffer.readBigUInt64BE(at + 8))
      header = 16
    } else if (size32 === 0) {
      // "To the end of the file" — only meaningful for the last box, which is never one of these.
      size = to - at
    }
    if (size < header || at + size > to) break
    boxes.push({ type, start: at, end: at + size, bodyStart: at + header })
    at += size
  }
  return boxes
}

const firstOf = (boxes: Box[], type: string): Box | undefined => boxes.find((box) => box.type === type)

/** A field to overwrite, and the value it takes. */
interface Patch {
  at: number
  value: number
  size: 4 | 8
}

/**
 * The timescale a full box declares, and a duration field for it.
 *
 * Version 0 keeps both as 32-bit; version 1 widens the times to 64-bit, which moves the two
 * fields this cares about 8 bytes further in. Nothing else about them differs.
 */
function readTimescale(buffer: Buffer, box: Box): number {
  const version = buffer.readUInt8(box.bodyStart)
  return buffer.readUInt32BE(box.bodyStart + (version === 1 ? 20 : 12))
}

function durationField(buffer: Buffer, box: Box): { at: number; size: 4 | 8 } {
  const version = buffer.readUInt8(box.bodyStart)
  // `tkhd` is the odd one: where `mvhd` and `mdhd` go creation/modification/timescale/duration,
  // it has a track ID and a reserved pair in the timescale's place, so its duration is two
  // fields further in — 4 bytes more in either version.
  const large = version === 1
  const offset = box.type === 'tkhd' ? (large ? 28 : 20) : large ? 24 : 16
  return { at: box.bodyStart + offset, size: large ? 8 : 4 }
}

/** What `durationMs` is, in a timescale's own ticks. */
function ticks(durationMs: number, timescale: number): number {
  return Math.max(0, Math.round((durationMs * timescale) / 1000))
}

/**
 * Set every duration field in `filePath` to `durationMs`, and answer whether anything was written.
 *
 * `durationMs` is the recording's own elapsed time — what the recorder measured, not what the
 * muxer guessed.
 */
export function settleMp4Duration(filePath: string, durationMs: number): boolean {
  if (!(durationMs > 0)) return false

  let fd: number
  try {
    fd = openSync(filePath, 'r+')
  } catch {
    return false
  }

  try {
    const size = fstatSync(fd).size
    const prefixBytes = Math.min(size, HEADER_PREFIX_BYTES)
    const prefix = Buffer.alloc(prefixBytes)
    const read = readSync(fd, prefix, 0, prefixBytes, 0)
    const header = prefix.subarray(0, read)

    const moov = firstOf(boxesIn(header, 0, read), 'moov')
    if (!moov) return false
    const inMoov = boxesIn(header, moov.bodyStart, moov.end)

    const patches: Patch[] = []

    const mvhd = firstOf(inMoov, 'mvhd')
    if (mvhd) {
      const at = durationField(header, mvhd)
      patches.push({ at: at.at, value: ticks(durationMs, readTimescale(header, mvhd)), size: at.size })
    }

    for (const trak of inMoov.filter((box) => box.type === 'trak')) {
      const inTrak = boxesIn(header, trak.bodyStart, trak.end)

      const tkhd = firstOf(inTrak, 'tkhd')
      // A track's duration is in the **movie** timescale, so it follows `mvhd`, not its own media.
      if (tkhd && mvhd) {
        const at = durationField(header, tkhd)
        patches.push({ at: at.at, value: ticks(durationMs, readTimescale(header, mvhd)), size: at.size })
      }

      const mdia = firstOf(inTrak, 'mdia')
      const mdhd = mdia ? firstOf(boxesIn(header, mdia.bodyStart, mdia.end), 'mdhd') : undefined
      if (mdhd) {
        const at = durationField(header, mdhd)
        patches.push({ at: at.at, value: ticks(durationMs, readTimescale(header, mdhd)), size: at.size })
      }
    }

    if (patches.length === 0) return false

    for (const patch of patches) {
      const bytes = Buffer.alloc(patch.size)
      if (patch.size === 4) bytes.writeUInt32BE(Math.min(patch.value, 0xffffffff), 0)
      else bytes.writeBigUInt64BE(BigInt(patch.value), 0)
      writeSync(fd, bytes, 0, patch.size, patch.at)
    }
    return true
  } catch {
    // A header this did not understand is not a recording that needs rescuing: leave the file
    // exactly as the muxer wrote it.
    return false
  } finally {
    closeSync(fd)
  }
}

/**
 * The same fields, read back — for tests, and for anyone asking what a file now declares.
 *
 * `undefined` for a field a box does not have, so "this file has no `mdhd`" is not reported as
 * "zero seconds".
 */
export interface Mp4DeclaredDurations {
  movie: number | null
  track: number | null
  media: number | null
}

export function readMp4DeclaredDurations(filePath: string): Mp4DeclaredDurations {
  const declared: Mp4DeclaredDurations = { movie: null, track: null, media: null }

  let fd: number
  try {
    fd = openSync(filePath, 'r')
  } catch {
    return declared
  }

  try {
    const size = fstatSync(fd).size
    const prefixBytes = Math.min(size, HEADER_PREFIX_BYTES)
    const prefix = Buffer.alloc(prefixBytes)
    const read = readSync(fd, prefix, 0, prefixBytes, 0)
    const header = prefix.subarray(0, read)

    const value = (box: Box): number => {
      const version = header.readUInt8(box.bodyStart)
      const ts = readTimescale(header, box)
      const at = durationField(header, box)
      const raw = at.size === 8 ? Number(header.readBigUInt64BE(at.at)) : header.readUInt32BE(at.at)
      return ts > 0 ? raw / ts : 0
    }

    const moov = firstOf(boxesIn(header, 0, read), 'moov')
    if (!moov) return declared
    const inMoov = boxesIn(header, moov.bodyStart, moov.end)

    const mvhd = firstOf(inMoov, 'mvhd')
    if (mvhd) declared.movie = value(mvhd)

    const trak = firstOf(inMoov, 'trak')
    if (trak) {
      const inTrak = boxesIn(header, trak.bodyStart, trak.end)
      const tkhd = firstOf(inTrak, 'tkhd')
      // `tkhd` states its duration in the movie timescale, which is `mvhd`'s, not its own field.
      if (tkhd && mvhd) {
        const at = durationField(header, tkhd)
        const raw = at.size === 8 ? Number(header.readBigUInt64BE(at.at)) : header.readUInt32BE(at.at)
        const movieTs = readTimescale(header, mvhd)
        declared.track = movieTs > 0 ? raw / movieTs : 0
      }
      const mdia = firstOf(inTrak, 'mdia')
      const mdhd = mdia ? firstOf(boxesIn(header, mdia.bodyStart, mdia.end), 'mdhd') : undefined
      if (mdhd) declared.media = value(mdhd)
    }
  } catch {
    return declared
  } finally {
    closeSync(fd)
  }

  return declared
}
