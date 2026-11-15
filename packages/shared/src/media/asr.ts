/**
 * The file side of speech recognition settings: read, write, and where the models are.
 *
 * `asr.json` holds only what the person chose; everything else — which model is usable, whether a
 * VAD model exists — is discovered at the moment it is asked, so moving a model folder into place
 * needs no settings edit. The cloud side is the same idea: the provider's wire is written down in
 * `asr-config.ts`, and only the key belongs to the person.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CONFIG_DIR } from '../config/paths.ts'
import {
  asrCloudProvider,
  normalizeAsrConfig,
  DEFAULT_ASR_CONFIG,
  type AsrCloudWire,
  type AsrConfig,
} from './asr-config.ts'
import { localSherpaModels, localSherpaRoot, localSherpaVadModel, resolveLocalSherpaModel, type LocalSherpaModelInfo } from './local-sherpa.ts'
import type { AsrResult } from './providers/api-asr.ts'

export const ASR_CONFIG_FILE = 'asr.json'

export function asrConfigPath(): string {
  return join(CONFIG_DIR, ASR_CONFIG_FILE)
}

/**
 * The local model directory a config resolves to.
 *
 * `CRAFT_SHERPA_MODEL_DIR` still wins, because it is how a test or an unusual install points at
 * models without editing anybody's settings file.
 */
export function asrModelRoot(config: AsrConfig): string {
  return config.local.modelDir?.trim() || localSherpaRoot()
}

/**
 * The cloud wire these settings resolve to, with the key the caller found.
 *
 * The wire is provider knowledge kept in `asr-config.ts`, not a generation channel preset: nothing
 * here depends on Settings › Media channels. Null means no provider is chosen — never a fallback
 * to another one.
 */
export function asrCloudChannel(config: AsrConfig, apiKey?: string): AsrCloudWire | null {
  const provider = asrCloudProvider(config.cloud.provider)
  if (!provider) return null
  const key = apiKey?.trim()
  // The OpenAI-compatible wire names its own address and model; the others are fixed.
  const openai = provider.id === 'openai'
  const baseUrl = openai && config.cloud.baseUrl?.trim() ? config.cloud.baseUrl.trim() : provider.baseUrl
  const model = openai && config.cloud.model?.trim() ? config.cloud.model.trim() : provider.model
  return { ...provider, baseUrl, model, ...(key ? { apiKey: key } : {}) }
}

/** The settings, read from disk. */
export function readAsrConfig(): { config: AsrConfig; problem?: string } {
  const path = asrConfigPath()
  if (!existsSync(path)) return { config: DEFAULT_ASR_CONFIG }
  try {
    return { config: normalizeAsrConfig(JSON.parse(readFileSync(path, 'utf8'))) }
  } catch (error) {
    return {
      config: DEFAULT_ASR_CONFIG,
      problem: `${path} 读不了：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

export function writeAsrConfig(config: AsrConfig): AsrConfig {
  const path = asrConfigPath()
  mkdirSync(dirname(path), { recursive: true })
  const normalized = normalizeAsrConfig(config)
  writeFileSync(path, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
  return normalized
}

/**
 * What is wrong with this configuration, in a sentence a person can act on.
 *
 * In cloud mode this only checks that a provider was chosen: the key is read from the credential
 * store where it is used, and a provider without one says so at the moment of the request. In
 * local mode it is about models — the chosen directory, the chosen model, and whether anything is
 * there at all. `undefined` means ready to transcribe.
 */
export function asrConfigProblem(config: AsrConfig): string | undefined {
  if (config.mode === 'cloud') {
    return asrCloudProvider(config.cloud.provider) ? undefined : '云端识别还没有选择服务商。'
  }

  const modelDir = config.local.modelDir?.trim()
  if (modelDir && !existsSync(modelDir)) return `模型目录不存在：${modelDir}`

  const root = asrModelRoot(config)
  const models = localSherpaModels(root)
  if (models.length === 0) {
    return `没有找到本地模型：把 SenseVoice 模型目录放到 ${root} 下。`
  }
  const wanted = config.local.modelId?.trim()
  if (wanted && !models.some((model) => model.id === wanted || model.id.includes(wanted))) {
    return `配置的模型不在 ${root} 里：${wanted}`
  }
  return undefined
}

/**
 * Whether `asr_tool` can do anything on this machine: a local model is installed, or cloud
 * recognition is selected with a provider to call. The tool list is built from this, so a machine
 * where nobody set recognition up does not pay for the door's brief every turn.
 *
 * The cloud key is deliberately **not** part of the answer — it lives in an async credential store
 * that cannot be read while a synchronous tool list is built, and a person who chose cloud has
 * already said where recognition should run. A missing key is one actionable refusal at the call.
 */
export function asrReady(config: AsrConfig = readAsrConfig().config): boolean {
  return asrConfigProblem(config) === undefined
}

/**
 * The model these settings resolve to, or null when nothing usable is installed.
 *
 * `resolveLocalSherpaModel` throws for the settings page's benefit this does not need; a page that
 * only wants to say which engine is in use should not have to catch to find out.
 */
export function asrModelChoice(config: AsrConfig): LocalSherpaModelInfo | null {
  try {
    return resolveLocalSherpaModel({
      ...(config.local.modelId?.trim() ? { modelId: config.local.modelId } : {}),
      ...(config.local.modelDir?.trim() ? { modelDir: config.local.modelDir } : {}),
    })
  } catch {
    return null
  }
}

/** Whether recordings can be split on silence here — a nicety, not a requirement. */
export function asrVadAvailable(config: AsrConfig): boolean {
  // A model directory of one's own may carry its own VAD; with none, the app's bundled one applies.
  const modelDir = config.local.modelDir?.trim()
  if (modelDir && localSherpaVadModel(modelDir)) return true
  return localSherpaVadModel() !== null
}

const srtTime = (ms: number): string => {
  const clamped = Math.max(0, Math.round(ms))
  const pad = (value: number, width = 2) => String(value).padStart(width, '0')
  return `${pad(Math.floor(clamped / 3_600_000))}:${pad(Math.floor(clamped / 60_000) % 60)}:${pad(
    Math.floor(clamped / 1000) % 60,
  )},${pad(clamped % 1000, 3)}`
}

/**
 * Cues as an SRT body; one whole-file cue when there are no sentence timings.
 *
 * Both routes answer with the same envelope (a span and its words, in milliseconds), so the
 * subtitles are written here once rather than per caller — the agent's `asr_tool` and the panel's
 * `asr:transcribe` produce the identical file.
 */
export function srtOf(result: Pick<AsrResult, 'text' | 'utterances' | 'durationMs'>): string {
  const lines =
    result.utterances.length > 0
      ? result.utterances
      : [{ startMs: 0, endMs: result.durationMs ?? 0, text: result.text }]
  return lines
    .map(
      (line, index) =>
        `${index + 1}\n${srtTime(line.startMs)} --> ${srtTime(line.endMs)}\n${line.text.trim()}`,
    )
    .join('\n\n')
}
