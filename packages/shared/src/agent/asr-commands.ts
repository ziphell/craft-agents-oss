/**
 * `asr_tool` — one door for reading a recording into words.
 *
 * The person chooses where recognition happens (`Settings › Speech`): on this machine through the
 * bundled `asr-tool`, or through a cloud provider with its own key. This door follows that choice
 * and never picks the other side on its own — uploading a recording is a decision, not a fallback.
 * When the chosen side cannot run, the answer names the side and the reason.
 *
 * Speaking text into a file is not here: synthesis costs an account, so it lives behind
 * `media_tool generate --kind tts` with the rest of the account work.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  asrCloudChannel,
  asrCloudProvider,
  MediaFailure,
  mimeOfFile,
  readAsrCloudSecret,
  readAsrConfig,
  srtOf,
  transcribeDoubaoOverApi,
  transcribeOpenAiOverApi,
  type AsrConfig,
  type AsrResult,
} from '../media/index.ts'
import { runBundledCliTool } from '../media/local-cli.ts'
import {
  resolveContentRoots,
  resolveFilePath,
  type ContentRoots,
} from './content-paths.ts'
import { tokenizeCommand, type BrowserCommandResult } from './command-cli.ts'

const say = (output: string, failed = false): BrowserCommandResult => ({
  output: failed ? `Error: ${output}` : output,
  appendReleaseHint: failed,
})

const valueOf = (tokens: string[], flag: string): string | undefined => {
  const index = tokens.indexOf(flag)
  return index >= 0 ? tokens[index + 1] : undefined
}

const positionalAfter = (tokens: string[], command: string): string[] => {
  const index = tokens.indexOf(command)
  const rest = index >= 0 ? tokens.slice(index + 1) : tokens
  const values: string[] = []
  for (let cursor = 0; cursor < rest.length; cursor += 1) {
    const token = rest[cursor]!
    if (token.startsWith('--')) {
      cursor += 1
      continue
    }
    values.push(token)
  }
  return values
}

export function asrHelp(): string {
  return `Read an audio file into words.

\`transcribe <audio> [--out <path>] [--format text|srt|json] [--language auto|zh|en|ja|ko|yue]\`

\`transcribe\` prints the words; \`--out\` writes them (.txt, .md, .srt or .json — the name decides,
and \`--format\` overrides it). Without \`--out\` the reply is text by default, or SRT/JSON when
\`--format\` asks for it.

wav and mp3 are read everywhere; other containers only where this machine's side can decode them
(the local engine reads m4a/flac/ogg with ffmpeg on PATH; cloud recognition reads wav/mp3/ogg).
A video is not audio: take its sound out first with \`recording_tool audio <file> --out words.wav\`.`
}

function rootsOf(args: {
  workspaceRootPath?: string
  sessionId?: string
  sessionWorkingDirectory?: string
  projectId?: string
  getSessionInfo?: () => { projectId?: string; workingDirectory?: string } | null
}): { roots: ContentRoots } | { error: string } {
  const info = args.getSessionInfo?.()
  const resolved = resolveContentRoots({
    sessionId: args.sessionId,
    workspaceRootPath: args.workspaceRootPath,
    projectId: args.projectId ?? info?.projectId,
    workingDirectory: args.sessionWorkingDirectory ?? info?.workingDirectory,
  })
  return resolved.ok ? { roots: resolved.roots } : { error: resolved.error }
}

/** The container the recognition API names, or null when it cannot read this file. */
function asrAudioFormatOf(path: string): string | null {
  const extension = path.split('.').pop()?.toLowerCase() ?? ''
  if (extension === 'wav') return 'wav'
  if (extension === 'mp3') return 'mp3'
  if (extension === 'ogg' || extension === 'opus') return 'ogg'
  return null
}

/** What `--out` asks for: its extension, unless `--format` says otherwise. */
function transcriptFormat(outPath: string, format?: string): 'text' | 'srt' | 'json' {
  const named = format?.trim().toLowerCase()
  if (named === 'srt' || named === 'json' || named === 'text') return named
  const extension = outPath.split('.').pop()?.toLowerCase()
  if (extension === 'srt') return 'srt'
  if (extension === 'json') return 'json'
  return 'text'
}

/**
 * The one JSON envelope both routes answer with.
 *
 * Local and cloud sentences are the same fact — a span and its words — so they are the same shape
 * and the same unit (milliseconds). A caller never needs to ask which side produced it.
 */
function transcriptJson(result: AsrResult, facts: { channel: string; model?: string }): string {
  return JSON.stringify(
    {
      ok: true,
      text: result.text,
      utterances: result.utterances,
      ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
      ...(facts.model ? { model: facts.model } : {}),
      channel: facts.channel,
      via: result.via,
    },
    null,
    2,
  )
}

/** The transcript as the caller asked for it: plain words, cues, or the provider's own answer. */
function writeTranscript(
  path: string,
  result: AsrResult,
  format: 'text' | 'srt' | 'json',
  facts: { channel: string; model?: string },
): string {
  mkdirSync(dirname(path), { recursive: true })
  const body =
    format === 'srt'
      ? srtOf(result)
      : format === 'json'
        ? transcriptJson(result, facts)
        : result.text
  writeFileSync(path, `${body}\n`)
  return `Wrote ${path} — ${result.text.length} characters, ${format} · ${facts.channel}.`
}

export interface AsrCommandArgs {
  command: string | string[]
  workspaceRootPath?: string | undefined
  sessionId?: string | undefined
  sessionWorkingDirectory?: string | undefined
  projectId?: string | undefined
  getSessionInfo?: (() => { projectId?: string; workingDirectory?: string } | null) | undefined
  fetchImpl?: typeof fetch
  /** Injected by a test, so a run does not depend on the machine's `asr.json`. */
  config?: AsrConfig
  /** Injected by a test: the key for the chosen provider. `null` means "there is none". */
  cloudKey?: string | null
}

export async function executeAsrToolCommand(args: AsrCommandArgs): Promise<BrowserCommandResult> {
  const tokens = Array.isArray(args.command) ? args.command : tokenizeCommand(args.command ?? '')
  const command = tokens[0]?.toLowerCase()
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    return say(asrHelp())
  }

  const config = args.config ?? readAsrConfig().config
  const keyOf = async (provider: NonNullable<ReturnType<typeof asrCloudProvider>>) =>
    args.cloudKey !== undefined ? args.cloudKey : readAsrCloudSecret(provider.id)

  const resolvedRoots = rootsOf(args)
  if ('error' in resolvedRoots) return say(resolvedRoots.error, true)
  const roots = resolvedRoots.roots

  if (command === 'transcribe') {
    const inputRaw = positionalAfter(tokens, 'transcribe')[0]
    if (!inputRaw) return say('transcribe needs a recording: transcribe <file> [--out <path>].', true)
    const input = resolveFilePath(inputRaw, roots)
    if (!input.ok) return say(input.error, true)
    if (!existsSync(input.path)) return say(`No file at ${input.path}.`, true)

    const outRaw = valueOf(tokens, '--out')
    const out = outRaw ? resolveFilePath(outRaw, roots) : null
    if (out && !out.ok) return say(out.error, true)
    // What a transcript can be written as. The name is the contract, not a suggestion: a file this
    // door cannot format is refused rather than filled with words under a name that promises
    // something else.
    if (out?.ok) {
      const extension = out.path.split('.').pop()?.toLowerCase()
      if (extension !== 'txt' && extension !== 'md' && extension !== 'srt' && extension !== 'json') {
        return say('--out must name a .txt, .md, .srt or .json file.', true)
      }
    }
    const format = valueOf(tokens, '--format')
    const namedFormat = format?.trim().toLowerCase()
    if (namedFormat && namedFormat !== 'text' && namedFormat !== 'srt' && namedFormat !== 'json') {
      return say('--format must be text, srt or json.', true)
    }
    // Cloud recognition falls back to the language saved in Settings; the flag wins when given.
    const language =
      valueOf(tokens, '--language') ?? (config.mode === 'cloud' ? config.cloud.language : undefined)

    if (config.mode === 'local') {
      const run = await runBundledCliTool(
        'asr-tool',
        [
          'transcribe',
          input.path,
          ...(out && out.ok ? ['--out', out.path] : []),
          // `--format` decides the reply too: text by default, JSON on request.
          ...(format ? ['--format', format] : []),
          ...(language ? ['--language', language] : []),
        ],
        { cwd: roots.contentRoot },
      )
      if (!run.ok) return say(run.message ?? run.stderr.trim() ?? 'Speech recognition failed.', true)
      return say(run.stdout.trim() || (out && out.ok ? `Wrote ${out.path}` : run.stderr.trim()))
    }

    const provider = asrCloudProvider(config.cloud.provider)
    if (!provider) {
      return say(
        '语音识别被设成云端，却没有配置服务商。请在设置 › 语音 › 语音识别里保存一次，或改成本地。',
        true,
      )
    }
    const ready = asrCloudChannel(config, (await keyOf(provider)) ?? undefined)
    if (!ready) {
      return say(`「${provider.name}」的识别接入方式不可用：改成本地，或重新保存一次设置。`, true)
    }
    const apiKey = ready.apiKey?.trim() ?? ''
    // A server on this machine usually has no key; the hosted wire always needs one.
    if (!apiKey && ready.id !== 'openai') {
      return say(
        `云端识别还没有密钥：在设置 › 语音 › 语音识别里为「${provider.name}」填一次。`,
        true,
      )
    }

    const answer = (result: AsrResult) => {
      const facts = { channel: provider.name, model: ready.model }
      if (out && out.ok) {
        return say(writeTranscript(out.path, result, transcriptFormat(out.path, format), facts))
      }
      if (result.silent) return say('No speech was detected in that recording.')
      // Without a file the reply is still the caller's choice: text by default, JSON or SRT on
      // request. Subtitles are text, so they need no file to be returned.
      const wanted = transcriptFormat('', format)
      if (wanted === 'srt') return say(srtOf(result))
      if (wanted === 'json') return say(transcriptJson(result, facts))
      return say(result.text)
    }

    try {
      // An OpenAI-compatible server takes the file in the request and owns its model list.
      if (ready.id === 'openai') {
        const result = await transcribeOpenAiOverApi({
          baseUrl: ready.baseUrl,
          apiKey,
          model: ready.model,
          ...(ready.auth ? { auth: ready.auth } : {}),
          ...(ready.submitPath ? { submitPath: ready.submitPath } : {}),
          ...(language && language !== 'auto' ? { language } : {}),
          fileName: input.path.split(/[\\/]/).pop() ?? 'recording',
          bytes: new Uint8Array(readFileSync(input.path)),
          mimeType: mimeOfFile(input.path),
          ...(args.fetchImpl ? { fetch: args.fetchImpl } : {}),
        })
        return answer(result)
      }

      // The flash endpoint reads the container from the bytes, but only these three are offered.
      if (!asrAudioFormatOf(input.path)) {
        return say(
          `云端识别只接受 wav / mp3 / ogg，${input.path} 不是其中之一。先用 \`recording_tool audio\`` +
            ' 转成 wav，或把语音识别改成本地。',
          true,
        )
      }
      const result = await transcribeDoubaoOverApi({
        baseUrl: ready.baseUrl,
        apiKey,
        // The resource id is this API's model, and `auc_turbo` is what the flash endpoint accepts.
        model: ready.model,
        ...(ready.auth ? { auth: ready.auth } : {}),
        ...(ready.submitPath ? { submitPath: ready.submitPath } : {}),
        bytes: new Uint8Array(readFileSync(input.path)),
        // `auto` is the absence of a hint; the adapter names Chinese apart and passes the rest as-is.
        ...(language && language !== 'auto' ? { language } : {}),
        ...(args.fetchImpl ? { fetch: args.fetchImpl } : {}),
      })
      return answer(result)
    } catch (error) {
      if (error instanceof MediaFailure) return say(error.message, true)
      return say(`云端识别失败：${error instanceof Error ? error.message : String(error)}`, true)
    }
  }

  return say(`Unknown command "${tokens[0]}". Commands: transcribe. \`help\` prints every flag.`, true)
}
