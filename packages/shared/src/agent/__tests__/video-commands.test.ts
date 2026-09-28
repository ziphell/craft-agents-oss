/**
 * Tests for `video_tool`'s command line.
 *
 * The door itself is covered in `tool-commands.test.ts`; what is checked here is the reading of
 * the command — the path resolution, the flag parsing, the defaults — and the exact wording of
 * what the command reports back.
 */

import { resolve } from 'node:path'
import { describe, it, expect } from 'bun:test'
import { executeVideoToolCommand, frameFileName, getVideoToolHelp } from '../video-commands'
import type { BrowserPaneFns } from '../browser-pane'

const WORKSPACE = '/tmp/video-workspace'

/** Only `sampleVideo` is reached by this door's commands, so the rest of the surface is absent. */
function stubFns(sampleVideo: BrowserPaneFns['sampleVideo']): BrowserPaneFns {
  return { sampleVideo } as unknown as BrowserPaneFns
}

function frames(count: number, withPaths = false) {
  return Array.from({ length: count }, (_unused, i) => ({
    offsetMs: i * 2000,
    bytes: new Uint8Array([i + 1]),
    path: withPaths ? `/tmp/video-out/frame-${String(i + 1).padStart(4, '0')}.jpg` : null,
  }))
}

async function run(command: string | string[], fns: BrowserPaneFns) {
  return executeVideoToolCommand({
    command,
    fns,
    sessionId: 'test-session',
    workspaceRootPath: WORKSPACE,
  })
}

describe('video_tool command line', () => {
  it('answers --help with the one command and its flags', async () => {
    const help = getVideoToolHelp()
    expect(help).toContain('video_tool command help')
    expect(help).toContain('sample <path> [--out <dir>] [--every <dur>] [--changes] [--max <n>]')

    const result = await run('--help', stubFns(async () => ({ durationMs: 0, truncated: false, frames: [] })))
    expect(result.output).toBe(help)
    // No capture is touched for help: nothing to release.
    expect(result.appendReleaseHint).toBe(false)
  })

  it('refuses an empty command', async () => {
    await expect(run('   ', stubFns(async () => ({ durationMs: 0, truncated: false, frames: [] }))))
      .rejects.toThrow('Missing command')
  })

  it('refuses a sample with no recording', async () => {
    const fns = stubFns(async () => ({ durationMs: 0, truncated: false, frames: [] }))
    await expect(run('sample', fns)).rejects.toThrow('Which recording?')
    await expect(run('sample --out frames', fns)).rejects.toThrow('Which recording?')
  })

  it('refuses --out without a directory', async () => {
    const fns = stubFns(async () => ({ durationMs: 0, truncated: false, frames: [] }))
    await expect(run('sample demo.mp4 --out', fns)).rejects.toThrow('--out needs a directory')
  })

  it('refuses a command that is not its own, naming only the door a browser command belongs to', async () => {
    const fns = stubFns(async () => ({ durationMs: 0, truncated: false, frames: [] }))
    const message = await run('status', fns).catch((err) => (err as Error).message)

    expect(message).toContain('Unknown video_tool command "status"')
    expect(message).toContain("browser_tool's")
    // Reading a recording is nobody else's business, so no other tool's name is borrowed here.
    expect(message).not.toContain('prototype')
  })

  it('samples on a timeline every 2000 ms, at most 40 frames, by default', async () => {
    const seen: Array<Record<string, unknown>> = []
    const fns = stubFns(async (args) => {
      seen.push(args)
      return { durationMs: 6000, truncated: false, frames: frames(3) }
    })

    await run('sample demo.mp4', fns)

    expect(seen[0]).toMatchObject({ mode: 'timeline', everyMs: 2000, maxFrames: 40 })
    expect(seen[0]!.path).toBe(resolve(WORKSPACE, 'demo.mp4'))
    expect(seen[0]!.out).toBeUndefined()
  })

  it('reads --every in ms/s/m and clamps it, and --max within bounds', async () => {
    const seen: Array<Record<string, unknown>> = []
    const fns = stubFns(async (args) => {
      seen.push(args)
      return { durationMs: 6000, truncated: false, frames: frames(1) }
    })

    await run('sample demo.mp4 --every 500ms', fns)
    await run('sample demo.mp4 --every 2s', fns)
    await run('sample demo.mp4 --every nonsense', fns)
    await run('sample demo.mp4 --max 100000', fns)

    expect(seen.map((args) => args.everyMs)).toEqual([500, 2000, 2000, 2000])
    expect(seen[3]!.maxFrames).toBe(400)
  })

  it('switches to `changes` mode with --changes', async () => {
    let receivedMode: string | undefined
    const fns = stubFns(async ({ mode }) => {
      receivedMode = mode
      return { durationMs: 6000, truncated: false, frames: frames(1) }
    })

    await run('sample demo.mp4 --changes', fns)

    expect(receivedMode).toBe('changes')
  })

  it('resolves a relative --out from the workspace root', async () => {
    let receivedOut: string | undefined
    const fns = stubFns(async ({ out }) => {
      receivedOut = out
      return { durationMs: 6000, truncated: false, frames: frames(1, true) }
    })

    await run('sample demo.mp4 --out frames/demo', fns)

    expect(receivedOut).toBe(resolve(WORKSPACE, 'frames/demo'))
  })

  it('reports duration, every offset, and that nothing was written when no --out is given', async () => {
    const fns = stubFns(async () => ({ durationMs: 6500, truncated: false, frames: frames(3) }))

    const result = await run('sample demo.mp4', fns)

    expect(result.output).toContain('Sampled 3 frames out of demo.mp4 (7s long) — no files written:')
    expect(result.output).toContain('• frame-0001.jpg  @ 0ms')
    expect(result.output).toContain('• frame-0002.jpg  @ 2000ms')
    expect(result.output).toContain('• frame-0003.jpg  @ 4000ms')
    expect(result.output).toContain('Nothing was written to disk')
    expect(result.output).toContain('--out <dir>')
    // Nothing was written, so no frame carries a file.
    expect(result.images?.every((image) => image.path === undefined)).toBe(true)
  })

  it('names the output directory and every frame file when --out is given', async () => {
    const fns = stubFns(async () => ({ durationMs: 4000, truncated: false, frames: frames(2, true) }))

    const result = await run('sample demo.mp4 --out frames/demo', fns)

    expect(result.output).toContain('Sampled 2 frames out of demo.mp4 (4s long) into frames/demo, as:')
    expect(result.output).toContain('• frame-0001.jpg  @ 0ms')
    expect(result.output).not.toContain('Nothing was written to disk')
    // The files travel with the images, which is how a door shows them from disk.
    expect(result.images?.map((image) => image.path)).toEqual([
      '/tmp/video-out/frame-0001.jpg',
      '/tmp/video-out/frame-0002.jpg',
    ])
  })

  it('says the sample hit its ceiling when it was truncated', async () => {
    const fns = stubFns(async () => ({ durationMs: 600_000, truncated: true, frames: frames(40) }))

    const result = await run('sample demo.mp4', fns)

    expect(result.output).toContain('Sampled 40 frames')
    expect(result.output).toContain('hit its frame ceiling')
  })

  it('hands every frame back as a JPEG image', async () => {
    const fns = stubFns(async () => ({ durationMs: 4000, truncated: false, frames: frames(2) }))

    const result = await run('sample demo.mp4', fns)

    expect(result.images?.length).toBe(2)
    expect(result.images?.[0]).toMatchObject({ mimeType: 'image/jpeg', sizeBytes: 1 })
    expect(result.images?.[0]!.data).toBe(Buffer.from(new Uint8Array([1])).toString('base64'))
  })

  it('lets a decode failure through unchanged', async () => {
    const message =
      'Could not read the recording: this browser cannot decode the recording (media error 4). ' +
      'Chromium decodes mp4 (H.264), webm and most mov files; a HEVC, ProRes or otherwise ' +
      'unsupported recording has to be converted first.'
    const fns = stubFns(async () => { throw new Error(message) })

    await expect(run('sample demo.mov', fns)).rejects.toThrow(message)
  })

  it('takes the same command in array mode', async () => {
    let received: Record<string, unknown> | undefined
    const fns = stubFns(async (args) => {
      received = args
      return { durationMs: 2000, truncated: false, frames: frames(1) }
    })

    await run(['sample', 'demo.mp4', '--changes', '--max', '5'], fns)

    expect(received).toMatchObject({ mode: 'changes', maxFrames: 5 })
  })

  it('names frames the way the files are named', () => {
    expect(frameFileName(1)).toBe('frame-0001.jpg')
    expect(frameFileName(12)).toBe('frame-0012.jpg')
  })
})
