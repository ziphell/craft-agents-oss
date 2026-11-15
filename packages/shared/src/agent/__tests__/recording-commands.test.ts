/**
 * Tests for `recording_tool`'s command line.
 *
 * The door itself is covered in `tool-commands.test.ts`; what is checked here is the reading of
 * the command — the path resolution, the flag parsing, the defaults — and the exact wording of
 * what the command reports back.
 */

import { resolve, join } from 'node:path'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { describe, it, expect } from 'bun:test'
import {
  durationText,
  executeRecordingToolCommand,
  frameFileName,
  getRecordingToolHelp,
} from '../recording-commands'
import { chooseUnderstandStrategy, understandRecording } from '../understand-recording'
import type { BrowserPaneFns } from '../browser-pane'
import type { OmniModelRequest } from '../../media/workspace-model'

const WORKSPACE = '/tmp/video-workspace'

/** Only the decoder calls this door makes are stubbed; everything else is absent on purpose. */
function stubFns(
  sampleVideo: BrowserPaneFns['sampleVideo'],
  extractAudio: BrowserPaneFns['extractAudio'] = async () => {
    throw new Error('no audio decoder in this stub')
  },
): BrowserPaneFns {
  return { sampleVideo, extractAudio } as unknown as BrowserPaneFns
}

function frames(count: number, withPaths = false) {
  return Array.from({ length: count }, (_unused, i) => ({
    offsetMs: i * 2000,
    bytes: new Uint8Array([i + 1]),
    path: withPaths ? `/tmp/video-out/frame-${String(i + 1).padStart(4, '0')}.jpg` : null,
  }))
}

async function run(command: string | string[], fns: BrowserPaneFns) {
  return executeRecordingToolCommand({
    command,
    fns,
    sessionId: 'test-session',
    // Relative paths anchor to the conversation's content root, which here is its working folder.
    sessionWorkingDirectory: WORKSPACE,
  })
}

describe('recording_tool commands', () => {
  it('answers --help with both commands and their flags', async () => {
    const help = getRecordingToolHelp()
    expect(help).toContain('recording_tool — a recording on this machine')
    expect(help).toContain('probe <path>')
    expect(help).toContain('frames <path> [--out <dir>] [--every <dur>] [--changes] [--threshold <r>] [--from <dur>] [--to <dur>] [--first] [--last] [--max-edge <n>] [--max <n>]')
    expect(help).toContain('audio <path> --out <file> [--format wav|mp3] [--bitrate <kbps>]')

    const result = await run('--help', stubFns(async () => ({ durationMs: 0, truncated: false, frames: [] })))
    expect(result.output).toBe(help)
    // No capture is touched for help: nothing to release.
    expect(result.appendReleaseHint).toBe(false)
  })

  it('probes the header only: length and picture size, no frames', async () => {
    const seen: Array<Record<string, unknown>> = []
    const fns = stubFns(async (args) => {
      seen.push(args)
      return {
        durationMs: 65_000,
        viewport: { width: 1920, height: 1080 },
        truncated: false,
        frames: [],
      }
    })

    const result = await run('probe demo.mp4', fns)

    expect(seen[0]).toMatchObject({ probeOnly: true, mode: 'timeline', maxFrames: 1 })
    expect(seen[0]!.path).toBe(resolve(WORKSPACE, 'demo.mp4'))
    expect(seen[0]!.out).toBeUndefined()
    expect(result.output).toContain('demo.mp4 — 1m 5s (65000 ms), 1920x1080.')
  })

  it('anchors a relative path to the session folder when the conversation is in no project', async () => {
    const seen: string[] = []
    const fns = stubFns(async ({ path }) => {
      seen.push(path)
      return { durationMs: 1, viewport: null, truncated: false, frames: [] }
    })

    await executeRecordingToolCommand({
      command: 'probe assets/demo.mp4',
      fns,
      sessionId: 's-9',
      workspaceRootPath: '/tmp/ws',
    })
    await executeRecordingToolCommand({
      command: 'probe session:assets/demo.mp4',
      fns,
      sessionId: 's-9',
      workspaceRootPath: '/tmp/ws',
    })

    const expected = resolve('/tmp/ws', 'sessions', 's-9', 'assets', 'demo.mp4')
    expect(seen).toEqual([expected, expected])
  })

  it('says when the decoder reported no picture size', async () => {
    const fns = stubFns(async () => ({ durationMs: 500, viewport: null, truncated: false, frames: [] }))

    const result = await run('probe demo.webm', fns)

    expect(result.output).toContain('500 ms')
    expect(result.output).toContain('picture size not reported')
  })

  it('refuses a probe with no recording', async () => {
    const fns = stubFns(async () => ({ durationMs: 0, truncated: false, frames: [] }))
    await expect(run('probe', fns)).rejects.toThrow('Which recording?')
    await expect(run('probe --out dir', fns)).rejects.toThrow('Which recording?')
  })

  it('passes --threshold through, and refuses one that is not a ratio', async () => {
    const seen: Array<number | undefined> = []
    const fns = stubFns(async (args: any) => {
      seen.push(args.changeThreshold)
      return { durationMs: 0, truncated: false, frames: [] }
    })

    await run('frames demo.mp4 --changes --threshold 0.05', fns)
    expect(seen).toEqual([0.05])

    // Omitted is the sampler's own default, not zero.
    await run('frames demo.mp4 --changes', fns)
    expect(seen[1]).toBeUndefined()

    // Smaller keeps more, so the scale *is* the answer: out of range is refused rather than
    // quietly becoming the default, which would reply to a different question.
    await expect(run('frames demo.mp4 --changes --threshold 5', fns)).rejects.toThrow('(0, 1]')
    await expect(run('frames demo.mp4 --changes --threshold soon', fns)).rejects.toThrow('(0, 1]')
  })

  it('passes the window, the two ends and the scale through', async () => {
    const seen: Array<Record<string, unknown>> = []
    const fns = stubFns(async (args: any) => {
      seen.push(args)
      return { durationMs: 0, truncated: false, frames: [] }
    })

    await run('frames demo.mp4 --from 12s --to 13s --max-edge 720 --first --last', fns)
    expect(seen[0]).toMatchObject({ fromMs: 12_000, toMs: 13_000, maxEdge: 720, first: true, last: true })

    // `--to` absent has to *stay* absent: it means "to the end", which no number can express.
    // `--from 0` and no `--from` are the same thing, so a plain 0 is right there.
    await run('frames demo.mp4', fns)
    expect(seen[1]!.toMs).toBeUndefined()
    expect(seen[1]!.fromMs).toBe(0)
    expect(seen[1]!.first).toBe(false)
    expect(seen[1]!.last).toBe(false)
    expect(seen[1]!.maxEdge).toBe(0)

    // Out of range is clamped, not refused — the same way `--max` behaves, and the ceiling is
    // the one the format's own scale parameter uses.
    await run('frames demo.mp4 --max-edge 99999', fns)
    expect(seen[2]!.maxEdge).toBe(4096)
  })

  it('refuses an empty command', async () => {
    await expect(run('   ', stubFns(async () => ({ durationMs: 0, truncated: false, frames: [] }))))
      .rejects.toThrow('Missing command')
  })

  it('refuses frames with no recording', async () => {
    const fns = stubFns(async () => ({ durationMs: 0, truncated: false, frames: [] }))
    await expect(run('frames', fns)).rejects.toThrow('Which recording?')
    await expect(run('frames --out frames', fns)).rejects.toThrow('Which recording?')
  })

  it('refuses --out without a directory', async () => {
    const fns = stubFns(async () => ({ durationMs: 0, truncated: false, frames: [] }))
    await expect(run('frames demo.mp4 --out', fns)).rejects.toThrow('--out needs a directory')
  })

  it('refuses a command that is not its own, with its own help as the way out', async () => {
    const fns = stubFns(async () => ({ durationMs: 0, truncated: false, frames: [] }))
    const result = await run('status', fns)

    expect(result.output).toContain('Unknown recording_tool command "status"')
    expect(result.output).toContain('--help')
    expect(result.output).not.toContain('browser_tool')
    expect(result.appendReleaseHint).toBe(true)
  })

  it('decodes on a timeline every 1000 ms, at most 1000 frames, by default', async () => {
    const seen: Array<Record<string, unknown>> = []
    const fns = stubFns(async (args) => {
      seen.push(args)
      return { durationMs: 6000, truncated: false, frames: frames(3) }
    })

    await run('frames demo.mp4', fns)

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

    await run('frames demo.mp4 --every 500ms', fns)
    await run('frames demo.mp4 --every 2s', fns)
    await run('frames demo.mp4 --every nonsense', fns)
    await run('frames demo.mp4 --max 100000', fns)

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

    await run('frames demo.mp4 --changes', fns)

    expect(receivedMode).toBe('changes')
  })

  it('resolves a relative --out from the content root', async () => {
    let receivedOut: string | undefined
    const fns = stubFns(async ({ out }) => {
      receivedOut = out
      return { durationMs: 6000, truncated: false, frames: frames(1, true) }
    })

    await run('frames demo.mp4 --out frames/demo', fns)

    expect(receivedOut).toBe(resolve(WORKSPACE, 'frames/demo'))
  })

  it('reports duration, every offset, and that nothing was written when no --out is given', async () => {
    const fns = stubFns(async () => ({ durationMs: 6500, truncated: false, frames: frames(3) }))

    const result = await run('frames demo.mp4', fns)

    expect(result.output).toContain('Decoded 3 frames out of demo.mp4 (6.5s long) — no files written:')
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

    const result = await run('frames demo.mp4 --out frames/demo', fns)

    expect(result.output).toContain('Decoded 2 frames out of demo.mp4 (4s long) into frames/demo, as:')
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

    const result = await run('frames demo.mp4', fns)

    expect(result.output).toContain('Decoded 40 frames')
    expect(result.output).toContain('More moments moved here than the ceiling holds')
  })

  it('says when the frames came out further apart than the interval asked for', async () => {
    // What the sampler does when the ceiling cannot hold the recording at the detail asked for: the
    // same number of frames spread across the whole span — never the start of it and nothing after.
    const framesAt = (offsets: number[]) =>
      offsets.map((offsetMs) => ({ offsetMs, bytes: new Uint8Array([1]), path: null }))
    const fns = stubFns(async () => ({ durationMs: 600_000, truncated: false, frames: framesAt([0, 15_000, 30_000]) }))

    const widened = await run('frames demo.mp4', fns)

    expect(widened.output).toContain('One frame every 15s rather than the 1s asked for')
    // Widened, not cut short: the whole recording was looked at.
    expect(widened.output).not.toContain('was not examined')

    // And says nothing at all when the spacing is the one that was asked for.
    const exact = stubFns(async () => ({ durationMs: 4_000, truncated: false, frames: framesAt([0, 1_000, 2_000]) }))
    expect((await run('frames demo.mp4', exact)).output).not.toContain('rather than the')
  })

  it('hands every frame back as a JPEG image', async () => {
    const fns = stubFns(async () => ({ durationMs: 4000, truncated: false, frames: frames(2) }))

    const result = await run('frames demo.mp4', fns)

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

    await expect(run('frames demo.mov', fns)).rejects.toThrow(message)
  })

  it('takes the same command in array mode', async () => {
    let received: Record<string, unknown> | undefined
    const fns = stubFns(async (args) => {
      received = args
      return { durationMs: 2000, truncated: false, frames: frames(1) }
    })

    await run(['frames', 'demo.mp4', '--changes', '--max', '5'], fns)

    expect(received).toMatchObject({ mode: 'changes', maxFrames: 5 })
  })

  it('names frames the way the files are named', () => {
    expect(frameFileName(1)).toBe('frame-0001.jpg')
    expect(frameFileName(12)).toBe('frame-0012.jpg')
  })

  it('takes the sound out of a recording, to the file the caller named', async () => {
    let received: { path: string; out: string } | undefined
    const fns = stubFns(
      async () => ({ durationMs: 0, truncated: false, frames: [] }),
      async (args) => {
        received = args
        return { path: args.out, durationMs: 65_000, sampleRate: 16_000, byteLength: 2_080_000 }
      },
    )

    const result = await run('audio demo.mp4 --out assets/demo.wav', fns)

    expect(received?.path).toBe(resolve(WORKSPACE, 'demo.mp4'))
    expect(received?.out).toBe(resolve(WORKSPACE, 'assets/demo.wav'))
    expect(result.output).toContain('1m 5s of sound, 16 kHz mono (2031 KB)')
  })

  it('writes MP3 when the name or --format asks for it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'craft-audio-'))
    try {
      const out = join(dir, 'demo.mp3')
      const fns = stubFns(
        async () => ({ durationMs: 0, truncated: false, frames: [] }),
        async ({ out: wav }) => {
          writeTinyWav(wav, 0.5)
          return { path: wav, durationMs: 500, sampleRate: 16_000, byteLength: 16_044 }
        },
      )

      const result = await run(`audio demo.mp4 --out ${out}`, fns)

      expect(result.output).toContain('32 kbps mono MP3')
      const bytes = readFileSync(out)
      expect(bytes.length).toBeGreaterThan(1_000)
      const head = Buffer.from(bytes.subarray(0, 4)).toString('latin1')
      expect(head === 'LAME' || bytes[0] === 0xff).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses to take the sound out without a file to put it in', async () => {
    const fns = stubFns(async () => ({ durationMs: 0, truncated: false, frames: [] }))

    await expect(run('audio demo.mp4', fns)).rejects.toThrow('audio needs --out <file>')
  })

  it('reads a duration the way a person does', () => {
    expect(durationText(500)).toBe('0.5s')
    expect(durationText(6500)).toBe('6.5s')
    expect(durationText(60_000)).toBe('1m')
    expect(durationText(65_000)).toBe('1m 5s')
  })
})

/** A valid 16 kHz mono WAV, so `understand` really compresses something. */
function writeTinyWav(path: string, seconds = 1): void {
  const rate = 16_000
  const frames = Math.round(seconds * rate)
  const data = Buffer.alloc(frames * 2)
  for (let index = 0; index < frames; index += 1) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * index) / rate) * 3000), index * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(data.length, 40)
  writeFileSync(path, Buffer.concat([header, data]))
}

describe('recording_tool understand', () => {
  const CAPABILITIES = { omni: true, vision: true, asr: true }

  it('sends the sound as MP3 and the clip’s frames in time order, and answers with facts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'craft-understand-'))
    try {
      const seen: OmniModelRequest[] = []

      const result = await understandRecording({
        path: '/tmp/demo.mp4',
        prompt: 'What happens here?',
        mode: 'frames-audio',
        capabilities: CAPABILITIES,
        fns: {
          sampleVideo: (async (args: { probeOnly?: boolean }) =>
            args.probeOnly
              ? { durationMs: 60_000, viewport: { width: 1280, height: 720 }, truncated: false, frames: [] }
              : { durationMs: 60_000, viewport: { width: 1280, height: 720 }, truncated: false, frames: frames(2) }) as BrowserPaneFns['sampleVideo'],
          extractAudio: async ({ out }) => {
            writeTinyWav(out, 1)
            return { path: out, durationMs: 1_000, sampleRate: 16_000, byteLength: 32_044 }
          },
        },
        ask: async (request) => {
          seen.push(request)
          return { ok: true, text: 'A cat crosses the room.', model: 'qwen-omni' }
        },
      })

      expect(seen).toHaveLength(1)
      expect(seen[0]!.audio?.format).toBe('mp3')
      expect(seen[0]!.audio!.data.length).toBeGreaterThan(1_000)
      expect(seen[0]!.images).toHaveLength(2)
      expect(seen[0]!.instruction).toContain('What happens here?')
      expect(seen[0]!.instruction).toContain('Frames, in time order')
      expect(result.output).toContain('A cat crosses the room.')
      expect(result.output).toContain('heard 1s')
      expect(result.output).toContain('looked at 2 frames')
      expect(result.output).toContain('model qwen-omni')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('listens only when --frames off is asked for', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'craft-understand-'))
    try {
      const seen: OmniModelRequest[] = []

      const result = await understandRecording({
        path: '/tmp/talk.mp3',
        prompt: 'How do they sound?',
        frames: 0,
        mode: 'audio',
        capabilities: CAPABILITIES,
        fns: {
          sampleVideo: (async () => ({ durationMs: 20_000, truncated: false, frames: [] })) as BrowserPaneFns['sampleVideo'],
          extractAudio: async ({ out }) => {
            writeTinyWav(out, 0.2)
            return { path: out, durationMs: 200, sampleRate: 16_000, byteLength: 6_444 }
          },
        },
        ask: async (request) => {
          seen.push(request)
          return { ok: true, text: 'Calm.', model: 'qwen-omni' }
        },
      })

      expect(seen[0]!.images).toBeUndefined()
      expect(result.output).toContain('Calm.')
      expect(result.output).not.toContain('looked at')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('sends a picture-only run to the vision model, without the soundtrack', async () => {
    const seenOmni: OmniModelRequest[] = []
    const seenText: Array<{ images?: string[]; instruction?: string }> = []

    const result = await understandRecording({
      path: '/tmp/silent.mp4',
      prompt: 'What is on screen?',
      mode: 'frames',
      capabilities: CAPABILITIES,
      fns: {
        sampleVideo: (async (args: { probeOnly?: boolean }) =>
          args.probeOnly
            ? { durationMs: 8_000, viewport: { width: 1280, height: 720 }, truncated: false, frames: [] }
            : { durationMs: 8_000, viewport: { width: 1280, height: 720 }, truncated: false, frames: frames(3) }) as BrowserPaneFns['sampleVideo'],
        extractAudio: async ({ out }) => {
          writeTinyWav(out, 0.2)
          return { path: out, durationMs: 200, sampleRate: 16_000, byteLength: 6_444 }
        },
      },
      ask: async (request) => {
        seenOmni.push(request)
        return { ok: true, text: 'never', model: 'qwen-omni' }
      },
      askText: (async (request: { images?: string[]; instruction?: string }) => {
        seenText.push(request)
        return { ok: true, text: 'A whiteboard.', model: 'qwen-vl' }
      }) as unknown as typeof import('../../media/workspace-model').askWorkspaceModel,
    })

    expect(seenOmni).toHaveLength(0)
    expect(seenText).toHaveLength(1)
    expect(seenText[0]!.images).toHaveLength(3)
    expect(seenText[0]!.instruction).not.toContain('soundtrack')
    expect(result.output).toContain('A whiteboard.')
    expect(result.output).not.toContain('heard')
    expect(result.output).toContain('via frames')
  })

  it('asks for a vision model instead of letting omni read the frames', async () => {
    let asked = false

    const result = await understandRecording({
      path: '/tmp/silent.mp4',
      prompt: 'What is on screen?',
      capabilities: { omni: true, vision: false, asr: false },
      fns: {
        sampleVideo: (async (args: { probeOnly?: boolean }) =>
          args.probeOnly
            ? { durationMs: 8_000, viewport: { width: 1280, height: 720 }, truncated: false, frames: [] }
            : { durationMs: 8_000, viewport: { width: 1280, height: 720 }, truncated: false, frames: frames(2) }) as BrowserPaneFns['sampleVideo'],
        extractAudio: async () => {
          throw new Error('no soundtrack')
        },
      },
      ask: async () => {
        asked = true
        return { ok: true, text: 'never' }
      },
      askText: (async () => {
        asked = true
        return { ok: true, text: 'never' }
      }) as unknown as typeof import('../../media/workspace-model').askWorkspaceModel,
    })

    expect(asked).toBe(false)
    expect(result.output).toContain('Vision model')
    expect(result.output).not.toContain('Omni model（听声音）或')
  })

  it('refuses to ask when no frame could be sampled', async () => {
    let asked = false

    const result = await understandRecording({
      path: '/tmp/blank.mp4',
      prompt: 'What is on screen?',
      mode: 'frames',
      capabilities: CAPABILITIES,
      fns: {
        sampleVideo: (async (args: { probeOnly?: boolean }) =>
          args.probeOnly
            ? { durationMs: 8_000, viewport: { width: 1280, height: 720 }, truncated: false, frames: [] }
            : { durationMs: 8_000, viewport: { width: 1280, height: 720 }, truncated: false, frames: [] }) as BrowserPaneFns['sampleVideo'],
        extractAudio: async () => {
          throw new Error('no soundtrack')
        },
      },
      ask: async () => {
        asked = true
        return { ok: true, text: 'never' }
      },
      askText: (async () => {
        asked = true
        return { ok: true, text: 'never' }
      }) as unknown as typeof import('../../media/workspace-model').askWorkspaceModel,
    })

    expect(asked).toBe(false)
    expect(result.output).toContain('没能从这段录像里取到画面')
  })

  it('refuses a recording longer than one call can carry, before asking a model', async () => {
    let asked = false
    const result = await understandRecording({
      path: '/tmp/long.mp4',
      prompt: 'Summarise.',
      capabilities: CAPABILITIES,
      fns: {
        sampleVideo: (async () => ({
          durationMs: 31 * 60_000,
          viewport: { width: 640, height: 360 },
          truncated: false,
          frames: [],
        })) as BrowserPaneFns['sampleVideo'],
        extractAudio: async ({ out }) => ({ path: out, durationMs: 0, sampleRate: 16_000, byteLength: 0 }),
      },
      ask: async () => {
        asked = true
        return { ok: true, text: 'never' }
      },
    })

    expect(asked).toBe(false)
    expect(result.output).toContain('30 分钟上限')
  })
})

describe('understanding route', () => {
  const all = { omni: true, vision: true, asr: true }
  const facts = (overrides: Partial<{ hasPicture: boolean; hasAudio: boolean; durationMs: number; bytes: number }> = {}) => ({
    hasPicture: true,
    hasAudio: true,
    durationMs: 60_000,
    bytes: 1_000_000,
    ...overrides,
  })

  it('sends a short clip whole when an omni model is configured', () => {
    expect(chooseUnderstandStrategy('auto', facts(), all)).toBe('video')
  })

  it('goes as frames + sound once the clip is too long for one video request', () => {
    expect(chooseUnderstandStrategy('auto', facts({ durationMs: 151_000 }), all)).toBe('frames-audio')
    expect(chooseUnderstandStrategy('auto', facts({ bytes: 9 * 1024 * 1024 }), all)).toBe('frames-audio')
  })

  it('falls to the transcript routes when no omni model is configured', () => {
    const noOmni = { omni: false, vision: true, asr: true }
    expect(chooseUnderstandStrategy('auto', facts(), noOmni)).toBe('transcript-frames')
    expect(chooseUnderstandStrategy('auto', facts({ hasPicture: false }), noOmni)).toBe('transcript')
  })

  it('refuses an explicit route its requirements cannot carry', () => {
    expect(chooseUnderstandStrategy('video', facts(), { omni: false, vision: true, asr: true })).toBeNull()
    expect(chooseUnderstandStrategy('transcript', facts(), { omni: true, vision: true, asr: false })).toBeNull()
  })

  it('does not let omni stand in for vision when the clip is silent', () => {
    const omniOnly = { omni: true, vision: false, asr: false }
    const silent = facts({ hasAudio: false })
    expect(chooseUnderstandStrategy('auto', silent, omniOnly)).toBeNull()
    expect(chooseUnderstandStrategy('frames', silent, omniOnly)).toBeNull()
  })

  it('says nothing can be done when no model is configured', () => {
    expect(chooseUnderstandStrategy('auto', facts(), { omni: false, vision: false, asr: false })).toBeNull()
  })
})

describe('understanding from a transcript', () => {
  it('answers from words when no omni model is configured', async () => {
    const asked: Array<{ instruction?: string }> = []
    const result = await understandRecording({
      path: '/tmp/talk.mp3',
      prompt: 'What was decided?',
      mode: 'transcript',
      capabilities: { omni: false, vision: true, asr: true },
      fns: {
        sampleVideo: (async () => ({ durationMs: 10_000, truncated: false, frames: [] })) as BrowserPaneFns['sampleVideo'],
        extractAudio: async ({ out }) => {
          writeTinyWav(out, 0.2)
          return { path: out, durationMs: 200, sampleRate: 16_000, byteLength: 6_444 }
        },
      },
      transcribe: async () => 'We decided to ship on Friday.',
      askText: (async (request: { instruction?: string }) => {
        asked.push(request)
        return { ok: true, text: 'Ship on Friday.', model: 'text-1' }
      }) as unknown as typeof import('../../media/workspace-model').askWorkspaceModel,
    })

    expect(asked[0]!.instruction).toContain('We decided to ship on Friday.')
    expect(result.output).toContain('Ship on Friday.')
    expect(result.output).toContain('via transcript')
  })
})
