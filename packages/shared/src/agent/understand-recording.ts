/**
 * `recording_tool understand` — one answer about a recording, however this person is set up.
 *
 * The agent states an intent and two knobs; the route is resolved here from what is configured:
 * a short clip may go to an omni model whole, a longer one as frames plus compressed sound, and
 * without an omni model the same question can be answered from a transcript and/or frames. The
 * primitives (`probe` / `frames` / `audio`) stay local; this file is the one place that composes
 * them and spends money.
 */

import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readFileSync, statSync, unlinkSync } from 'node:fs'
import type { BrowserCommandResult } from './command-cli.ts'
import type { BrowserPaneFns } from './browser-pane.ts'
import { encodeWavFileToMp3 } from '../media/mp3.ts'
import {
  askOmniModel,
  askWorkspaceModel,
  OMNI_MAX_AUDIO_BYTES,
  OMNI_MAX_VIDEO_BYTES,
  understandCapabilities,
  type UnderstandCapabilities,
} from '../media/workspace-model.ts'

export type UnderstandMode =
  | 'auto'
  | 'video'
  | 'frames-audio'
  | 'audio'
  | 'frames'
  | 'transcript'
  | 'transcript-frames'

export interface UnderstandFacts {
  hasPicture: boolean
  hasAudio: boolean
  durationMs: number
  bytes: number
}

/** A short clip is worth sending whole; longer ones go as frames + compressed sound. */
const VIDEO_MAX_MS = 150_000
/** The same ceiling the omni wire enforces (a Qwen base64 string stops at 10 MB). */
const VIDEO_MAX_BYTES = OMNI_MAX_VIDEO_BYTES

const DEFAULT_FRAMES = 4
const MAX_FRAMES = 12
export const DEFAULT_UNDERSTAND_FRAMES = DEFAULT_FRAMES
export const MAX_UNDERSTAND_FRAMES = MAX_FRAMES
const UNDERSTAND_MAX_MS = 30 * 60_000
/** Same ceiling as the wire: 32 kbps MP3 at 30 minutes is ≈ 7.2 MB, just under it. */
const UNDERSTAND_MAX_AUDIO_BYTES = OMNI_MAX_AUDIO_BYTES

/**
 * Which route `understand` takes.
 *
 * `auto` prefers the least lossy route the settings allow: a short video whole, then sound with
 * frames, then one modality, then the transcript routes. An explicit mode is refused rather than
 * silently replaced, because it was asked for by name.
 */
export function chooseUnderstandStrategy(
  requested: UnderstandMode,
  facts: UnderstandFacts,
  capabilities: UnderstandCapabilities,
): UnderstandMode | null {
  const possible: Record<Exclude<UnderstandMode, 'auto'>, boolean> = {
    video:
      capabilities.omni &&
      facts.hasPicture &&
      facts.hasAudio &&
      facts.durationMs <= VIDEO_MAX_MS &&
      facts.bytes <= VIDEO_MAX_BYTES,
    'frames-audio': capabilities.omni && facts.hasPicture && facts.hasAudio,
    audio: capabilities.omni && facts.hasAudio,
    // A picture question belongs to the vision chain; omni means "reads sound and video".
    frames: facts.hasPicture && capabilities.vision,
    'transcript-frames': facts.hasPicture && facts.hasAudio && capabilities.asr && capabilities.vision,
    // The words alone need no picture and no sound: any text model can answer this one.
    transcript: facts.hasAudio && capabilities.asr,
  }
  if (requested !== 'auto') return possible[requested] ? requested : null

  const order = ['video', 'frames-audio', 'audio', 'transcript-frames', 'frames', 'transcript'] as const
  return order.find((mode) => possible[mode]) ?? null
}

export interface UnderstandRecordingOptions {
  path: string
  prompt: string
  /** `undefined` means four frames when there is a picture. */
  frames?: number
  /** `auto` by default; an explicit route is refused when its requirements are unmet. */
  mode?: UnderstandMode
  /** `false` ignores the soundtrack (picture-only understanding). */
  audio?: boolean
  sessionId?: string
  workspaceRootPath?: string
  projectId?: string
  sessionWorkingDirectory?: string
  fns: Pick<BrowserPaneFns, 'sampleVideo' | 'extractAudio'>
  fetchImpl?: typeof fetch
  /** Injected by a test; production reads the person's settings. */
  capabilities?: UnderstandCapabilities
  ask?: typeof askOmniModel
  askText?: typeof askWorkspaceModel
  transcribe?: (path: string) => Promise<string>
}

interface Frame {
  offsetMs: number
  dataUrl: string
}

function durationText(ms: number): string {
  const seconds = ms / 1000
  if (seconds < 60) return `${Number(seconds.toFixed(1))}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Number((seconds - minutes * 60).toFixed(1))
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`
}

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** The sentence a person can act on when no route is possible. */
function missingHint(
  requested: UnderstandMode,
  capabilities: UnderstandCapabilities,
  hasPicture: boolean,
  hasAudio: boolean,
): string {
  if (requested !== 'auto') return `模式「${requested}」在当前设置/文件下不可用。`
  if (!hasPicture && !hasAudio) return '这个文件没有可读的画面或声音。'
  const parts: string[] = []
  if (hasPicture && !capabilities.vision) {
    parts.push('在 设置 → 模型 → 连接 里指定 Vision model（读画面；omni 的角色是听声音）')
  }
  if (hasAudio && !capabilities.omni && !capabilities.asr) {
    parts.push('指定 Omni model（听声音）或配置语音转写（设置 → 语音转写）')
  }
  return `${parts.length ? parts.join('，') : '在 设置 → 模型 里配置一个可用的模型'}后重试。`
}

/** A transcript through whatever recognition the person configured. */
async function transcribeWithSettings(options: UnderstandRecordingOptions): Promise<string> {
  if (options.transcribe) return options.transcribe(options.path)
  const { executeAsrToolCommand } = await import('./asr-commands.ts')
  const result = await executeAsrToolCommand({
    command: ['transcribe', options.path],
    sessionId: options.sessionId ?? '',
    ...(options.workspaceRootPath ? { workspaceRootPath: options.workspaceRootPath } : {}),
    ...(options.projectId ? { projectId: options.projectId } : {}),
    ...(options.sessionWorkingDirectory ? { sessionWorkingDirectory: options.sessionWorkingDirectory } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  })
  const output = result.output.trim()
  if (output.startsWith('Error:')) throw new Error(output.replace(/^Error:\s*/, ''))
  return output
}

/**
 * One answer about a recording.
 *
 * Facts first (probe, then the compressed soundtrack), then a route from the settings, then at
 * most one request per route. A `video` request the provider refuses for its shape falls back to
 * frames + sound once, and says so in the reply.
 */
export async function understandRecording(options: UnderstandRecordingOptions): Promise<BrowserCommandResult> {
  const probe = await options.fns.sampleVideo({
    path: options.path,
    probeOnly: true,
    mode: 'timeline',
    everyMs: 1_000,
    maxFrames: 1,
  })

  if (probe.durationMs > UNDERSTAND_MAX_MS) {
    return {
      output:
        `Error: 这段录像 ${durationText(probe.durationMs)}，超过 understand 的 30 分钟上限：` +
        '先剪一段，或用 `recording_tool audio` + 分段提问。',
      appendReleaseHint: true,
    }
  }

  const hasPicture = Boolean(probe.viewport)
  const frameCount = hasPicture ? Math.min(MAX_FRAMES, Math.max(0, options.frames ?? DEFAULT_FRAMES)) : 0

  // The soundtrack is compressed before the route is chosen: whether it exists decides the route.
  const wav = join(tmpdir(), `craft-understand-${process.pid}-${Date.now()}.wav`)
  let audio: { bytes: Uint8Array; durationMs: number } | null = null
  if (options.audio !== false) {
    try {
      await options.fns.extractAudio({ path: options.path, out: wav })
      audio = await encodeWavFileToMp3(wav, 32)
    } catch {
      audio = null
    } finally {
      try {
        unlinkSync(wav)
      } catch {
        // A leftover temp file is not a failed answer.
      }
    }
  }

  if (audio && audio.bytes.length > UNDERSTAND_MAX_AUDIO_BYTES) {
    return {
      output:
        `Error: 音轨压成 MP3 后仍有 ${megabytes(audio.bytes.length)}，超过单次请求的 ` +
        `${megabytes(UNDERSTAND_MAX_AUDIO_BYTES)}：先剪短，或分段提问。`,
      appendReleaseHint: true,
    }
  }

  let bytes = 0
  try {
    bytes = statSync(options.path).size
  } catch {
    bytes = 0
  }

  const capabilities = options.capabilities ?? understandCapabilities()
  const requested = options.mode ?? 'auto'
  let strategy = chooseUnderstandStrategy(
    requested,
    { hasPicture, hasAudio: audio !== null, durationMs: probe.durationMs, bytes },
    capabilities,
  )
  if (!strategy) {
    return {
      output: `Error: ${missingHint(requested, capabilities, hasPicture, audio !== null)}`,
      appendReleaseHint: true,
    }
  }

  let frames: Frame[] = []
  const loadFrames = async (): Promise<Frame[]> => {
    if (!frames.length && frameCount > 0) {
      const sampled = await options.fns.sampleVideo({
        path: options.path,
        mode: 'timeline',
        everyMs: Math.max(1_000, Math.round(probe.durationMs / frameCount)),
        maxFrames: frameCount,
      })
      frames = sampled.frames.slice(0, frameCount).map((frame) => ({
        offsetMs: frame.offsetMs,
        dataUrl: `data:image/jpeg;base64,${Buffer.from(frame.bytes).toString('base64')}`,
      }))
    }
    return frames
  }

  /** Whether this route really carries the soundtrack — an explicit `frames` run does not. */
  const sendsAudio = (): boolean => strategy !== 'frames' && audio !== null

  const instruction = (extra?: string): string =>
    [
      options.prompt,
      '',
      `The recording is ${durationText(probe.durationMs)} long.`,
      ...(frames.length
        ? [`Frames, in time order: ${frames.map((frame) => `${(frame.offsetMs / 1000).toFixed(1)}s`).join(', ')}.`]
        : []),
      ...(sendsAudio() ? ['Its whole soundtrack is attached as one audio file.'] : []),
      ...(extra ? ['', extra] : []),
    ].join('\n')

  const done = (text: string, model: string | undefined, via: UnderstandMode): BrowserCommandResult => {
    const facts = [
      ...(via !== 'video' && audio && sendsAudio() ? [`heard ${durationText(audio.durationMs)}`] : []),
      ...(frames.length ? [`looked at ${frames.length} frame${frames.length === 1 ? '' : 's'}`] : []),
      `via ${via}`,
      ...(model ? [`model ${model}`] : []),
    ]
    return { output: `${text}\n\n— ${facts.join(', ')}.`, appendReleaseHint: false }
  }

  const failed = (message: string | undefined): BrowserCommandResult => ({
    output: `Error: ${message ?? '模型没有给出答案。'}`,
    appendReleaseHint: true,
  })

  const ask = options.ask ?? askOmniModel
  const askText = options.askText ?? askWorkspaceModel

  if (strategy === 'video') {
    const format = options.path.split('.').pop()?.toLowerCase() || 'mp4'
    const answer = await ask({
      instruction: instruction(),
      video: { data: new Uint8Array(readFileSync(options.path)), format },
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    })
    if (answer.ok) return done(answer.text!, answer.model, 'video')
    // A provider that will not take a video in the body is worth one fallback, not a retry loop.
    if (!/HTTP 4\d\d/.test(answer.message ?? '')) return failed(answer.message)
    strategy = 'frames-audio'
    await loadFrames()
  }

  if (strategy === 'frames') {
    await loadFrames()
    const images = frames.map((frame) => frame.dataUrl)
    if (!images.length) {
      return {
        output: 'Error: 没能从这段录像里取到画面，没法提问。',
        appendReleaseHint: true,
      }
    }
    // Pictures without sound are a vision job. The omni role is for listening, so it never reads
    // frames here: a person who wants it to read pictures names it as `visionModel` too.
    const answer = await askText({
      instruction: instruction(),
      images,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    })
    return answer.ok ? done(answer.text!, answer.model, strategy) : failed(answer.message)
  }

  if (strategy === 'frames-audio' || strategy === 'audio') {
    if (strategy !== 'audio') await loadFrames()
    const images = frames.map((frame) => frame.dataUrl)
    const answer = await ask({
      instruction: instruction(),
      ...(images.length ? { images } : {}),
      ...(audio ? { audio: { data: audio.bytes, format: 'mp3' as const } } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    })
    return answer.ok ? done(answer.text!, answer.model, strategy) : failed(answer.message)
  }

  let transcript: string
  try {
    transcript = await transcribeWithSettings(options)
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error))
  }
  if (strategy === 'transcript-frames') await loadFrames()
  const answer = await askText({
    instruction: instruction(`Transcript:\n${transcript}`),
    ...(frames.length ? { images: frames.map((frame) => frame.dataUrl) } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  })
  return answer.ok ? done(answer.text!, answer.model, strategy) : failed(answer.message)
}
