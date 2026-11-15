import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRecordingCliFns } from '../cli-fns.ts'

let root = ''
let recording = ''

/**
 * A stand-in for `craft-headless-export`: the same flags, the same envelope, two frames.
 *
 * The real launcher needs a Chromium; this test is about the seam around it — where the frames
 * land, which paths come back, and what a refusal says.
 */
const FAKE_CLI = `
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const out = argv[argv.indexOf('--out') + 1]

if (argv.includes('--fail')) {
  process.stdout.write(JSON.stringify({ command: 'video', status: 'error', error: 'video_failed', message: 'this browser cannot decode the recording' }) + '\\n')
  process.exit(1)
}

if (argv.includes('--probe-video')) {
  process.stdout.write(JSON.stringify({ command: 'video', status: 'ok', duration_ms: 4000, width: 640, height: 360, truncated: false, frames: [] }) + '\\n')
  process.exit(0)
}

const frames = [1, 2].map((index) => {
  const path = join(out, 'frame-000' + index + '.jpg')
  writeFileSync(path, Buffer.from([index, index, index]))
  return { offset_ms: index * 1000, path }
})
process.stdout.write(JSON.stringify({ command: 'video', status: 'ok', duration_ms: 4000, width: 640, height: 360, truncated: false, frames }) + '\\n')
`

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'craft-video-cli-'))
  recording = join(root, 'demo.mp4')
  writeFileSync(recording, 'not really a recording')
  writeFileSync(join(root, 'fake-cli.mjs'), FAKE_CLI)
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

const fns = () =>
  createRecordingCliFns({ command: process.execPath, prefixArgs: [join(root, 'fake-cli.mjs')], timeoutMs: 10_000 })

describe('the CLI decoder', () => {
  it('answers a probe with the header and writes nothing', async () => {
    const result = await fns().sampleVideo({
      path: recording,
      probeOnly: true,
      mode: 'timeline',
      everyMs: 1_000,
      maxFrames: 1,
    })

    expect(result.durationMs).toBe(4000)
    expect(result.viewport).toEqual({ width: 640, height: 360 })
    expect(result.frames).toEqual([])
  })

  it('hands back the frames as bytes when the caller asked for no files', async () => {
    const result = await fns().sampleVideo({
      path: recording,
      mode: 'timeline',
      everyMs: 1_000,
      maxFrames: 10,
    })

    expect(result.frames.map((frame) => frame.offsetMs)).toEqual([1000, 2000])
    expect(Array.from(result.frames[0]!.bytes)).toEqual([1, 1, 1])
    // No `--out`: the paths belonged to a scratch directory this call has already removed.
    expect(result.frames.every((frame) => frame.path === null)).toBe(true)
  })

  it('keeps the files when the caller named a directory', async () => {
    const out = join(root, 'frames')
    const result = await fns().sampleVideo({
      path: recording,
      mode: 'timeline',
      everyMs: 1_000,
      maxFrames: 10,
      out,
    })

    expect(result.frames.map((frame) => frame.path)).toEqual([
      join(out, 'frame-0001.jpg'),
      join(out, 'frame-0002.jpg'),
    ])
    expect(readdirSync(out).sort()).toEqual(['frame-0001.jpg', 'frame-0002.jpg'])
    expect(existsSync(result.frames[0]!.path!)).toBe(true)
  })

  it('says what the decoder said instead of inventing a result', async () => {
    const failing = createRecordingCliFns({
      command: process.execPath,
      prefixArgs: [join(root, 'fake-cli.mjs'), '--fail'],
      timeoutMs: 10_000,
    })

    await expect(
      failing.sampleVideo({ path: recording, mode: 'timeline', everyMs: 1_000, maxFrames: 1 }),
    ).rejects.toThrow('this browser cannot decode the recording')
  })

  it('refuses a recording that is not there, without starting a process', async () => {
    await expect(
      fns().sampleVideo({ path: join(root, 'missing.mp4'), mode: 'timeline', everyMs: 1_000, maxFrames: 1 }),
    ).rejects.toThrow('No recording at')
  })
})
