/**
 * `video_tool`'s commands.
 *
 * One command: `sample` turns a recording into frames. A recording is not something a model can
 * read — it would have to decode it and pick frames itself — so the frames are decoded and handed
 * back as images instead. That is a door of its own: it is neither a page being driven nor a file
 * being written.
 *
 * The decoding is Chromium's (see `BrowserPaneFns.sampleVideo`); this file is the command line in
 * front of it, and the naming rule the frames are written under.
 */

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
import { IMAGE_LIMITS } from '../utils/files.ts';

/**
 * One frame a second, at most 40 of them.
 *
 * A second rather than the two these used to take, for both doors: `understand` is *asked about*
 * the recording, and a question is usually about a moment — "at 0:12 the total moved" — which a 2 s
 * grid can put between two frames; `sample` is the same read without the model, so there is no
 * reason for it to answer a different question than `understand` would.
 *
 * What it costs is frames, and `DEFAULT_MAX_FRAMES` is what bounds that — high enough that this
 * interval is what decides the spacing of a normal read.
 */
const DEFAULT_EVERY_MS = 1_000;

/**
 * The ceiling on frames, unless the caller names one.
 *
 * High enough that the **interval** decides: at the default second a read covers a recording up to
 * 1000 s long in that detail, and spreads more coarsely over the whole of anything longer rather
 * than stopping partway (`video-frames.ts`). It is a ceiling and not "no ceiling" because every
 * frame is a picture somebody pays for — a model, per image — and every one is a seek.
 */
const DEFAULT_MAX_FRAMES = 1_000;

/**
 * What to say when the frames came out further apart than the interval asked for.
 *
 * The sampler spreads a read over the whole span, widening the step when the ceiling cannot hold
 * the recording at the detail asked for — coarse throughout rather than fine at the start and
 * nothing after. A read that was widened is worth saying out loud: the question may have been about
 * a moment that now sits between two frames. `null` when the spacing is the one that was asked for;
 * the tolerance is the seek's own rounding, a frame either side of the mark.
 */
function widenedNote(offsets: number[], askedEveryMs: number): string | null {
  // A middle pair rather than the first two, whose gap carries the range's own start.
  if (offsets.length < 3) return null;
  const gap = offsets[2]! - offsets[1]!;
  if (gap <= askedEveryMs + Math.max(50, askedEveryMs / 10)) return null;

  const asDuration = (ms: number): string => (ms % 1000 === 0 ? `${ms / 1000}s` : `${(ms / 1000).toFixed(1)}s`);
  return (
    `One frame every ${asDuration(gap)} rather than the ${asDuration(askedEveryMs)} asked for: this recording is ` +
    'longer than the ceiling holds at that detail. Raise "--max", or read a window with "--from"/"--to".'
  );
}

/** `frame-0001.jpg` — index first, so a plain `ls` is already in order. */
export function frameFileName(index: number): string {
  return `frame-${String(index).padStart(4, '0')}.jpg`;
}

/**
 * `video_tool --help`.
 *
 * Written the way the tool's own description is: `understand` reads a recording by asking a model
 * about its frames, `sample` is the same frames without the model, and the one flag that decides
 * whether frames are also kept as files.
 */
/**
 * `--threshold <0..1>` — how much has to change for `--changes` to keep a frame.
 *
 * Smaller keeps more. **Refused rather than clamped** when it is not a number in range: this is a
 * value whose scale *is* the answer, and quietly turning "0.5x" into the default would reply to a
 * different question than the one that was asked. Only reads it when `--changes` is in play; on a
 * timeline sampling it means nothing and the sampler ignores it.
 */
function thresholdOption(parts: string[]): number | undefined {
  const at = parts.indexOf('--threshold');
  if (at === -1) return undefined;

  const raw = (parts[at + 1] ?? '').trim();
  const value = Number(raw);
  if (!raw.startsWith('--') && Number.isFinite(value) && value > 0 && value <= 1) return value;

  throw new Error(
    '--threshold takes a number in (0, 1] — smaller keeps more frames. Example: --changes --threshold 0.05',
  );
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

export function getVideoToolHelp(): string {
  return [
    'video_tool command help',
    '',
    'Usage (one command per call — no batching):',
    '  --help',
    '  understand <path> --prompt <question> [--every <dur>] [--changes] [--threshold <r>] [--from <dur>] [--to <dur>] [--first] [--last] [--max-edge <n>] [--max <n>] [--model <id>] [--out <dir>]',
    '                                                 read a recording: its frames go to a model, its answer comes back',
    '  sample <path> [--out <dir>] [--every <dur>] [--changes] [--threshold <r>] [--from <dur>] [--to <dur>] [--first] [--last] [--max-edge <n>] [--max <n>]',
    '                                                 the frames themselves, decoded by Chromium',
    '',
    'A recording is not something you can watch, so "what happened in this screen recording" has no',
    'answer until it is frames. "understand" makes them and asks a model about them — you get the',
    'answer, not the pictures. Every frame carries the moment it was taken from, so the reply can say',
    'when something happened and you can cite it. "sample" is the same frames without the model, for',
    'when you would rather look at them yourself.',
    '',
    '<path> is the recording; a relative path counts from the workspace root. The decoding is',
    'Chromium\'s — the browser the app already ships, in a hidden window of its own — so there is no',
    'ffmpeg to install and no window of yours involved. mp4 (H.264), webm and most mov files read.',
    'HEVC reads only where the machine has a hardware decoder for it, and ProRes not at all; a',
    'recording that cannot be read is refused by name instead of half-read.',
    '',
    'The default is a timeline: one frame every 1000 ms, at most 1000 frames. A recording too long',
    'for that many frames is read **more coarsely over the whole of it**, never cut off partway, and',
    'the reply says how far apart the frames came out.',
    '  --prompt <question>  what to ask about the recording (required by "understand")',
    '  --every <dur>    how far apart the frames are (500ms, 2s, 1m). Omitted, one second',
    '  --changes        keep only the frames that moved',
    '  --threshold <r>  with --changes: how much has to change to keep a frame, a number in (0, 1].',
    '                   Smaller keeps more. Omitted, the sampler\'s own default — which is what this',
    '                   always did, so pass it only to loosen or tighten deliberately.',
    '  --from <dur>     start looking here (12s, 1m30s). Omitted, from the beginning.',
    '  --to <dur>       stop looking here. Omitted, to the end — which is the only way to say it,',
    '                   since nobody knows the length of a recording until it is opened.',
    '  --first          the recording\'s first frame — and with --last, just those two. Either one',
    '                   replaces the interval scan: "the last frame" is one picture, not fifteen',
    '                   of them plus one. Use for a cover, or "where did it end up".',
    '  --last           the recording\'s last frame.',
    '  --max-edge <n>   cap the longest edge of each frame, in pixels, aspect kept. Scales down',
    '                   only, and it is the knob that decides what a model is charged per frame:',
    `                   "understand" caps at ${IMAGE_LIMITS.OPTIMAL_EDGE} when this is not given — the app's own`,
    '                   "big enough to read, small enough to pay for" edge — while "sample" writes the',
    '                   frames at the recording\'s own size. "0" means no scaling, either way.',
    '  --max <n>        the ceiling on frames — the one knob that bounds what a model is sent.',
    '                   Default 1000; a read that does not fit is widened, not cut short',
    '  --model <id>     which model reads it; omitted, the conversation\'s small model',
    '  --out <dir>      write the frames there as frame-0001.jpg, frame-0002.jpg, … and name the',
    '                   files in the reply. Omitted, nothing is written.',
    '',
    'Examples:',
    '  understand demo.mp4 --prompt "what did the user do, and when?"',
    '  understand demo.mp4 --prompt "did the total change?" --changes --max 20',
    '  sample ~/Desktop/demo.mp4',
    '  sample demo.mp4 --out research/demo --every 500ms',
  ].join('\n');
}

/**
 * One video command, once the command line has been read.
 *
 * The window's primitives have plausible-sounding commands of their own, so a refusal names that
 * door — "unknown" alone leaves the agent with nowhere to go.
 */
const runOneCommand = createCommandRunner({
  help: getVideoToolHelp,
  run: runVideoCommand,
  unknownCommand: (cmd) =>
    `Unknown video_tool command "${cmd}". One command per call — "--help" lists them. ` +
    `Driving the window itself is browser_tool's.`,
});

/**
 * Run a `video_tool` command.
 *
 * **One command per call, no batches.** A recording is sampled in one act, and the reply is a set
 * of frames that belong to that act — a batch has nothing to combine into.
 */
export async function executeVideoToolCommand(args: ToolCommandArgs): Promise<BrowserCommandResult> {
  const empty = Array.isArray(args.command) ? args.command.length === 0 : !args.command.trim();
  if (empty) {
    throw new Error('Missing command. Use "--help" to see the video_tool command.');
  }

  return runOneCommand(args);
}

/**
 * The brief a model gets along with a recording's frames.
 *
 * The offsets are written out because the Pi SDK takes images as a flat list — there is nothing to
 * interleave them with — so on every backend a frame is paired with its moment by position. (Claude
 * *also* places each frame where its moment belongs in the text; that is additive to this, not a
 * different brief.)
 */
export function buildUnderstandPrompt(question: string, offsetsMs: number[], durationMs: number): string {
  const stamps = offsetsMs.map((ms) => `+${ms}ms`).join(', ');
  const count = `${offsetsMs.length} frame${offsetsMs.length === 1 ? '' : 's'}`;
  return [
    `A screen recording, ${Math.round(durationMs / 1000)}s long, is attached as ${count}, in order.`,
    `The frames were taken at: ${stamps}.`,
    '',
    question,
  ].join('\n');
}

/**
 * Frames out of a recording.
 *
 * Every frame is a picture of the moment `offsetMs` into the recording, and every one of them goes
 * back in the reply: what consumes it is a model, and a sample of a sample is how the one moment
 * that mattered gets dropped. `--out` is the only thing that decides whether they are also files.
 */
export async function runVideoCommand(ctx: ToolCommandContext): Promise<BrowserCommandResult | null> {
  const { fns, parts, cmd, workspaceRootPath, queryLlm } = ctx;

  if (cmd === 'understand') {
    const path = parts[1];
    if (!path || path.startsWith('--')) {
      throw new Error('Which recording? "understand <path> --prompt <question>" — the video to read.');
    }

    const promptAt = parts.indexOf('--prompt');
    const question = promptAt >= 0 ? parts[promptAt + 1] : undefined;
    if (promptAt < 0) {
      throw new Error('What should be asked about it? Example: understand demo.mp4 --prompt "what happened?"');
    }
    if (!question || question.startsWith('--')) {
      throw new Error('--prompt needs the question. Example: understand demo.mp4 --prompt "what happened?"');
    }

    const modelAt = parts.indexOf('--model');
    const model = modelAt >= 0 ? parts[modelAt + 1] : undefined;
    if (modelAt >= 0 && (!model || model.startsWith('--'))) {
      throw new Error('--model needs a model id. Example: understand demo.mp4 --prompt "…" --model haiku');
    }

    const outAt = parts.indexOf('--out');
    const namedOut = outAt >= 0 ? parts[outAt + 1] : undefined;
    if (outAt >= 0 && (!namedOut || namedOut.startsWith('--'))) {
      throw new Error('--out needs a directory. Example: understand demo.mp4 --prompt "…" --out research/demo');
    }

    // The one thing this command cannot do without, and the failure that has to name its remedy:
    // the frames are useless to a door with no model behind it, and "sample" is what still works.
    if (!queryLlm) {
      throw new Error(
        'No model is configured for this conversation, so a recording cannot be read. ' +
        '"sample" still works — it hands you the frames themselves.',
      );
    }

    const result = await fns.sampleVideo({
      path: resolveLocalPath(path, workspaceRootPath),
      out: namedOut ? resolveLocalPath(namedOut, workspaceRootPath) : undefined,
      mode: parts.includes('--changes') ? 'changes' : 'timeline',
      everyMs: durationOption(parts, '--every', DEFAULT_EVERY_MS),
      maxFrames: numberOption(parts, '--max', DEFAULT_MAX_FRAMES, 1, 1000),
      changeThreshold: thresholdOption(parts),
      // `--from 0` and no `--from` mean the same thing, so a plain duration option is enough.
      fromMs: durationOption(parts, '--from', 0),
      // `--to` is the one that has to stay absent when it is absent: "to the end" is not a number.
      ...(optionalDurationOption(parts, '--to') !== undefined
        ? { toMs: optionalDurationOption(parts, '--to') }
        : {}),
      first: parts.includes('--first'),
      last: parts.includes('--last'),
      // This is the one command whose frames are **paid for** — they go to a model, per image —
      // so it is the one with a default edge worth stating. `OPTIMAL_EDGE` is the app's own
      // "big enough to read, small enough to pay for" number, and it is what an image
      // attachment is scaled to as well. Stating it also keeps the frames legible: a
      // recording of a large screen is otherwise mostly bytes the model discards.
      // Said explicitly — `--max-edge 0` included — it is left exactly as asked.
      maxEdge: parts.includes('--max-edge')
        ? numberOption(parts, '--max-edge', 0, 0, 4096)
        : IMAGE_LIMITS.OPTIMAL_EDGE,
    });

    const frames = result.frames;
    if (frames.length === 0) {
      throw new Error(`Nothing was decoded out of ${path}, so there is nothing to read.`);
    }

    const offsets = frames.map((frame) => frame.offsetMs);
    const answer = await queryLlm({
      prompt: buildUnderstandPrompt(question, offsets, result.durationMs),
      images: frames.map((frame) => ({
        data: Buffer.from(frame.bytes).toString('base64'),
        mimeType: 'image/jpeg' as const,
        timestampMs: frame.offsetMs,
      })),
      model,
    });

    const lines = [
      `Read ${path} (${Math.round(result.durationMs / 1000)}s, ${frames.length} frame${frames.length === 1 ? '' : 's'})` +
        (namedOut ? ` into ${namedOut}` : ' — no files written:'),
      `Frames at: ${offsets.map((ms) => `+${ms}ms`).join(', ')}`,
      '',
      answer.text || '(the model returned nothing)',
    ];
    if (!parts.includes('--changes')) {
      const widened = widenedNote(offsets, durationOption(parts, '--every', DEFAULT_EVERY_MS));
      if (widened) lines.push('', widened);
    }
    if (result.truncated) {
      lines.push(
        '',
        'More moments moved here than the ceiling holds, so the later part of the recording was not',
        'examined. Raise "--max", or read it in windows with "--from"/"--to".',
      );
    }
    if (answer.warning) {
      lines.push('', `[Partial answer — ${answer.warning}]`);
    }
    if (namedOut) {
      frames.forEach((_, index) => lines.push(`  • ${frameFileName(index + 1)}  @ ${offsets[index]}ms`));
    }

    return { output: lines.join('\n'), appendReleaseHint: false };
  }

  if (cmd === 'sample') {
    const path = parts[1];
    if (!path || path.startsWith('--')) {
      throw new Error('Which recording? "sample <path>" — the video to sample frames out of.');
    }

    const outAt = parts.indexOf('--out');
    const namedOut = outAt >= 0 ? parts[outAt + 1] : undefined;
    if (outAt >= 0 && (!namedOut || namedOut.startsWith('--'))) {
      throw new Error('--out needs a directory. Example: sample demo.mp4 --out research/demo');
    }

    const result = await fns.sampleVideo({
      path: resolveLocalPath(path, workspaceRootPath),
      out: namedOut ? resolveLocalPath(namedOut, workspaceRootPath) : undefined,
      mode: parts.includes('--changes') ? 'changes' : 'timeline',
      everyMs: durationOption(parts, '--every', DEFAULT_EVERY_MS),
      maxFrames: numberOption(parts, '--max', DEFAULT_MAX_FRAMES, 1, 1000),
      changeThreshold: thresholdOption(parts),
      // `--from 0` and no `--from` mean the same thing, so a plain duration option is enough.
      fromMs: durationOption(parts, '--from', 0),
      // `--to` is the one that has to stay absent when it is absent: "to the end" is not a number.
      ...(optionalDurationOption(parts, '--to') !== undefined
        ? { toMs: optionalDurationOption(parts, '--to') }
        : {}),
      first: parts.includes('--first'),
      last: parts.includes('--last'),
      // `sample` writes the frames for someone to look at, so the recording's own size is the
      // answer and `0` — "no scaling" — is what leaving it out means. The sampler's own guard
      // (`maxEdge > 0`) carries the absence — no second convention needed. That `0` is also why
      // the sampling door must not clamp it *up*: a floor turns "no scaling" into a 16px frame.
      maxEdge: numberOption(parts, '--max-edge', 0, 0, 4096),
    });

    const frames = result.frames;
    const lines = [
      `Sampled ${frames.length} frame${frames.length === 1 ? '' : 's'} out of ${path} ` +
        `(${Math.round(result.durationMs / 1000)}s long)` +
        (namedOut ? ` into ${namedOut}, as:` : ' — no files written:'),
    ];
    // Every frame's position in the recording, which is the coordinate a reader of a recording can
    // use ("at 0:12 the total moves") — a wall of images with no offsets is a wall of images.
    frames.forEach((frame, index) => {
      lines.push(`  • ${frameFileName(index + 1)}  @ ${frame.offsetMs}ms`);
    });
    if (!parts.includes('--changes')) {
      const widened = widenedNote(frames.map((frame) => frame.offsetMs), durationOption(parts, '--every', DEFAULT_EVERY_MS));
      if (widened) lines.push(widened);
    }
    if (result.truncated) {
      lines.push('More moments moved here than the ceiling holds, so the later part of the recording was not examined.');
    }
    if (!namedOut) {
      lines.push(
        'Nothing was written to disk — these frames are the reply. Run it again with "--out <dir>" to',
        'keep them as files.',
      );
    }

    // The frames go back with the reply, whether or not they were kept: the files are the record,
    // and a model reads pictures rather than a list of paths.
    const images: BrowserCommandImage[] = frames.map((frame) => ({
      data: Buffer.from(frame.bytes).toString('base64'),
      mimeType: 'image/jpeg' as const,
      sizeBytes: frame.bytes.length,
      ...(frame.path ? { path: frame.path } : {}),
    }));

    return { output: lines.join('\n'), appendReleaseHint: false, images };
  }

  return null;
}
