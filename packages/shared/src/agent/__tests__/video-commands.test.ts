/**
 * Tests for `video_tool`'s command line.
 *
 * The door itself is covered in `tool-commands.test.ts`; what is checked here is the reading of
 * the command — the path resolution, the flag parsing, the defaults — and the exact wording of
 * what the command reports back.
 */

import { resolve } from 'node:path'
import { describe, it, expect } from 'bun:test'
import { buildUnderstandPrompt, executeVideoToolCommand, frameFileName, getVideoToolHelp } from '../video-commands'
import { IMAGE_LIMITS } from '../../utils/files'
import type { BrowserPaneFns } from '../browser-pane'
import type { LLMQueryRequest, LLMQueryResult } from '../llm-tool'

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

async function run(
  command: string | string[],
  fns: BrowserPaneFns,
  queryLlm?: (request: LLMQueryRequest) => Promise<LLMQueryResult>,
) {
  return executeVideoToolCommand({
    command,
    fns,
    sessionId: 'test-session',
    workspaceRootPath: WORKSPACE,
    queryLlm,
  })
}

describe('video_tool command line', () => {
  it('answers --help with the one command and its flags', async () => {
    const help = getVideoToolHelp()
    expect(help).toContain('video_tool command help')
    expect(help).toContain('sample <path> [--out <dir>] [--every <dur>] [--changes] [--threshold <r>] [--from <dur>] [--to <dur>] [--first] [--last] [--max-edge <n>] [--max <n>]')

    const result = await run('--help', stubFns(async () => ({ durationMs: 0, truncated: false, frames: [] })))
    expect(result.output).toBe(help)
    // No capture is touched for help: nothing to release.
    expect(result.appendReleaseHint).toBe(false)
  })

  it('passes --threshold through, and refuses one that is not a ratio', async () => {
    const seen: Array<number | undefined> = []
    const fns = stubFns(async (args: any) => {
      seen.push(args.changeThreshold)
      return { durationMs: 0, truncated: false, frames: [] }
    })

    await run('sample demo.mp4 --changes --threshold 0.05', fns)
    expect(seen).toEqual([0.05])

    // Omitted is the sampler's own default, not zero.
    await run('sample demo.mp4 --changes', fns)
    expect(seen[1]).toBeUndefined()

    // Smaller keeps more, so the scale *is* the answer: out of range is refused rather than
    // quietly becoming the default, which would reply to a different question.
    await expect(run('sample demo.mp4 --changes --threshold 5', fns)).rejects.toThrow('(0, 1]')
    await expect(run('sample demo.mp4 --changes --threshold soon', fns)).rejects.toThrow('(0, 1]')
  })

  it('passes the window, the two ends and the scale through', async () => {
    const seen: Array<Record<string, unknown>> = []
    const fns = stubFns(async (args: any) => {
      seen.push(args)
      return { durationMs: 0, truncated: false, frames: [] }
    })

    await run('sample demo.mp4 --from 12s --to 13s --max-edge 720 --first --last', fns)
    expect(seen[0]).toMatchObject({ fromMs: 12_000, toMs: 13_000, maxEdge: 720, first: true, last: true })

    // `--to` absent has to *stay* absent: it means "to the end", which no number can express.
    // `--from 0` and no `--from` are the same thing, so a plain 0 is right there.
    await run('sample demo.mp4', fns)
    expect(seen[1]!.toMs).toBeUndefined()
    expect(seen[1]!.fromMs).toBe(0)
    expect(seen[1]!.first).toBe(false)
    expect(seen[1]!.last).toBe(false)
    expect(seen[1]!.maxEdge).toBe(0)

    // Out of range is clamped, not refused — the same way `--max` behaves, and the ceiling is
    // the one the format's own scale parameter uses.
    await run('sample demo.mp4 --max-edge 99999', fns)
    expect(seen[2]!.maxEdge).toBe(4096)
  })

  it('gives "understand" a legible default edge, and leaves a stated one alone', async () => {
    const seen: Array<Record<string, unknown>> = []
    const fns = stubFns(async (args: any) => {
      seen.push(args)
      return { durationMs: 0, truncated: false, frames: [{ offsetMs: 0, bytes: new Uint8Array([1]), path: null }] }
    })
    const ask = async () => ({ text: 'read' })

    await run('understand demo.mp4 --prompt "what happened?"', fns, ask)
    await run('understand demo.mp4 --prompt "what happened?" --max-edge 640', fns, ask)
    // `0` is a stated answer too — "no scaling" — not a way of asking for the default back.
    await run('understand demo.mp4 --prompt "what happened?" --max-edge 0', fns, ask)

    expect(seen[0]!.maxEdge).toBe(IMAGE_LIMITS.OPTIMAL_EDGE)
    expect(seen[1]!.maxEdge).toBe(640)
    expect(seen[2]!.maxEdge).toBe(0)
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

  it('samples on a timeline every 1000 ms, at most 1000 frames, by default', async () => {
    const seen: Array<Record<string, unknown>> = []
    const fns = stubFns(async (args) => {
      seen.push(args)
      return { durationMs: 6000, truncated: false, frames: frames(3) }
    })

    await run('sample demo.mp4', fns)

    expect(seen[0]).toMatchObject({ mode: 'timeline', everyMs: 1000, maxFrames: 1000 })
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

    // The two that name no interval take the default: one second.
    expect(seen.map((args) => args.everyMs)).toEqual([500, 2000, 1000, 1000])
    expect(seen[3]!.maxFrames).toBe(1000)
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

  it('says so when the ceiling came before the end of the range', async () => {
    const fns = stubFns(async () => ({ durationMs: 600_000, truncated: true, frames: frames(40) }))

    const result = await run('sample demo.mp4', fns)

    expect(result.output).toContain('Sampled 40 frames')
    expect(result.output).toContain('More moments moved here than the ceiling holds')
  })

  it('says when the frames came out further apart than the interval asked for', async () => {
    // What the sampler does when the ceiling cannot hold the recording at the detail asked for: the
    // same number of frames spread across the whole span — never the start of it and nothing after.
    const framesAt = (offsets: number[]) =>
      offsets.map((offsetMs) => ({ offsetMs, bytes: new Uint8Array([1]), path: null }))
    const fns = stubFns(async () => ({ durationMs: 600_000, truncated: false, frames: framesAt([0, 15_000, 30_000]) }))

    const widened = await run('sample demo.mp4', fns)

    expect(widened.output).toContain('One frame every 15s rather than the 1s asked for')
    // Widened, not cut short: the whole recording was looked at.
    expect(widened.output).not.toContain('was not examined')

    // And says nothing at all when the spacing is the one that was asked for.
    const exact = stubFns(async () => ({ durationMs: 4_000, truncated: false, frames: framesAt([0, 1_000, 2_000]) }))
    expect((await run('sample demo.mp4', exact)).output).not.toContain('rather than the')
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
      'Chromium reads mp4 (H.264), webm and most mov files. HEVC reads only where the machine ' +
      'has a hardware decoder for it, and ProRes does not read at all — a file that will not open ' +
      'has to be converted first.'
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

describe('video_tool understand', () => {
  /** A model that records what it was asked, and answers. */
  function stubQuery(answer = 'The user clicked Save at 4s.') {
    const seen: LLMQueryRequest[] = []
    const fn = async (request: LLMQueryRequest): Promise<LLMQueryResult> => {
      seen.push(request)
      return { text: answer }
    }
    return { fn, seen }
  }

  it('pairs every frame with its moment, and asks the question last', () => {
    const prompt = buildUnderstandPrompt('What happened?', [0, 2000, 4000], 6500)

    expect(prompt).toContain('A screen recording, 7s long, is attached as 3 frames, in order.')
    expect(prompt).toContain('attached as 3 frames, in order')
    expect(prompt).toContain('taken at: +0ms, +2000ms, +4000ms')
    expect(prompt.trimEnd().endsWith('What happened?')).toBe(true)
  })

  it('sends the frames to the model with their offsets, and answers with what it said', async () => {
    const { fn, seen } = stubQuery()
    const fns = stubFns(async () => ({ durationMs: 6500, truncated: false, frames: frames(3) }))

    const result = await run('understand demo.mp4 --prompt "What happened?"', fns, fn)

    expect(seen.length).toBe(1)
    expect(seen[0]!.images?.map((image) => image.timestampMs)).toEqual([0, 2000, 4000])
    expect(seen[0]!.images?.every((image) => image.mimeType === 'image/jpeg')).toBe(true)
    expect(seen[0]!.images?.[0]!.data).toBe(Buffer.from(new Uint8Array([1])).toString('base64'))
    expect(seen[0]!.prompt).toContain('taken at: +0ms, +2000ms, +4000ms')

    expect(result.output).toContain('The user clicked Save at 4s.')
    expect(result.output).toContain('Read demo.mp4 (7s, 3 frames)')
    expect(result.output).toContain('Frames at: +0ms, +2000ms, +4000ms')
    // The reading is the answer: the pictures stay out of the reply.
    expect(result.images).toBeUndefined()
  })

  it('gives the sampler the same flags sample takes', async () => {
    const { fn } = stubQuery()
    let received: Record<string, unknown> | undefined
    const fns = stubFns(async (args) => {
      received = args
      return { durationMs: 6000, truncated: false, frames: frames(2) }
    })

    await run('understand demo.mp4 --prompt "q" --changes --max 5 --every 500ms', fns, fn)

    expect(received).toMatchObject({ mode: 'changes', maxFrames: 5, everyMs: 500 })
    expect(received!.path).toBe(resolve(WORKSPACE, 'demo.mp4'))
  })

  it('reads a recording a second at a time unless told otherwise', async () => {
    const { fn } = stubQuery()
    const seen: Array<Record<string, unknown>> = []
    const fns = stubFns(async (args) => {
      seen.push(args)
      return { durationMs: 60_000, truncated: false, frames: frames(2) }
    })

    await run('understand demo.mp4 --prompt "q"', fns, fn)
    await run('understand demo.mp4 --prompt "q" --every 5s', fns, fn)

    // A question is usually about a moment, which a coarser grid can put between two frames.
    expect(seen[0]!.everyMs).toBe(1000)
    // And asking for a grid still wins over the default.
    expect(seen[1]!.everyMs).toBe(5000)
  })

  it('names the model when one is asked for', async () => {
    const { fn, seen } = stubQuery()
    const fns = stubFns(async () => ({ durationMs: 2000, truncated: false, frames: frames(1) }))

    await run('understand demo.mp4 --prompt "q" --model haiku', fns, fn)

    expect(seen[0]!.model).toBe('haiku')
  })

  it('refuses without a question', async () => {
    const { fn } = stubQuery()
    const fns = stubFns(async () => ({ durationMs: 2000, truncated: false, frames: frames(1) }))

    await expect(run('understand demo.mp4', fns, fn)).rejects.toThrow('What should be asked about it?')
    await expect(run('understand demo.mp4 --prompt', fns, fn)).rejects.toThrow('--prompt needs the question')
    await expect(run('understand --prompt "q"', fns, fn)).rejects.toThrow('Which recording?')
  })

  it('refuses --model without a model id', async () => {
    const { fn } = stubQuery()
    const fns = stubFns(async () => ({ durationMs: 2000, truncated: false, frames: frames(1) }))

    await expect(run('understand demo.mp4 --prompt "q" --model', fns, fn)).rejects.toThrow('--model needs a model id')
  })

  it('says so — and points at sample — when the conversation has no model', async () => {
    const fns = stubFns(async () => ({ durationMs: 2000, truncated: false, frames: frames(1) }))

    const message = await run('understand demo.mp4 --prompt "q"', fns).catch((err) => (err as Error).message)

    expect(message).toContain('No model is configured')
    expect(message).toContain('"sample" still works')
  })

  it('resolves --out, names the files, and still answers', async () => {
    const { fn } = stubQuery('Two steps.')
    const fns = stubFns(async () => ({ durationMs: 4000, truncated: false, frames: frames(2, true) }))

    const result = await run('understand demo.mp4 --prompt "q" --out frames/demo', fns, fn)

    expect(result.output).toContain('into frames/demo')
    expect(result.output).toContain('• frame-0001.jpg  @ 0ms')
    expect(result.output).toContain('Two steps.')
    expect(result.output).not.toContain('no files written')
  })

  it('says when the ceiling came before the end, and carries a partial answer through', async () => {
    const { fn } = stubQuery('')
    const fns = stubFns(async () => ({ durationMs: 600_000, truncated: true, frames: frames(40) }))

    const result = await run('understand demo.mp4 --prompt "q"', fns, fn)

    expect(result.output).toContain('More moments moved here than the ceiling holds')
    expect(result.output).toContain('(the model returned nothing)')
  })

  it('refuses a recording that decoded to nothing', async () => {
    const { fn } = stubQuery()
    const fns = stubFns(async () => ({ durationMs: 0, truncated: false, frames: [] }))

    await expect(run('understand demo.mp4 --prompt "q"', fns, fn)).rejects.toThrow('nothing to read')
  })
})
