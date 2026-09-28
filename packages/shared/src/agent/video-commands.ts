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

/** One frame every 2 s, at most 40 of them — the defaults a capture has always had. */
const DEFAULT_EVERY_MS = 2_000;
const DEFAULT_MAX_FRAMES = 40;

/** `frame-0001.jpg` — index first, so a plain `ls` is already in order. */
export function frameFileName(index: number): string {
  return `frame-${String(index).padStart(4, '0')}.jpg`;
}

/**
 * `video_tool --help`.
 *
 * Written the way the tool's own description is: what `sample` does with a recording, that the
 * frames come back as images, and the one flag that decides whether they are also kept as files.
 */
export function getVideoToolHelp(): string {
  return [
    'video_tool command help',
    '',
    'Usage (one command per call — no batching):',
    '  --help',
    '  sample <path> [--out <dir>] [--every <dur>] [--changes] [--max <n>]',
    '                                                 frames out of a recording, decoded by Chromium',
    '',
    'A recording is not something you can watch, so "what happened in this screen recording" has no',
    'answer until it is frames. "sample" makes them, and they come back as images. The decoding is',
    'Chromium\'s — the browser the app already ships, in a hidden window of its own — so there is no',
    'ffmpeg to install and no window of yours involved. mp4 (H.264), webm and most mov files read; a',
    'HEVC, ProRes or otherwise unsupported recording is refused by name instead of half-read.',
    '',
    '<path> is the recording; a relative path counts from the workspace root. The default samples on',
    'a timeline: one frame every 2000 ms, at most 40 frames.',
    '  --every <dur>    how far apart the samples are (500ms, 2s, 1m)',
    '  --changes        keep only the frames that moved',
    '  --max <n>        the ceiling on frames',
    '  --out <dir>      write the frames there as frame-0001.jpg, frame-0002.jpg, … and name the',
    '                   files in the reply. Omitted, nothing is written — the frames are the reply,',
    '                   and a second run with "--out" is how files to keep are made.',
    '',
    'Examples:',
    '  sample ~/Desktop/demo.mp4',
    '  sample demo.mp4 --out research/demo --every 500ms',
    '  sample demo.mp4 --changes --max 20',
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
 * Frames out of a recording.
 *
 * Every frame is a picture of the moment `offsetMs` into the recording, and every one of them goes
 * back in the reply: what consumes it is a model, and a sample of a sample is how the one moment
 * that mattered gets dropped. `--out` is the only thing that decides whether they are also files.
 */
export async function runVideoCommand(ctx: ToolCommandContext): Promise<BrowserCommandResult | null> {
  const { fns, parts, cmd, workspaceRootPath } = ctx;

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
      maxFrames: numberOption(parts, '--max', DEFAULT_MAX_FRAMES, 1, 400),
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
    if (result.truncated) {
      lines.push('The sampling hit its frame ceiling, so this is a sample of the recording.');
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
