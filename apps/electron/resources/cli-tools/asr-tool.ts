/**
 * `asr-tool transcribe` — a recording on this machine, as words.
 *
 * This is the **local engine**, not the agent's door: `asr_tool` decides whether recognition runs
 * here or in the cloud, and runs this command when the person chose this machine. It is a separate
 * process because decoding is CPU-bound and must not block the app that is also drawing the screen.
 *
 * `transcribe` prints the words. `--out` writes them where it is asked to — markdown-ish plain text,
 * SRT subtitles, or the JSON answer with per-cue timings.
 *
 * Settings live in `~/.craft-agent/asr.json` (model directory, model, language). The model is a
 * machine-level choice, not a per-call one: two local models differ in what they were trained on,
 * not in what this recording needs, so the settings page decides and this tool does not offer a
 * flag that could disagree with it. `--language` is the exception — that is a property of the
 * recording in hand.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fail, flag, parseArgs, text } from './args'
import {
  readAsrConfig,
  transcribeWithLocalSherpa,
  MediaFailure,
} from '@craft-agent/shared/media'

const USAGE = `Usage:
  asr-tool transcribe <file> [--out <path>] [--format text|json|srt]
                               [--language auto|zh|en|ja|ko|yue]

Speech to text on this machine (sherpa-onnx). No account and no network.

WAV and MP3 are read directly (MP3 is decoded in-process). m4a/aac, flac and ogg need ffmpeg on PATH.

transcribe  Prints the words. --out writes them: a .srt name gives subtitles, .json the full
            answer (text, per-cue timings, model, whether silence split the file), and .txt
            or .md the plain words. --format overrides what the name suggests. Without --out the
            reply is text by default, or JSON/SRT when --format asks for it.

This is the local engine behind \`asr_tool\`: the agent uses that door, which follows the person's
choice of this machine or a cloud provider. The model is chosen in Settings › AI › Speech to text,
not per call. The directory defaults to ~/.craft-agent/models (CRAFT_SHERPA_MODEL_DIR wins); put a
SenseVoice model folder there, e.g. sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.`

/** A usage mistake is exit 2, so a caller can tell "you asked wrongly" from "the run failed". */
function usageFail(message: string): never {
  process.stderr.write(`${message}\n\n${USAGE}\n`)
  process.exit(2)
}

interface Answer {
  ok: boolean
  text?: string
  /** The same shape the cloud side answers with: the sentence timings, in milliseconds. */
  utterances?: Array<{ startMs: number; endMs: number; text: string }>
  durationMs?: number
  model?: string
  channel?: string
  vad?: boolean
}

/**
 * The VAD model that ships beside this bundle (`dist/models/silero_vad.onnx`).
 *
 * `local-sherpa` already looks for a bundled model through the app's asset roots, which do not
 * exist for a tool a shell started. Naming the file here — only when the person has not named a
 * different one — is how the bundled copy is found from any working directory.
 */
function useStagedVad(): void {
  if (process.env.CRAFT_SHERPA_VAD_MODEL?.trim()) return
  const staged = join(import.meta.dir, 'models', 'silero_vad.onnx')
  if (existsSync(staged)) process.env.CRAFT_SHERPA_VAD_MODEL = staged
}

/** Reject a flag this command does not have, rather than silently ignoring it. */
function onlyFlags(parsed: { flags: Record<string, string | true> }, allowed: readonly string[]): void {
  for (const key of Object.keys(parsed.flags)) {
    if (!allowed.includes(key)) {
      usageFail(`Unknown flag --${key}. The model and model directory are settings, not flags.`)
    }
  }
}

async function transcribe(argv: readonly string[]): Promise<void> {
  const parsed = parseArgs(argv, new Set(['json']))
  onlyFlags(parsed, ['format', 'out', 'language', 'json'])
  const file = parsed.positional[0]
  if (!file) usageFail('transcribe needs a recording: asr-tool transcribe <file>')
  const input = file.trim()
  if (!existsSync(input)) usageFail(`No such file: ${input}`)

  const out = text(parsed, 'out')
  const name = out?.toLowerCase() ?? ''
  // The name is a request too: a `.srt` or `.json` target says what should land there when
  // --format is silent. That keeps `--out notes.srt` doing what it looks like it does.
  const inferred = name.endsWith('.srt') ? 'srt' : name.endsWith('.json') ? 'json' : 'text'
  const requested = text(parsed, 'format') ?? (flag(parsed, 'json') ? 'json' : undefined)
  const format = (requested ?? inferred).toLowerCase()
  if (format !== 'text' && format !== 'json' && format !== 'srt') {
    usageFail(`--format must be text, json or srt, not "${format}"`)
  }
  if (format === 'srt' && !out) usageFail('--format srt needs --out <file.srt>.')

  // The model comes from the settings, one choice for this machine; only the language is per call.
  const { config } = readAsrConfig()
  const modelDir = config.local.modelDir
  const modelId = config.local.modelId
  const language = text(parsed, 'language') ?? config.local.language

  useStagedVad()

  const result = await transcribeWithLocalSherpa({
    audioPath: input,
    ...(modelDir ? { modelDir } : {}),
    ...(modelId ? { modelId } : {}),
    ...(language ? { language } : {}),
  })
  // The same envelope the cloud side answers with: sentence timings in milliseconds, not the
  // engine's seconds, so a caller can read either route without a per-route branch.
  const utterances = result.segments.map((segment) => ({
    startMs: Math.round(segment.start * 1000),
    endMs: Math.round(segment.end * 1000),
    text: segment.text,
  }))
  const durationMs = utterances.length > 0 ? utterances[utterances.length - 1]!.endMs : undefined
  const answer: Answer = {
    ok: true,
    text: result.text,
    utterances,
    ...(durationMs !== undefined ? { durationMs } : {}),
    model: result.model.id,
    channel: 'local',
    vad: result.vad,
  }

  if (format === 'json') {
    const body = `${JSON.stringify(answer, null, 2)}\n`
    if (out) {
      mkdirSync(dirname(out), { recursive: true })
      writeFileSync(out, body, 'utf8')
      process.stdout.write(`Wrote ${out} — ${result.model.id}, ${result.segments.length} cues.\n`)
      return
    }
    process.stdout.write(body)
    return
  }

  if (format === 'srt') {
    // Subtitles are text too: without `--out` the SRT body is the answer.
    if (!out) {
      process.stdout.write(result.srt.endsWith('\n') ? result.srt : `${result.srt}\n`)
      return
    }
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, result.srt, 'utf8')
    process.stdout.write(
      `Wrote ${out} — ${result.segments.length} cues, ${result.model.id}${result.vad ? ', split on silence' : ''}.\n`,
    )
    return
  }

  if (out) {
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, `${result.text.trim()}\n`, 'utf8')
    process.stdout.write(`Wrote ${out} — ${result.text.trim().length} chars, ${result.model.id}.\n`)
    return
  }
  if (!result.text.trim()) {
    process.stderr.write('No speech was recognized.\n')
  }
  process.stdout.write(result.text.endsWith('\n') ? result.text : `${result.text}\n`)
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') {
    process.stdout.write(`${USAGE}\n`)
    return
  }
  const command = argv[0]
  if (command === 'transcribe') return transcribe(argv.slice(1))
  usageFail(`Unknown command "${command}".`)
}

try {
  await main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  // A container this CLI cannot read has a way out inside the app, where Chromium does the decode:
  // saying so here is the difference between "not supported" and a next step.
  const convertible =
    error instanceof MediaFailure && error.code === 'unsupported' && error.field === 'audio'
  fail(
    convertible
      ? `${message}\nInside the app, the sound can be converted first: recording_tool audio <file> --out <file>.wav.`
      : message,
  )
}
