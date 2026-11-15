/**
 * `recording_tool` — recording work: what a file is, the frames inside it, and one answer about it.
 *
 * `probe` / `frames` / `audio` are local primitives: one file in, one answer out, decoded by the
 * browser the app already ships. `understand` is the one verb that asks a model: it composes those
 * primitives (sound as MP3, a few frames) into a single question. Keeping the primitives separate
 * is what lets the same frames be looked at, kept, or sent somewhere else.
 */

import { isAbsolute, join } from 'node:path'
import { tmpdir } from 'node:os'
import { unlinkSync, writeFileSync } from 'node:fs'
import {
  type BrowserCommandImage,
  type BrowserCommandResult,
  type ToolCommandArgs,
  type ToolCommandContext,
  createCommandRunner,
  durationOption,
  numberOption,
  resolveLocalPath,
} from './command-cli.ts';
import { resolveContentRoots, resolveFilePath } from './content-paths.ts'
import type { BrowserPaneFns } from './browser-pane.ts'
import { frameFileName } from '../recording/sampler-script.ts'
import { encodeWavFileToMp3, type Mp3Bitrate } from '../media/mp3.ts'
import { understandRecording, DEFAULT_UNDERSTAND_FRAMES, MAX_UNDERSTAND_FRAMES, type UnderstandMode } from './understand-recording.ts'

export { frameFileName }

/**
 * One frame a second, at most 1000 of them.
 *
 * A second rather than a coarser grid because a question is usually about a moment — "at 0:12 the
 * total moved" — which a two-second grid can put between two frames. What it costs is frames, and
 * the ceiling is what bounds that: a recording too long for this many frames is read **more
 * coarsely over the whole of it**, never cut off partway.
 */
const DEFAULT_EVERY_MS = 1_000
const DEFAULT_MAX_FRAMES = 1_000

/** The CBR steps the MP3 encoder accepts; `--bitrate` is refused rather than rounded. */
const MP3_BITRATES = new Set<number>([8, 16, 24, 32, 40, 48, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320])

/**
 * What to say when the frames came out further apart than the interval asked for.
 *
 * The sampler spreads a read over the whole span, widening the step when the ceiling cannot hold
 * the recording at the detail asked for. A read that was widened is worth saying out loud: the
 * moment somebody wanted may now sit between two frames. `null` when the spacing is the one that
 * was asked for; the tolerance is the seek's own rounding, a frame either side of the mark.
 */
function widenedNote(offsets: number[], askedEveryMs: number): string | null {
  // A middle pair rather than the first two, whose gap carries the range's own start.
  if (offsets.length < 3) return null
  const gap = offsets[2]! - offsets[1]!
  if (gap <= askedEveryMs + Math.max(50, askedEveryMs / 10)) return null

  const asDuration = (ms: number): string =>
    ms % 1000 === 0 ? `${ms / 1000}s` : `${(ms / 1000).toFixed(1)}s`
  return (
    `One frame every ${asDuration(gap)} rather than the ${asDuration(askedEveryMs)} asked for: this recording is ` +
    'longer than the ceiling holds at that detail. Raise "--max", or read a window with "--from"/"--to".'
  )
}

/** A duration as a person reads it: `6.5s`, `1m 5s`. */
export function durationText(ms: number): string {
  const seconds = ms / 1000
  if (seconds < 60) return `${Number(seconds.toFixed(1))}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Number((seconds - minutes * 60).toFixed(1))
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`
}

/**
 * `--threshold <0..1>` — how much has to change for `--changes` to keep a frame.
 *
 * Smaller keeps more. **Refused rather than clamped** when it is not a number in range: this is a
 * value whose scale *is* the answer, and quietly turning "0.5x" into the default would reply to a
 * different question than the one that was asked.
 */
function thresholdOption(parts: string[]): number | undefined {
  const at = parts.indexOf('--threshold')
  if (at === -1) return undefined

  const raw = (parts[at + 1] ?? '').trim()
  const value = Number(raw)
  if (!raw.startsWith('--') && Number.isFinite(value) && value > 0 && value <= 1) return value

  throw new Error(
    '--threshold takes a number in (0, 1] — smaller keeps more frames. Example: --changes --threshold 0.05',
  )
}

/**
 * A duration that is genuinely optional — `undefined` when the flag is absent, not a default.
 *
 * `durationOption` cannot say the difference, and for `--to` the difference *is* the meaning:
 * absent is "to the end", which no number can express (`0` is the beginning).
 */
function optionalDurationOption(parts: string[], flag: string): number | undefined {
  return parts.includes(flag) ? durationOption(parts, flag, 0) : undefined
}

/** A flag's value, or undefined when the flag is absent or carries no value. */
function stringOption(parts: string[], flag: string): string | undefined {
  const at = parts.indexOf(flag)
  const value = at >= 0 ? parts[at + 1] : undefined
  return value && !value.startsWith('--') ? value : undefined
}

export function getRecordingToolHelp(): string {
  return [
    'recording_tool — a recording on this machine, decoded by Chromium. One command per call.',
    '',
    'Usage:',
    '  probe <path>',
    '        how long it is, and its picture size — header only, no frames',
    '  frames <path> [--out <dir>] [--every <dur>] [--changes] [--threshold <r>] [--from <dur>] [--to <dur>] [--first] [--last] [--max-edge <n>] [--max <n>]',
    '        decode frames: the reply without --out, numbered JPEGs with it',
    '  audio <path> --out <file> [--format wav|mp3] [--bitrate <kbps>]',
    '        the sound as 16 kHz mono WAV (default) or MP3 (32 kbps unless --bitrate); the WAV is',
    '        what asr_tool reads. The name decides unless --format is given.',
    '  understand <path> --prompt "<question>" [--frames <n|off>] [--audio off] [--mode <mode>]',
    '        one answer about the recording. The route is chosen from the person\'s settings:',
    '        video (a short clip sent whole), frames-audio, audio, frames, transcript, or',
    '        transcript-frames. --mode names one of those (auto by default); --audio off ignores',
    '        the soundtrack; --frames off ignores the picture. A mode these knobs make impossible',
    '        is refused rather than silently replaced. Sound and video go to the person\'s Omni',
    '        model; pictures alone go to a vision-capable model, and speech recognition can stand',
    '        in for the soundtrack. Up to 30 minutes.',
    '',
    'For one answer about the whole recording use `understand` — a single call that uses the sound',
    'and as many frames as its route allows. To ask about pictures you already hold, compose:',
    '`frames` then `call_llm` with the images and their moments. Speech-to-text is `asr_tool`.',
    '',
    '<path> is the recording; a relative path counts from the conversation content root — the',
    'project folder, or the session folder when the conversation is in none. An absolute path is',
    'taken as it is. The decoding is',
    "Chromium's — the browser the app already ships (a hidden window on the desktop, the render host",
    "on a hub) — so there is no ffmpeg to install and no window of yours involved. mp4 (H.264),",
    'HEVC reads only where the machine has a hardware decoder for it, and ProRes not at all; a',
    'recording that cannot be read is refused by name instead of half-read.',
    '',
    'The default is a timeline: one frame every 1000 ms, at most 1000 frames. A recording too long',
    'for that many frames is read **more coarsely over the whole of it**, never cut off partway, and',
    'the reply says how far apart the frames came out.',
    '  --every <dur>    how far apart the frames are (500ms, 2s, 1m). Omitted, one second',
    '  --changes        keep only the frames that moved',
    '  --threshold <r>  with --changes: how much has to change to keep a frame, a number in (0, 1].',
    '                   Smaller keeps more. Omitted, the sampler\'s own default.',
    '  --from <dur>     start looking here (12s, 1m30s). Omitted, from the beginning.',
    '  --to <dur>       stop looking here. Omitted, to the end.',
    '  --first          the recording\'s first frame — and with --last, just those two.',
    '  --last           the recording\'s last frame.',
    '  --max-edge <n>   cap the longest edge of each frame, in pixels, aspect kept. Scales down',
    '                   only. "0" — the default — means the recording\'s own size.',
    '  --max <n>        the ceiling on frames. Default 1000; a read that does not fit is widened,',
    '                   not cut short',
    '  --out <dir>      write the frames there as frame-0001.jpg, frame-0002.jpg, … and name the',
    '                   files in the reply. Omitted, nothing is written.',
    '',
    'Examples:',
    '  probe demo.mp4',
    '  frames demo.mp4 --first --last --out research/demo',
    '  frames demo.mp4 --out research/demo --every 500ms',
  ].join('\n')
}

/**
 * One video command, once the command line has been read.
 *
 * An unknown verb gets this door's own `--help` — not a map of the other doors. Such a map is one
 * hand-kept entry per (door, verb) pair, and a stale one misdirects; every door's brief is already
 * in the tool list the model holds.
 */
const runOneCommand = createCommandRunner({
  help: getRecordingToolHelp,
  run: runRecordingCommand,
  unknownCommand: unknownCommandText,
})

/** The refusal a command that is not this door's gets: the verb, and this door's way out. */
function unknownCommandText(cmd: string): string {
  return `Unknown recording_tool command "${cmd}". One command per call — "--help" lists them.`
}

/** What this door answers. Anything else is refused with the sentence above, not thrown. */
const RECORDING_VERBS = new Set(['probe', 'frames', 'audio', 'understand'])

/**
 * Run one recording command.
 *
 * **One command per call, no batches.** A recording is probed or decoded in one act, and the reply
 * describes that act — a batch has nothing to combine into.
 */
export async function executeRecordingToolCommand(args: ToolCommandArgs): Promise<BrowserCommandResult> {
  const empty = Array.isArray(args.command) ? args.command.length === 0 : !args.command.trim()
  if (empty) {
    throw new Error('Missing command. Use "--help" to see the recording_tool commands.')
  }

  const first = Array.isArray(args.command)
    ? args.command[0]
    : args.command.trim().match(/"[^"]*"|'[^']*'|\S+/g)?.[0]
  const verb = (first ?? '').replace(/^["']|["']$/g, '').toLowerCase()
  if (!RECORDING_VERBS.has(verb) && verb !== 'help' && verb !== '--help' && verb !== '-h') {
    return { output: `Error: ${unknownCommandText(verb)}`, appendReleaseHint: true }
  }

  return runOneCommand(args)
}

/**
 * Frames out of a recording.
 *
 * Every frame is a picture of the moment `offsetMs` into the recording, and every one of them goes
 * back in the reply: what consumes it is a reader — a model, or the person — and a sample of a
 * sample is how the one moment that mattered gets dropped. `--out` is the only thing that decides
 * whether they are also files.
 */
export async function runRecordingCommand(ctx: ToolCommandContext): Promise<BrowserCommandResult | null> {
  const { fns, parts, cmd, workspaceRootPath } = ctx

  if (!fns) {
    throw new Error(
      'Reading a recording needs a decoder: frames are decoded by Chromium — the desktop app’s ' +
        'hidden window, or a hub’s render host. This host has neither.',
    )
  }

  // Relative paths count from the conversation's content root, like the other doors that touch the
  // conversation's own files. An absolute path is taken as it is: this is a local decoder, and a
  // recording elsewhere on the machine is still a recording.
  const roots = resolveContentRoots({
    sessionId: ctx.sessionId,
    workspaceRootPath,
    projectId: ctx.projectId,
    workingDirectory: ctx.sessionWorkingDirectory,
  })
  const resolveRecordingPath = (raw: string): string => {
    if (isAbsolute(raw)) return raw
    if (roots.ok) {
      const resolved = resolveFilePath(raw, roots.roots)
      if (!resolved.ok) throw new Error(resolved.error)
      return resolved.path
    }
    return resolveLocalPath(raw, workspaceRootPath)
  }

  if (cmd === 'probe') {
    const path = parts[1]
    if (!path || path.startsWith('--')) {
      throw new Error('Which recording? "probe <path>" — the video to ask about.')
    }

    const result = await fns.sampleVideo({
      path: resolveRecordingPath(path),
      probeOnly: true,
      mode: 'timeline',
      everyMs: DEFAULT_EVERY_MS,
      maxFrames: 1,
    })

    const size = result.viewport
      ? `${result.viewport.width}x${result.viewport.height}`
      : 'picture size not reported'
    return {
      output: `${path} — ${durationText(result.durationMs)} (${result.durationMs} ms), ${size}.`,
      appendReleaseHint: false,
    }
  }

  if (cmd === 'audio') {
    const path = parts[1]
    if (!path || path.startsWith('--')) {
      throw new Error('Which recording? "audio <path> --out <file>" — the clip whose sound to take out.')
    }

    const outAt = parts.indexOf('--out')
    const namedOut = outAt >= 0 ? parts[outAt + 1] : undefined
    if (!namedOut || namedOut.startsWith('--')) {
      throw new Error('audio needs --out <file> — where the sound should land.')
    }

    const out = resolveRecordingPath(namedOut)
    // The name is the default, `--format` overrides it — the same rule `asr_tool --out` uses.
    const format = stringOption(parts, '--format') ?? (out.toLowerCase().endsWith('.mp3') ? 'mp3' : 'wav')
    if (format !== 'wav' && format !== 'mp3') {
      throw new Error('--format takes wav or mp3.')
    }

    if (format === 'wav') {
      const result = await fns.extractAudio({ path: resolveRecordingPath(path), out })
      const kb = Math.round(result.byteLength / 1024)
      return {
        output: `${out} — ${durationText(result.durationMs)} of sound, ${Math.round(
          result.sampleRate / 1000,
        )} kHz mono (${kb} KB).`,
        appendReleaseHint: false,
      }
    }

    const bitrate = Number(stringOption(parts, '--bitrate') ?? 32)
    if (!MP3_BITRATES.has(bitrate)) {
      throw new Error('--bitrate takes 8 / 16 / 24 / 32 / 40 / 48 / 64 / 80 / 96 / 112 / 128 / 160 / 192 / 224 / 256 / 320.')
    }

    // Chromium still decodes; MP3 is only a smaller container for what it produced.
    const wav = join(tmpdir(), `craft-audio-${process.pid}-${Date.now()}.wav`)
    try {
      const result = await fns.extractAudio({ path: resolveRecordingPath(path), out: wav })
      const { bytes } = await encodeWavFileToMp3(wav, bitrate as Mp3Bitrate)
      writeFileSync(out, bytes)
      return {
        output: `${out} — ${durationText(result.durationMs)} of sound, ${bitrate} kbps mono MP3 (${Math.round(
          bytes.length / 1024,
        )} KB).`,
        appendReleaseHint: false,
      }
    } finally {
      try {
        unlinkSync(wav)
      } catch {
        // A leftover temp file is not a failed extraction.
      }
    }
  }

  if (cmd === 'frames') {
    const path = parts[1]
    if (!path || path.startsWith('--')) {
      throw new Error('Which recording? "frames <path>" — the video to decode frames out of.')
    }

    const outAt = parts.indexOf('--out')
    const namedOut = outAt >= 0 ? parts[outAt + 1] : undefined
    if (outAt >= 0 && (!namedOut || namedOut.startsWith('--'))) {
      throw new Error('--out needs a directory. Example: frames demo.mp4 --out research/demo')
    }

    // `--to` is the one that has to stay absent when it is absent: "to the end" is not a number.
    const toMs = optionalDurationOption(parts, '--to')

    const result = await fns.sampleVideo({
      path: resolveRecordingPath(path),
      out: namedOut ? resolveRecordingPath(namedOut) : undefined,
      mode: parts.includes('--changes') ? 'changes' : 'timeline',
      everyMs: durationOption(parts, '--every', DEFAULT_EVERY_MS),
      maxFrames: numberOption(parts, '--max', DEFAULT_MAX_FRAMES, 1, 1000),
      changeThreshold: thresholdOption(parts),
      // `--from 0` and no `--from` mean the same thing, so a plain duration option is enough.
      fromMs: durationOption(parts, '--from', 0),
      ...(toMs !== undefined ? { toMs } : {}),
      first: parts.includes('--first'),
      last: parts.includes('--last'),
      // The frames are for a reader rather than a model by default, so the recording's own size is
      // the answer and `0` — "no scaling" — is what leaving it out means. The sampler's own guard
      // (`maxEdge > 0`) carries the absence; a floor here would turn "no scaling" into 16px.
      maxEdge: numberOption(parts, '--max-edge', 0, 0, 4096),
    })

    const frames = result.frames
    const lines = [
      `Decoded ${frames.length} frame${frames.length === 1 ? '' : 's'} out of ${path} ` +
        `(${durationText(result.durationMs)} long)` +
        (namedOut ? ` into ${namedOut}, as:` : ' — no files written:'),
    ]
    // Every frame's position in the recording, which is the coordinate a reader of a recording can
    // use ("at 0:12 the total moves") — a wall of images with no offsets is a wall of images.
    frames.forEach((frame, index) => {
      lines.push(`  • ${frameFileName(index + 1)}  @ ${frame.offsetMs}ms`)
    })
    if (!parts.includes('--changes')) {
      const widened = widenedNote(
        frames.map((frame) => frame.offsetMs),
        durationOption(parts, '--every', DEFAULT_EVERY_MS),
      )
      if (widened) lines.push(widened)
    }
    if (result.truncated) {
      lines.push('More moments moved here than the ceiling holds, so the later part of the recording was not examined.')
    }
    if (!namedOut) {
      lines.push(
        'Nothing was written to disk — these frames are the reply. Run it again with "--out <dir>" to',
        'keep them as files.',
      )
    }

    // The frames go back with the reply, whether or not they were kept: the files are the record,
    // and a reader looks at pictures rather than a list of paths.
    const images: BrowserCommandImage[] = frames.map((frame) => ({
      data: Buffer.from(frame.bytes).toString('base64'),
      mimeType: 'image/jpeg' as const,
      sizeBytes: frame.bytes.length,
      ...(frame.path ? { path: frame.path } : {}),
    }))

    return { output: lines.join('\n'), appendReleaseHint: false, images }
  }

  if (cmd === 'understand') {
    const path = parts[1]
    if (!path || path.startsWith('--')) {
      throw new Error('Which recording? "understand <path> --prompt \\"<question>\\"" — the file to read.')
    }
    const prompt = stringOption(parts, '--prompt')
    if (!prompt) {
      throw new Error('understand needs --prompt "<question>" — what to answer about the recording.')
    }

    // `--frames off` is a real choice (listen only); absent means "four when it has a picture".
    const framesRaw = stringOption(parts, '--frames')
    const frames =
      framesRaw === 'off'
        ? 0
        : framesRaw
          ? numberOption(parts, '--frames', DEFAULT_UNDERSTAND_FRAMES, 0, MAX_UNDERSTAND_FRAMES)
          : undefined

    const modes: readonly UnderstandMode[] = [
      'auto',
      'video',
      'frames-audio',
      'audio',
      'frames',
      'transcript',
      'transcript-frames',
    ]
    const modeRaw = stringOption(parts, '--mode')
    if (modeRaw && !(modes as readonly string[]).includes(modeRaw)) {
      throw new Error(`--mode takes one of ${modes.join(' / ')}.`)
    }

    return understandRecording({
      path: resolveRecordingPath(path),
      prompt,
      ...(frames !== undefined ? { frames } : {}),
      ...(modeRaw ? { mode: modeRaw as UnderstandMode } : {}),
      ...(stringOption(parts, '--audio') === 'off' ? { audio: false } : {}),
      sessionId: ctx.sessionId,
      ...(ctx.workspaceRootPath ? { workspaceRootPath: ctx.workspaceRootPath } : {}),
      ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
      ...(ctx.sessionWorkingDirectory ? { sessionWorkingDirectory: ctx.sessionWorkingDirectory } : {}),
      fns,
      ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
    })
  }

  return null
}
