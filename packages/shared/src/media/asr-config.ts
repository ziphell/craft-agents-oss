/**
 * Where recordings are turned into text.
 *
 * Recognition has two sides: the ONNX models on this machine, run by `asr-tool`, or one cloud
 * provider reached with the person's own key. That is a different kind of thing from a media
 * generation channel — the provider is a fixed wire, not a list of accounts — so it keeps its own
 * small file (`~/.craft-agent/asr.json`) and its own key instead of living inside
 * `media-channels.json`.
 *
 * This module is deliberately pure: the settings page imports it, and nothing here touches the
 * disk. Reading and writing live in `asr.ts`.
 */

/** Where recognition runs. */
export type AsrMode = 'local' | 'cloud'

/**
 * The cloud recognisers this app calls, wire and all.
 *
 * Recognition is not a generation channel: nobody adds a speech account in Settings › Media
 * channels, and the vendor's resource id is provider knowledge rather than a person's choice. So
 * the wires live here, beside the settings that use them.
 *
 * The first entry is what a person gets when they switch to cloud without choosing one. Doubao is
 * a hosted service reached with a key; the OpenAI-compatible wire is a server on this machine
 * (CrispASR and the like), whose address the person may set and whose key is usually empty.
 */
export const ASR_CLOUD_PROVIDERS = [
  {
    id: 'doubao',
    name: '火山豆包（录音文件极速版）',
    docs: 'https://docs.volcengine.com/docs/doubao-voice/large-model-recording-file-lite-recognition-api?lang=zh',
    baseUrl: 'https://openspeech.bytedance.com',
    // The flash endpoint takes the audio in the request body and answers at once: no task id, no
    // query call. The two-hour / 100 MB ceiling is the provider's, not ours.
    submitPath: '/api/v3/auc/bigmodel/recognize/flash',
    auth: { header: 'X-Api-Key', prefix: '' },
    // The "model" this API takes is a resource id; `auc_turbo` is the entitlement flash requires.
    model: 'volc.bigasr.auc_turbo',
  },
  {
    id: 'openai',
    name: 'OpenAI 兼容',
    docs: 'https://platform.openai.com/docs/api-reference/audio/createTranscription',
    // A server on this machine that speaks OpenAI's transcription API (CrispASR and the like);
    // the person may point this at vLLM or a relay instead.
    baseUrl: 'http://127.0.0.1:8080',
    submitPath: '/v1/audio/transcriptions',
    auth: { header: 'Authorization', prefix: 'Bearer ' },
    model: 'whisper-1',
  },
] as const

export type AsrCloudProvider = (typeof ASR_CLOUD_PROVIDERS)[number]['id']

/** A provider's wire, with the key and the address/model it will actually call. */
export type AsrCloudWire = Omit<(typeof ASR_CLOUD_PROVIDERS)[number], 'baseUrl' | 'model'> & {
  baseUrl: string
  model: string
  apiKey?: string
}

export interface AsrLocalSettings {
  /** Empty means `~/.craft-agent/models` (see `localSherpaRoot`). */
  modelDir?: string
  /** Empty means the first usable model found under the root. */
  modelId?: string
  /** A hint for the model: `auto` lets SenseVoice decide, otherwise `zh` / `en` / `ja` / `ko` / `yue`. */
  language?: string
}

export interface AsrCloudSettings {
  /** The provider a key was saved under; the wire itself is provider knowledge. */
  provider?: AsrCloudProvider
  /**
   * The address of the OpenAI-compatible server; empty means its default on this machine. Doubao
   * ignores it: a fixed wire must not become another vendor's wire because a URL was left behind.
   */
  baseUrl?: string
  /**
   * The model id the OpenAI-compatible server answers to; empty means `whisper-1`. CrispASR
   * ignores the id, while vLLM-style servers may require their own. Doubao ignores this too.
   */
  model?: string
  /**
   * A language hint for cloud recognition (`auto` lets the service detect it). Each wire maps it to
   * what it understands; empty means the provider's own default.
   */
  language?: string
}

export interface AsrConfig {
  version: 1
  mode: AsrMode
  local: AsrLocalSettings
  cloud: AsrCloudSettings
}

/** What a person who has configured nothing gets: local recognition, language auto. */
export const DEFAULT_ASR_CONFIG: AsrConfig = { version: 1, mode: 'local', local: {}, cloud: {} }

/** The languages the local models are known by; `auto` is SenseVoice's own detection. */
export const ASR_LANGUAGES = ['auto', 'zh', 'en', 'ja', 'ko', 'yue'] as const

const text = (value: unknown): string | undefined => {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed || undefined
}

/** A provider by id, or null for a name this app does not know how to call. */
export function asrCloudProvider(value: string | undefined) {
  const wanted = value?.trim()
  return ASR_CLOUD_PROVIDERS.find((provider) => provider.id === wanted) ?? null
}

/** A file on disk read as the settings this app understands; unknown keys are dropped. */
export function normalizeAsrConfig(value: unknown): AsrConfig {
  const source = (value ?? {}) as {
    mode?: unknown
    local?: Record<string, unknown>
    cloud?: Record<string, unknown>
  }
  const local = (source.local ?? {}) as Record<string, unknown>
  const cloud = (source.cloud ?? {}) as Record<string, unknown>
  const modelDir = text(local.modelDir)
  const modelId = text(local.modelId)
  const language = text(local.language)
  const mode = source.mode === 'cloud' ? 'cloud' : 'local'
  // A cloud mode always names a wire: an old settings file that chose a provider this app no longer
  // calls settles on the first one, and a missing key is reported where the request is made.
  const provider = asrCloudProvider(text(cloud.provider)) ?? (mode === 'cloud' ? ASR_CLOUD_PROVIDERS[0] : null)
  const baseUrl = text(cloud.baseUrl)
  const model = text(cloud.model)
  const cloudLanguage = text(cloud.language)
  return {
    version: 1,
    mode,
    local: {
      ...(modelDir ? { modelDir } : {}),
      ...(modelId ? { modelId } : {}),
      ...(language ? { language } : {}),
    },
    cloud: provider
      ? {
          provider: provider.id,
          // Kept across providers so switching away and back does not lose them; the OpenAI-
          // compatible wire reads all three, while Doubao only takes the language hint.
          ...(baseUrl ? { baseUrl } : {}),
          ...(model ? { model } : {}),
          ...(cloudLanguage ? { language: cloudLanguage } : {}),
        }
      : {},
  }
}
