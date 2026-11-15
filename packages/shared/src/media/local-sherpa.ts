/**
 * Local speech recognition through sherpa-onnx.
 *
 * The model runs in this process (Node/Electron or Bun), not in a browser sandbox: sherpa-onnx-node
 * is an N-API addon, and the same binary works in both runtimes. Models are ONNX files under
 * `~/.craft-agent/models`; nothing is uploaded, and no key is needed.
 *
 * P0 supports SenseVoice directories and accepts WAV and MP3. Whisper-class models are not built
 * in: they arrive through an OpenAI-compatible server (CrispASR and the like) the person deploys.
 * A WAV the reader refuses (24-bit) and every other container (m4a/aac, flac, ogg…) is converted
 * with ffmpeg when it is on PATH; a missing converter is a clear failure, not a wrong transcript.
 */

import { spawnSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { cpus, tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { CONFIG_DIR } from '../config/paths.ts'
import { getBundledAssetsDir } from '../utils/paths.ts'
import { ASR_LANGUAGES } from './asr-config.ts'
import { MediaFailure } from './types.ts'

export interface LocalSherpaModelInfo {
  id: string
  dir: string
  /** SenseVoice's single ONNX model. */
  model: string
  tokens: string
}

export interface LocalSherpaSegment {
  start: number
  end: number
  text: string
}

export interface LocalSherpaResult {
  text: string
  tokens: string[]
  timestamps: number[]
  segments: LocalSherpaSegment[]
  srt: string
  model: LocalSherpaModelInfo
  /** True when silence detection split the file before recognition. */
  vad: boolean
}

/** Where a local model is looked for. Overridable for a test or a non-default install. */
export function localSherpaRoot(): string {
  return process.env.CRAFT_SHERPA_MODEL_DIR?.trim() || join(CONFIG_DIR, 'models')
}

function modelInfoOf(dir: string): LocalSherpaModelInfo | null {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return null
  const files = readdirSync(dir)
  const tokens = files.find((file) => /^tokens\.txt$/i.test(file))
  const senseVoiceModel =
    files.find((file) => /^model\.int8\.onnx$/i.test(file)) ??
    files.find((file) => /^model\.onnx$/i.test(file))

  if (!tokens || !senseVoiceModel) return null
  return {
    id: basename(dir),
    dir,
    model: join(dir, senseVoiceModel),
    tokens: join(dir, tokens),
  }
}

/** Every usable model directly under the root and its `sherpa/` subdirectory. */
export function localSherpaModels(root = localSherpaRoot()): LocalSherpaModelInfo[] {
  const dirs = [root, join(root, 'sherpa')]
  const found: LocalSherpaModelInfo[] = []
  for (const parent of dirs) {
    if (!existsSync(parent)) continue
    const direct = modelInfoOf(parent)
    if (direct) found.push(direct)
    let entries: string[]
    try {
      entries = readdirSync(parent, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(parent, entry.name))
    } catch {
      continue
    }
    for (const dir of entries) {
      const info = modelInfoOf(dir)
      if (info && !found.some((item) => item.dir === info.dir)) found.push(info)
    }
  }
  return found.sort((left, right) => left.id.localeCompare(right.id))
}

export function resolveLocalSherpaModel(options: {
  modelId?: string
  modelDir?: string
  root?: string
}): LocalSherpaModelInfo {
  if (options.modelDir?.trim()) {
    const info = modelInfoOf(options.modelDir.trim())
    if (info) return info
    throw new MediaFailure(
      'generate',
      `本地模型目录里没有可用的 ONNX 文件：${options.modelDir}`,
      { code: 'missing_model', field: 'model' },
    )
  }

  const models = localSherpaModels(options.root)
  const id = options.modelId?.trim()
  const matched =
    (id && models.find((model) => model.id === id)) ||
    (id && models.find((model) => model.id.includes(id))) ||
    models[0]
  if (matched) return matched

  throw new MediaFailure(
    'generate',
    `没有找到本地语音模型。在设置里下载，或把 SenseVoice 模型目录放到 ${localSherpaRoot()} 下。`,
    { code: 'missing_model', field: 'model' },
  )
}

/**
 * The language hint SenseVoice can take.
 *
 * `auto` is its own detection; otherwise only the five languages it was trained for are accepted,
 * so a typo is refused by name instead of being passed through as an unknown token.
 */
export function languageForModel(requested?: string): string {
  const hint = requested?.trim().toLowerCase() || ''
  if (!hint || hint === 'auto') return 'auto'
  if (!(ASR_LANGUAGES as readonly string[]).includes(hint)) {
    throw new MediaFailure(
      'generate',
      `SenseVoice 不认识语言「${hint}」：可用 ${ASR_LANGUAGES.join('/')}。`,
      { code: 'invalid_request', field: 'language' },
    )
  }
  return hint
}

/**
 * sherpa's wave reader takes 8-, 16- and 32-bit samples and refuses anything else outright
 * (`wave-reader.cc`: "Expected bits_per_sample 8, 16 or 32"). Recorders still write 24-bit WAVs, so
 * the header is read here before the file is handed over; an unreadable one goes through ffmpeg
 * like a non-WAV would.
 */
function wavIsReadable(path: string): boolean {
  const header = Buffer.alloc(64)
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const read = readSync(fd, header, 0, header.length, 0)
    if (read < 44) return false
  } catch {
    return false
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
  if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') return false

  // Walk the chunks rather than assuming a 44-byte header: a `LIST` chunk may precede `fmt `.
  let offset = 12
  while (offset + 8 <= header.length) {
    const id = header.toString('ascii', offset, offset + 4)
    const size = header.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ' && body + 16 <= header.length) {
      const format = header.readUInt16LE(body)
      const bits = header.readUInt16LE(body + 14)
      // 1 = PCM, 3 = IEEE float, the two layouts sherpa understands.
      return (format === 1 || format === 3) && [8, 16, 32].includes(bits)
    }
    if (id === 'data') return false
    offset = body + size + (size % 2)
  }
  return false
}

/** PCM as the decoder hands it over: the buffer may be shared or resizable. */
type Samples = Float32Array<ArrayBufferLike>

/** Write one channel of float samples as 16-bit PCM WAV — what sherpa's reader takes, at any rate. */
function monoWav(samples: Samples, sampleRate: number): Buffer {
  const data = Buffer.alloc(samples.length * 2)
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.max(-1, Math.min(1, samples[index] ?? 0))
    data.writeInt16LE(Math.round(value * 32767), index * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

/** Channels mixed to one: what is said is one voice, and a stereo field is not part of it. */
function monoMix(channels: Samples[]): Samples {
  if (channels.length <= 1) return channels[0] ?? new Float32Array(0)
  const length = Math.min(...channels.map((channel) => channel.length))
  const mixed = new Float32Array(length)
  for (let index = 0; index < length; index += 1) {
    let sum = 0
    for (const channel of channels) sum += channel[index] ?? 0
    mixed[index] = sum / channels.length
  }
  return mixed
}

/**
 * MP3 → a temporary WAV, decoded here rather than by ffmpeg.
 *
 * `mpg123-decoder` is WASM and MIT — small enough to carry — which is what makes the commonest
 * recording format work on a machine that has never installed ffmpeg. Everything else still does
 * need one.
 */
async function mp3PathFor(audioPath: string): Promise<{ path: string; temporary: true }> {
  let sampleRate = 0
  let samples: Samples = new Float32Array(0)
  try {
    const { MPEGDecoder } = await import('mpg123-decoder')
    const decoder = new MPEGDecoder()
    await decoder.ready
    try {
      const decoded = decoder.decode(new Uint8Array(readFileSync(audioPath)))
      sampleRate = decoded.sampleRate
      samples = monoMix(decoded.channelData)
    } finally {
      decoder.free()
    }
  } catch (error) {
    throw new MediaFailure('generate', '这个 MP3 解不了：文件可能损坏，或不是 MPEG 音频。', {
      code: 'invalid_request',
      field: 'audio',
      cause: error,
    })
  }
  if (samples.length === 0 || sampleRate <= 0) {
    throw new MediaFailure('generate', '这个 MP3 里没有可读的音频。', {
      code: 'invalid_request',
      field: 'audio',
    })
  }
  const out = join(tmpdir(), `craft-sherpa-${process.pid}-${Date.now()}.wav`)
  writeFileSync(out, monoWav(samples, sampleRate))
  return { path: out, temporary: true }
}

const MP3_EXTENSIONS = new Set(['.mp3', '.mp2', '.mp1'])

/**
 * A WAV sherpa can read: the file itself, a decoded MP3, or ffmpeg's output for anything else.
 *
 * MP3 is decoded in-process, so it needs nothing installed. m4a/aac, flac and ogg are the formats
 * that still want ffmpeg — the failure names them rather than saying "unsupported".
 */
async function wavPathFor(audioPath: string): Promise<{ path: string; temporary: boolean }> {
  const extension = extname(audioPath).toLowerCase()
  if (extension === '.wav' && wavIsReadable(audioPath)) {
    return { path: audioPath, temporary: false }
  }
  if (MP3_EXTENSIONS.has(extension)) return mp3PathFor(audioPath)

  const out = join(tmpdir(), `craft-sherpa-${process.pid}-${Date.now()}.wav`)
  const converted = spawnSync(
    'ffmpeg',
    ['-y', '-i', audioPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-f', 'wav', out],
    { stdio: 'ignore' },
  )
  if (converted.error || converted.status !== 0 || !existsSync(out)) {
    throw new MediaFailure(
      'generate',
      '本地转写直接读 WAV 和 MP3；m4a/aac、flac、ogg 等格式需要 ffmpeg。请安装 ffmpeg，或先把音频转成 16kHz mono WAV。',
      { code: 'unsupported', field: 'audio' },
    )
  }
  return { path: out, temporary: true }
}

function cleanText(value: string): string {
  return value
    .replace(/<\|[^>]*?\|>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const SENTENCE_END = /[。！？!?；;]$/

/**
 * The Silero VAD model, if one is installed. VAD is optional: without it the file is one chunk.
 *
 * An explicit `root` means a self-contained install and only that directory is searched; with no
 * root, the user's model directory is tried first and the ~1.8 MB model shipped with the app last.
 */
export function localSherpaVadModel(root?: string): string | null {
  const configured = process.env.CRAFT_SHERPA_VAD_MODEL?.trim()
  if (configured && existsSync(configured)) return configured

  const dirs = root ? [root] : [localSherpaRoot(), getBundledAssetsDir('models')]
  const candidates = dirs.flatMap((dir) =>
    dir ? [join(dir, 'silero_vad.onnx'), join(dir, 'sherpa', 'silero_vad.onnx')] : [],
  )
  return candidates.find((path) => existsSync(path)) ?? null
}

/**
 * Turn per-token timestamps into subtitle lines.
 *
 * A token timestamp is a start time; the next token's start is this token's end. When the model
 * gives no usable timestamps, characters are distributed across the utterance instead — a worse
 * timeline, but one that still produces valid subtitles.
 */
function segmentsOf(
  text: string,
  tokens: string[],
  timestamps: number[],
  duration: number,
  offset = 0,
): LocalSherpaSegment[] {
  const clean = cleanText(text)
  if (!clean) return []

  const usable =
    tokens.length > 0 &&
    timestamps.length === tokens.length &&
    timestamps.every((value) => Number.isFinite(value))
  if (!usable) {
    return proportionalSegments(clean, duration, offset)
  }

  const segments: LocalSherpaSegment[] = []
  let start = Math.max(0, timestamps[0] ?? 0)
  let current = ''
  for (let index = 0; index < tokens.length; index++) {
    const token = String(tokens[index] ?? '')
    current += token
    const end = Math.max(start + 0.02, timestamps[index + 1] ?? duration)
    const longEnough = end - start >= 8
    const wideEnough = [...current].length >= 42
    if (SENTENCE_END.test(token.trim()) || longEnough || wideEnough || index === tokens.length - 1) {
      const segmentText = cleanText(current)
      if (segmentText) {
        segments.push({
          start: Number((offset + start).toFixed(2)),
          end: Number((offset + Math.min(duration, end)).toFixed(2)),
          text: segmentText,
        })
      }
      current = ''
      start = end
    }
  }
  return segments.length ? segments : proportionalSegments(clean, duration, offset)
}

function proportionalSegments(
  text: string,
  duration: number,
  offset = 0,
): LocalSherpaSegment[] {
  const parts = text.match(/[^。！？!?；;]+[。！？!?；;]?/g)?.map((part) => part.trim()).filter(Boolean) ?? [text]
  const total = parts.reduce((sum, part) => sum + [...part].length, 0) || 1
  let consumed = 0
  return parts.map((part) => {
    const length = [...part].length
    const start = duration * (consumed / total)
    consumed += length
    const end = duration * (consumed / total)
    return {
      start: Number((offset + start).toFixed(2)),
      end: Number((offset + Math.max(start + 0.02, end)).toFixed(2)),
      text: part,
    }
  })
}

const srtTime = (seconds: number): string => {
  const safe = Math.max(0, seconds)
  const hours = Math.floor(safe / 3600)
  const minutes = Math.floor((safe % 3600) / 60)
  const whole = Math.floor(safe % 60)
  const millis = Math.round((safe - Math.floor(safe)) * 1000)
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(whole).padStart(2, '0')},${String(millis).padStart(3, '0')}`
}

export function toSrt(segments: readonly LocalSherpaSegment[]): string {
  return segments
    .filter((segment) => segment.text.trim())
    .map(
      (segment, index) =>
        `${index + 1}\n${srtTime(segment.start)} --> ${srtTime(segment.end)}\n${segment.text.trim()}\n`,
    )
    .join('\n')
}

/** The runtime is optional: a build without the native addon still loads and explains itself. */
async function loadSherpa(): Promise<any> {
  try {
    // A non-literal specifier keeps the optional native module out of the bundler's resolver and
    // out of every build that has no declaration for it.
    const moduleName = 'sherpa-onnx-node'
    const imported = (await import(moduleName)) as any
    return imported?.default ?? imported
  } catch (error) {
    throw new MediaFailure(
      'generate',
      '本地 ASR 运行时未安装：sherpa-onnx-node 加载失败。重新安装应用，或改用云端转写渠道。',
      { code: 'unsupported', field: 'sherpa', cause: error },
    )
  }
}

export interface VadeChunk {
  samples: Float32Array
  /** Start sample index in the original recording. */
  start: number
}

/**
 * A pause shorter than this is a breath inside one utterance, not a sentence break. Decoding the
 * two sides together gives the model the context the pause interrupted.
 */
const VAD_MERGE_GAP_SECONDS = 1.2

/**
 * VAD triggers just after speech begins and releases just before it ends, so a hard cut at its
 * boundaries clips the first and last phoneme of every chunk. This is the same padding a meeting
 * transcriber applies (Memo: 0.25 s before, 0.45 s after).
 */
const VAD_PRE_PADDING_SECONDS = 0.25
const VAD_POST_PADDING_SECONDS = 0.45

/** Split a recording on silence with sherpa's Silero VAD. */
function splitWithVad(
  sherpa: any,
  vadModel: string,
  samples: Float32Array,
  sampleRate: number,
): VadeChunk[] {
  const vad = new sherpa.Vad(
    {
      sileroVad: {
        model: vadModel,
        threshold: 0.5,
        minSilenceDuration: 0.5,
        minSpeechDuration: 0.25,
        maxSpeechDuration: 15,
        windowSize: 512,
      },
    },
    60,
  )
  const windowSize: number = vad.config?.sileroVad?.windowSize ?? 512
  const chunks: VadeChunk[] = []
  const drain = () => {
    while (!vad.isEmpty()) {
      const segment = vad.front(false)
      vad.pop()
      if (segment?.samples?.length) {
        chunks.push({
          samples: new Float32Array(segment.samples),
          start: Number(segment.start ?? 0),
        })
      }
    }
  }

  for (let offset = 0; offset < samples.length; offset += windowSize) {
    const slice = samples.subarray(offset, Math.min(offset + windowSize, samples.length))
    const window =
      slice.length === windowSize
        ? slice
        : (() => {
            const padded = new Float32Array(windowSize)
            padded.set(slice)
            return padded
          })()
    vad.acceptWaveform(window)
    drain()
  }
  vad.flush()
  drain()
  return padAndMerge(chunks, samples.length, sampleRate)
}

/**
 * Join chunks separated by a breath, then give each one the padding its cut removed.
 *
 * Merging first keeps a chunk's internal timeline equal to the original recording: the gap is
 * filled with silence rather than dropped, so token timestamps still point at the right second.
 */
export function padAndMerge(chunks: readonly VadeChunk[], totalSamples: number, sampleRate: number): VadeChunk[] {
  const mergeGap = Math.round(VAD_MERGE_GAP_SECONDS * sampleRate)
  const merged: VadeChunk[] = []
  for (const chunk of chunks) {
    const previous = merged[merged.length - 1]
    if (previous) {
      const previousEnd = previous.start + previous.samples.length
      const gap = chunk.start - previousEnd
      if (gap <= mergeGap) {
        // A negative gap means the two segments overlap; skip the repeated sound instead of
        // letting the decoder hear it twice.
        const skip = gap < 0 ? Math.min(-gap, chunk.samples.length) : 0
        const silence = gap > 0 ? gap : 0
        const joined = new Float32Array(previous.samples.length + silence + chunk.samples.length - skip)
        joined.set(previous.samples, 0)
        joined.set(chunk.samples.subarray(skip), previous.samples.length + silence)
        previous.samples = joined
        continue
      }
    }
    merged.push({ samples: new Float32Array(chunk.samples), start: chunk.start })
  }

  const pre = Math.round(VAD_PRE_PADDING_SECONDS * sampleRate)
  const post = Math.round(VAD_POST_PADDING_SECONDS * sampleRate)
  return merged.map((chunk) => {
    const start = Math.max(0, chunk.start - pre)
    const end = Math.min(totalSamples, chunk.start + chunk.samples.length + post)
    const offset = chunk.start - start
    const padded = new Float32Array(Math.max(0, end - start))
    padded.set(chunk.samples.subarray(0, padded.length - offset), offset)
    return { samples: padded, start }
  })
}

/** Join recognized chunks without inserting spaces between CJK characters. */
function joinTexts(parts: readonly string[]): string {
  return parts.reduce((text, part) => {
    if (!text) return part
    return /[A-Za-z0-9]$/.test(text) && /^[A-Za-z0-9]/.test(part) ? `${text} ${part}` : `${text}${part}`
  }, '')
}

export async function transcribeWithLocalSherpa(options: {
  audioPath: string
  modelId?: string
  modelDir?: string
  language?: string
  root?: string
}): Promise<LocalSherpaResult> {
  const model = resolveLocalSherpaModel(options)
  const sherpa = await loadSherpa()
  const converted = await wavPathFor(options.audioPath)
  try {
    let wave: { samples: Float32Array; sampleRate: number }
    try {
      wave = sherpa.readWave(converted.path, false)
    } catch (error) {
      throw new MediaFailure('generate', '本地 ASR 读不了这个音频文件。', {
        code: 'invalid_request',
        field: 'audio',
        cause: error,
      })
    }

    // The hint is translated into what SenseVoice can actually take, not passed through.
    const language = languageForModel(options.language)
    const modelConfig = {
      senseVoice: {
        model: model.model,
        useInverseTextNormalization: true,
        language,
      },
      tokens: model.tokens,
    }

    const recognizer = new sherpa.OfflineRecognizer({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        ...modelConfig,
        numThreads: Math.max(1, Math.min(4, cpus().length)),
        provider: 'cpu',
        debug: false,
      },
    })

    const vadModel = localSherpaVadModel(options.root)
    let chunks: VadeChunk[] = []
    if (vadModel) {
      try {
        chunks = splitWithVad(sherpa, vadModel, wave.samples, wave.sampleRate)
      } catch {
        // A broken VAD model must not make transcription impossible; fall back to the whole file.
        chunks = []
      }
    }
    const work = chunks.length ? chunks : [{ samples: wave.samples, start: 0 }]
    const segments: LocalSherpaSegment[] = []
    const tokens: string[] = []
    const timestamps: number[] = []

    for (const chunk of work) {
      const stream = recognizer.createStream()
      stream.acceptWaveform({ samples: chunk.samples, sampleRate: wave.sampleRate })
      recognizer.decode(stream)
      const result = recognizer.getResult(stream)
      const duration = chunk.samples.length / wave.sampleRate
      const offset = chunk.start / wave.sampleRate
      const text = cleanText(String(result.text ?? ''))
      const chunkTokens = Array.isArray(result.tokens) ? result.tokens.map(String) : []
      const chunkTimestamps = Array.isArray(result.timestamps)
        ? result.timestamps.map(Number).filter((value: number) => Number.isFinite(value))
        : []
      tokens.push(...chunkTokens)
      timestamps.push(...chunkTimestamps.map((value: number) => Number((value + offset).toFixed(2))))
      segments.push(...segmentsOf(text, chunkTokens, chunkTimestamps, duration, offset))
    }

    return {
      text: joinTexts(segments.map((segment) => segment.text)),
      tokens,
      timestamps,
      segments,
      srt: toSrt(segments),
      model,
      vad: Boolean(vadModel) && chunks.length > 0,
    }
  } finally {
    if (converted.temporary) {
      try {
        unlinkSync(converted.path)
      } catch {
        // A leftover temp file is not a failed transcription.
      }
    }
  }
}
