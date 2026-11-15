/**
 * Where pictures come from.
 *
 * A **channel** is one provider account: a base URL, a key, and the models that account can reach.
 * That is the whole abstraction, and it is deliberately smaller than a workflow: a workflow is one
 * machine's private recipe, while a channel is the thing most people actually have — a key.
 *
 * The file lives beside the app's other state (`~/.craft-agent/media-channels.json`), not inside a
 * project, because an account is not a project's property. A project may still name which channel a
 * card uses.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CONFIG_DIR } from '../config/paths.ts'
import { findChannelPreset } from './presets.ts'
import type { MediaParamOptions, MediaParamSpec } from './params.ts'
import type { MediaMode } from './modes.ts'
import type { PromptReferenceLabels } from './reference-prompt.ts'

export type MediaChannelProtocol =
  /** `POST {baseUrl}/images/generations` — the shape most vendors and relays implement. */
  'openai-image'

/**
 * What an account produces.
 *
 * `tts` reads text aloud; `music` composes audio. Speech and music used to share `audio`, which
 * left "which account should speak this" undecidable — the one question a setting has to answer.
 * Transcription is not here: it lives in `asr-tool`, which is not an account.
 */
export type MediaKind = 'image' | 'video' | 'music' | 'tts'

/** The kinds whose output is a sound file. A tts and a music account both answer with audio. */
export const SOUND_KINDS: readonly MediaKind[] = ['music', 'tts']

export const isSoundKind = (kind: string | null | undefined): boolean =>
  kind === 'tts' || kind === 'music'

/** What a reference file is. References are inputs, so they keep the file-ish name `audio`. */
export type MediaInputKind = 'image' | 'video' | 'audio'

/**
 * Who names the models.
 *
 * `registered` — an official platform whose catalogue is the complete list, so only exact ids have
 * capabilities. `open` — a relay that may invent ids; a model can still be recognised from its name.
 */
export type ModelIdSource = 'registered' | 'open'

/**
 * Who the account is with, as opposed to how it is wired.
 *
 * Several presets may share a provider type (MiniMax direct and a relay that fronts it); the type is
 * what model-catalogue lookups and capability rules key on.
 */
export type MediaProviderType = string

/** How a submit body is shaped. */
export type MediaBodyShape =
  | 'prompt'
  | 'content'
  | 'gemini'
  | 'openai-speech'
  | 'dashscope-tts'
  | 'volcengine-audio'
  | 'minimax-tts'
  | 'minimax-image'
  | 'minimax-h3-image'
  | 'minimax-music'
  | 'dashscope-music'
  | 'dashscope-video'
  | 'dashscope-image'
  | 'audio-generation'

/** What comes back: a file as the body, or JSON with a url/base64 found through `resultPath`. */
export type MediaResponseShape = 'json' | 'binary'

/** Where a local reference is uploaded before the generation, when an id is wanted. */
export interface MediaUpload {
  /** Appended to `baseUrl`, e.g. `/v1/files/upload`. */
  path: string
  /** What the provider calls this use (`video_generation_input`). */
  purpose: string
  /** How the id is written in the generation body (`mm_file://`). */
  refPrefix: string
}

/**
 * One capability of an account: the models it offers for a kind, and the wire they speak.
 *
 * An account is one key and one base URL, but vendors sell several capabilities behind it — an
 * image endpoint, a video task endpoint, a TTS endpoint. A channel used to be exactly one kind and
 * one set of paths; this is the part that varies per kind, so one account can hold several.
 */
export interface MediaEndpoint {
  kind: MediaKind
  /**
   * What the card's main text means for this capability.
   *
   * Music that takes words reads them as the lyrics, so the composer's big field is the lyrics and
   * the provider's style prompt is a parameter. Absent means the text is the prompt, as everywhere
   * else.
   */
  textRole?: 'lyrics'
  /** The catalog this account can reach — what a settings page offers to choose from. */
  models?: string[]
  /**
   * The subset of `models` the person enabled for the agent, in the order they chose. Absent means
   * "all of them", which is how a file written before this field behaves.
   */
  enabledModels?: string[]
  /** Which of the enabled models a new run starts with. */
  defaultModel?: string
  /**
   * Where this capability lives when it is not on the account's base.
   *
   * Bailian sells pictures through two doors: Qwen-Image on `…/compatible-mode/v1` and Wan on
   * `…/api/v1`. They are one key, so they are one capability with two wires, and this is the
   * capability's own host rather than the account's.
   */
  baseUrl?: string
  /**
   * Protocols for models that speak differently from the rest of their capability — the Wan t2i
   * models inside the Qwen-Image door. The protocol id is the reference; `protocols.ts` owns the
   * wire, so one protocol is never copied into every preset that uses it.
   */
  modelProtocols?: Record<string, string>
  /**
   * Explicit wire overrides for a model. Kept for hand-written channels and for a model whose
   * protocol was edited field by field; a named protocol is the normal case.
   */
  modelWires?: Record<string, MediaModelWire>

  /**
   * Where this capability lives on the wire.
   *
   * Some providers answer with the picture; others answer with a task id and expect you to ask
   * again. Rather than one adapter per vendor, an endpoint describes its own wire: the paths, and
   * where the status and the url sit in the JSON.
   */
  submitPath?: string
  /**
   * Where the same capability lives when the request carries references. MiniMax's H3 image model
   * answers text-to-image at one path and image editing (1–16 references) at another.
   */
  editPath?: string
  pollPath?: string
  /**
   * Appended to cancel a task; `{taskId}` is substituted. Most providers have no such endpoint — a
   * task that cannot be cancelled keeps running (and charging) whether or not anybody is watching,
   * so "stop waiting" is a different act from "stop the provider".
   */
  cancelPath?: string
  taskIdPath?: string
  statusPath?: string
  resultPath?: string
  /** Generation parameters the provider needs beyond model and prompt (duration, resolution…). */
  params?: Record<string, string | number>
  /**
   * How often to ask a task endpoint about its job. A minute-long video does not want the picture
   * cadence: the provider's queue moves in tens of seconds, and every ask costs a round trip.
   */
  pollMs?: number
  /**
   * Models that do not generate from scratch. A `video-edit` model takes exactly one video and
   * answers with that video changed, at its length; undeclared models generate.
   */
  modelModes?: Record<string, MediaMode>
  /** How the submit body is shaped. */
  bodyShape?: MediaBodyShape
  /**
   * Headers the submit needs beyond the key. DashScope's task endpoints only queue a job when
   * `X-DashScope-Async: enable` is present; without it the same call answers differently.
   */
  submitHeaders?: Record<string, string>
  /**
   * What comes back. `binary` means the response body *is* the file (OpenAI's `/audio/speech`);
   * `json` means a payload with a URL or base64 inside it, found through `resultPath`.
   */
  responseShape?: MediaResponseShape
  upload?: MediaUpload
  /**
   * Vendor model ID → catalogue ID. The catalogue says what a model can do; the request keeps the
   * vendor's own ID, because rewriting it is how a relay stops recognising its own model.
   */
  modelCatalogId?: Record<string, string>
  /**
   * The values a run may choose from, so a panel can offer them instead of asking a person to
   * remember what a provider accepts. Anything absent is simply not shown.
   */
  options?: MediaParamOptions
  /**
   * The same choices, typed. When present it wins over `options`; a parameter that only some models
   * accept names them in `paramSpecs[].models`.
   */
  paramSpecs?: MediaParamSpec[]
  /**
   * How this provider names ordered references in a prompt. `{n}` is the one-based index inside
   * that media array; omitted kinds keep the built-in `图片{n}` / `视频{n}` / `音频{n}`.
   */
  referenceLabels?: PromptReferenceLabels
}

/** The part of a capability a single model may replace, without changing what the capability is. */
export type MediaModelWire = Partial<
  Pick<
    MediaEndpoint,
    | 'baseUrl'
    | 'submitPath'
    | 'editPath'
    | 'pollPath'
    | 'cancelPath'
    | 'taskIdPath'
    | 'statusPath'
    | 'resultPath'
    | 'pollMs'
    | 'bodyShape'
    | 'submitHeaders'
    | 'responseShape'
  >
>

export interface MediaChannel {
  id: string
  name: string
  protocol: MediaChannelProtocol
  /** For `openai-image`, the versioned base (`https://host/v1`). */
  baseUrl: string
  /**
   * False when the person turned this account off without deleting it.
   *
   * A disabled account stays configurable — its models and key are kept — but nothing selects it
   * automatically and an explicit `--channel` naming it is refused by name.
   */
  enabled?: boolean
  /** Inline key. Prefer `apiKeyEnv` when the key should stay out of a file. */
  apiKey?: string
  /** Name of an environment variable holding the key. Wins over `apiKey` when set. */
  apiKeyEnv?: string
  /** Models of the legacy single-kind channel. Ignored once `endpoints` is present. */
  models: string[]
  /** The enabled subset of `models`. Ignored once `endpoints` is present. */
  enabledModels?: string[]
  /** Which of `models` a new node starts with. Ignored once `endpoints` is present. */
  defaultModel?: string

  /**
   * The capabilities this account offers. One account may draw pictures, film clips and speak —
   * a separate key is not required for each. Absent, the fields below describe one capability.
   */
  endpoints?: MediaEndpoint[]

  /**
   * The legacy single-kind declaration, kept because channels on disk and presets still use it.
   * `endpointsOf` reads it as a one-item list.
   */
  kind?: MediaKind
  /** `lyrics` on the legacy single-kind channel: the card's text is the lyrics. */
  textRole?: 'lyrics'
  submitPath?: string
  /**
   * Where the same capability lives when the request carries references. MiniMax's H3 image model
   * answers text-to-image at one path and image editing (1–16 references) at another.
   */
  editPath?: string
  pollPath?: string
  /**
   * Appended to cancel a task; `{taskId}` is substituted. Most providers have no such endpoint — a
   * task that cannot be cancelled keeps running (and charging) whether or not anybody is watching,
   * so "stop waiting" is a different act from "stop the provider".
   */
  cancelPath?: string
  taskIdPath?: string
  statusPath?: string
  resultPath?: string
  /** Generation parameters the provider needs beyond model and prompt (duration, resolution…). */
  params?: Record<string, string | number>
  /**
   * How often to ask a task endpoint about its job. A minute-long video does not want the picture
   * cadence: the provider's queue moves in tens of seconds, and every ask costs a round trip.
   */
  pollMs?: number
  /**
   * Models that do not generate from scratch. A `video-edit` model takes exactly one video and
   * answers with that video changed, at its length; undeclared models generate.
   */
  modelModes?: Record<string, MediaMode>
  /** The preset this channel was built from, if any (`presets.ts`). */
  preset?: string
  /** Who the account is with. Absent means the preset id, or `custom` for a hand-written channel. */
  providerType?: MediaProviderType
  /** Who names the models. Absent means `registered` for a preset, `open` for a custom channel. */
  modelIdSource?: ModelIdSource
  /** Vendor model ID → catalogue ID for the legacy single-kind shape. */
  modelCatalogId?: Record<string, string>
  /** Which header carries the key. Bearer by default; Gemini wants `x-goog-api-key`. */
  auth?: { header: string; prefix?: string }
  /** How the submit body is shaped. */
  bodyShape?: MediaBodyShape
  /** Headers the submit needs beyond the key, for the legacy single-kind shape. */
  submitHeaders?: Record<string, string>
  /** Per-model protocol ids, for the legacy single-kind shape. */
  modelProtocols?: Record<string, string>
  /** Per-model wire overrides, for the legacy single-kind shape. */
  modelWires?: Record<string, MediaModelWire>
  /**
   * What comes back. `binary` means the response body *is* the file (OpenAI's `/audio/speech`);
   * `json` means a payload with a URL or base64 inside it, found through `resultPath`.
   */
  responseShape?: 'json' | 'binary'
  /**
   * Where a local reference is uploaded before the generation, when the provider wants an id
   * rather than inline bytes. A channel that omits this takes references inline.
   */
  upload?: {
    /** Appended to `baseUrl`, e.g. `/v1/files/upload`. */
    path: string
    /** What the provider calls this use (`video_generation_input`). */
    purpose: string
    /** How the id is written in the generation body (`mm_file://`). */
    refPrefix: string
  }
  /**
   * The values a card may choose from, so a panel can offer them instead of asking a person to
   * remember what a provider accepts. Anything absent is simply not shown.
   */
  options?: MediaParamOptions
  /**
   * The same choices, typed. When present it wins over `options`; a parameter that only some models
   * accept names them in `paramSpecs[].models`.
   */
  paramSpecs?: MediaParamSpec[]
  /**
   * How this provider names ordered references in a prompt. `{n}` is the one-based index inside
   * that media array; omitted kinds keep the built-in `图片{n}` / `视频{n}` / `音频{n}`.
   */
  referenceLabels?: PromptReferenceLabels
}

export const MEDIA_CHANNELS_FILE = 'media-channels.json'

export function mediaChannelsPath(): string {
  return join(CONFIG_DIR, MEDIA_CHANNELS_FILE)
}

interface MediaChannelsFile {
  channels: MediaChannel[]
}

/**
 * The fields that belong to one capability rather than to the account.
 *
 * They are read from a `MediaEndpoint`, or from the channel itself when the channel is written in
 * the old single-kind shape. One list, so `withPreset`, `channelForKind` and the settings page
 * cannot disagree about what an endpoint owns.
 */
const ENDPOINT_KEYS = [
  'models',
  'defaultModel',
  'modelCatalogId',
  'baseUrl',
  'submitPath',
  'editPath',
  'pollPath',
  'cancelPath',
  'taskIdPath',
  'statusPath',
  'resultPath',
  'enabledModels',
  'params',
  'pollMs',
  'modelModes',
  'bodyShape',
  'textRole',
  'submitHeaders',
  'modelProtocols',
  'modelWires',
  'responseShape',
  'upload',
  'options',
  'paramSpecs',
  'referenceLabels',
] as const satisfies ReadonlyArray<keyof MediaEndpoint>

const isBlank = (value: unknown): boolean =>
  value === undefined || value === '' || (Array.isArray(value) && value.length === 0)

/** The old single-kind channel read as the one-item endpoint list it always was. */
function legacyEndpointOf(channel: MediaChannel): MediaEndpoint {
  const endpoint = { kind: channel.kind ?? 'image' } as MediaEndpoint
  for (const key of ENDPOINT_KEYS) {
    const value = channel[key]
    if (value !== undefined) (endpoint as unknown as Record<string, unknown>)[key] = value
  }
  return endpoint
}

/**
 * The capabilities an account offers.
 *
 * A channel written before capabilities existed is one endpoint, built from its own fields — which
 * is why every caller can ask this without caring which shape the file is in.
 */
export function endpointsOf(channel: MediaChannel): MediaEndpoint[] {
  const declared = channel.endpoints?.filter((endpoint) => typeof endpoint?.kind === 'string')
  if (declared?.length) return declared
  return [legacyEndpointOf(channel)]
}

/** The endpoint for one kind, or null when this account does not offer it. */
export function endpointFor(channel: MediaChannel, kind?: MediaKind): MediaEndpoint | null {
  const endpoints = endpointsOf(channel)
  if (!kind) return endpoints[0] ?? null
  return endpoints.find((endpoint) => endpoint.kind === kind) ?? null
}

/** The kinds this account can make, in the order they were declared. */
export function mediaChannelKinds(channel: MediaChannel): MediaKind[] {
  return [...new Set(endpointsOf(channel).map((endpoint) => endpoint.kind))]
}

/**
 * The channel as one capability: the account's identity, and one endpoint's wire.
 *
 * Everything below this function — `generate.ts`, the task runner, the panel — reads a channel as
 * if it made exactly one kind. This is where that lie is made true, so none of them needs an
 * `endpoints` branch. A channel without the asked-for kind returns `null` instead of falling back
 * to a different one: a video card must not be handed the picture endpoint.
 */
export function channelForKind(
  channel: MediaChannel,
  kind?: MediaKind,
): MediaChannel | null {
  const endpoint = endpointFor(channel, kind)
  if (!endpoint) return null
  // The legacy shape already *is* one endpoint: only the kind and the enabled subset need filling in.
  if (!channel.endpoints?.length) {
    // An absent list is an old file (everything was enabled); an empty one is "none chosen".
    const enabled = channel.enabledModels ?? channel.models
    return {
      ...channel,
      kind: endpoint.kind,
      models: enabled,
      // There is no separate default: the first model in the person's order is the one a run starts with.
      defaultModel: enabled[0],
    }
  }

  const applied = { ...channel, kind: endpoint.kind } as MediaChannel
  const writable = applied as unknown as Record<string, unknown>
  // An endpoint fully determines its own fields: a value the sibling endpoint declared must not
  // leak in through the shared channel object.
  for (const key of ENDPOINT_KEYS) {
    const value = endpoint[key]
    if (value === undefined) {
      // A capability with no base of its own speaks to the account's; every other field is the
      // capability's alone and must not leak in from a sibling.
      if (key === 'baseUrl') continue
      delete writable[key]
    } else {
      writable[key] = value
    }
  }
  // A run may only use what the person enabled, and it starts with the first in their order. An
  // older file has no list at all, and then every catalog model is enabled, which is what it meant
  // before the distinction existed; an empty list is a decision — nothing is enabled yet.
  const enabled = endpoint.enabledModels ?? endpoint.models ?? []
  applied.models = enabled
  applied.defaultModel = enabled[0]
  return applied
}

/** One endpoint of `own`, on top of what the preset said about the same kind. */
function mergeEndpoint(base: MediaEndpoint | undefined, own: MediaEndpoint): MediaEndpoint {
  if (!base) return own
  const merged = { ...base, kind: own.kind } as MediaEndpoint
  const writable = merged as unknown as Record<string, unknown>
  for (const key of ENDPOINT_KEYS) {
    const value = own[key]
    // An explicitly empty enabled list is a decision ("nothing chosen yet"); any other blank means
    // the preset still owns that field.
    if (key === 'enabledModels' && Array.isArray(value)) {
      writable[key] = value
      continue
    }
    if (isBlank(value)) continue
    // Parameters and model modes are maps: a channel that adds one default keeps the rest.
    if (typeof value === 'object' && !Array.isArray(value) && value !== null) {
      writable[key] = { ...((base[key] ?? {}) as object), ...value }
    } else {
      writable[key] = value
    }
  }
  return merged
}

/**
 * A channel with its preset's defaults underneath its own values.
 *
 * The channel always wins: a preset is a starting point, not an authority. That is what lets a
 * vendor move its base URL without anybody editing their own file, and lets a person point a known
 * provider at their own relay.
 */
export function withPreset(channel: MediaChannel): MediaChannel {
  const preset = findChannelPreset(channel.preset)
  if (!preset) return channel
  const { id: _presetId, name: _presetName, docs: _docs, ...defaults } = preset
  // An empty string is a value somebody left blank, not a decision to have no base URL — so the
  // preset fills it. Anything actually written wins.
  const or = <T>(own: T | undefined, fallback: T | undefined): T | undefined =>
    own === undefined || own === '' || (Array.isArray(own) && own.length === 0) ? fallback : own
  const presetChannel = {
    ...(defaults as Partial<MediaChannel>),
    models: (defaults as Partial<MediaChannel>).models ?? [],
  } as MediaChannel
  // A preset may declare several capabilities, or one (in which case its legacy fields are that
  // one). Per-kind defaults are merged underneath the channel's own endpoints, so a saved file
  // holds what the person chose while paths keep following the preset. Both sides are read through
  // `mediaKindOfDeclaration` first: a file saved while speech was still called `audio` must still
  // find the preset endpoint it belongs to.
  const kindOf = (endpoint: MediaEndpoint, fallbackShape?: MediaBodyShape): MediaKind | null =>
    mediaKindOfDeclaration(endpoint.kind, endpoint.bodyShape ?? fallbackShape)
  const presetEndpoints = endpointsOf(presetChannel).flatMap((endpoint) => {
    const kind = kindOf(endpoint, presetChannel.bodyShape)
    return kind ? [{ ...endpoint, kind }] : []
  })
  const ownEndpoints = (channel.endpoints ?? []).flatMap((endpoint) => {
    const kind = kindOf(endpoint, channel.bodyShape)
    return kind ? [{ ...endpoint, kind }] : []
  })
  const endpoints = ownEndpoints.length
    ? ownEndpoints.map((own) =>
        mergeEndpoint(
          presetEndpoints.find((candidate) => candidate.kind === own.kind),
          own,
        ),
      )
    : or(channel.endpoints, defaults.endpoints)
  return {
    ...defaults,
    ...channel,
    baseUrl: or(channel.baseUrl, defaults.baseUrl) ?? '',
    submitPath: or(channel.submitPath, defaults.submitPath),
    editPath: or(channel.editPath, defaults.editPath),
    pollPath: or(channel.pollPath, defaults.pollPath),
    taskIdPath: or(channel.taskIdPath, defaults.taskIdPath),
    statusPath: or(channel.statusPath, defaults.statusPath),
    resultPath: or(channel.resultPath, defaults.resultPath),
    // A channel saved while speech was still called `audio` is read as the capability its wire
    // describes; the kind is part of what a preset may correct.
    kind:
      mediaKindOfDeclaration(
        or(channel.kind, defaults.kind) ?? 'image',
        or(channel.bodyShape, defaults.bodyShape),
      ) ?? undefined,
    providerType: or(channel.providerType, defaults.providerType),
    modelIdSource: or(channel.modelIdSource, defaults.modelIdSource),
    modelCatalogId: or(channel.modelCatalogId, defaults.modelCatalogId),
    models: or(channel.models, defaults.models) ?? [],
    auth: or(channel.auth, defaults.auth),
    bodyShape: or(channel.bodyShape, defaults.bodyShape),
    responseShape: or(channel.responseShape, defaults.responseShape),
    upload: or(channel.upload, defaults.upload),
    options: or(channel.options, defaults.options),
    paramSpecs: or(channel.paramSpecs, defaults.paramSpecs),
    modelModes: or(channel.modelModes, defaults.modelModes),
    referenceLabels: or(channel.referenceLabels, defaults.referenceLabels),
    ...(endpoints?.length ? { endpoints } : {}),
  } as MediaChannel
}

/** Body shapes that read text aloud; every other audio shape composes sound. */
const SPEECH_SHAPES: ReadonlySet<MediaBodyShape> = new Set<MediaBodyShape>([
  'openai-speech',
  'dashscope-tts',
  'volcengine-audio',
  'minimax-tts',
])

const KNOWN_KINDS: readonly MediaKind[] = ['image', 'video', 'music', 'tts']

/**
 * The kind a declaration really means.
 *
 * Channels and presets written before speech and music were separate say `audio`; the body shape
 * says which of the two it was, because a speech endpoint and a composition endpoint do not share a
 * wire. An audio declaration with no recognisable speech shape is composition — the older default.
 */
export function mediaKindOfDeclaration(
  kind: unknown,
  bodyShape?: MediaBodyShape,
): MediaKind | null {
  if (typeof kind === 'string' && (KNOWN_KINDS as readonly string[]).includes(kind)) {
    return kind as MediaKind
  }
  if (kind !== 'audio') return null
  return bodyShape && SPEECH_SHAPES.has(bodyShape) ? 'tts' : 'music'
}

/**
 * A stored channel read as the capabilities it means.
 *
 * A file written before transcription moved to `asr-tool` may still hold a `transcribe` endpoint: it
 * is dropped rather than carried around, because nothing behind this module makes words from a
 * channel. `audio` is split into `tts` and `music` by what its wire does. A declaration that means
 * nothing we can run disappears, and with it a channel that only offered that.
 */
function normalizeDeclaredKinds(channel: MediaChannel): MediaChannel | null {
  if (channel.endpoints?.length) {
    const seen = new Set<MediaKind>()
    const endpoints: MediaEndpoint[] = []
    for (const endpoint of channel.endpoints) {
      const kind = mediaKindOfDeclaration(endpoint?.kind, endpoint?.bodyShape ?? channel.bodyShape)
      // Two declarations may collapse onto one kind (`audio` beside an explicit `tts`); the first
      // one is the one the file meant, and a duplicate would only make lookups ambiguous.
      if (!kind || seen.has(kind)) continue
      seen.add(kind)
      endpoints.push({ ...endpoint, kind })
    }
    return endpoints.length ? { ...channel, endpoints } : null
  }
  const kind = mediaKindOfDeclaration(channel.kind ?? 'image', channel.bodyShape)
  return kind ? { ...channel, kind } : null
}

export function readMediaChannels(): { channels: MediaChannel[]; problem?: string } {
  const path = mediaChannelsPath()
  if (!existsSync(path)) return { channels: [] }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as MediaChannelsFile
    const channels = (parsed.channels ?? [])
      .filter(
        (channel): channel is MediaChannel =>
          typeof channel?.id === 'string' &&
          typeof channel?.baseUrl === 'string' &&
          channel.protocol === 'openai-image',
      )
      .map((channel) => withPreset({ ...channel, models: channel.models ?? [] }))
      .map(normalizeDeclaredKinds)
      .filter((channel): channel is MediaChannel => channel !== null)
    return { channels }
  } catch (error) {
    return {
      channels: [],
      problem: `${path} 读不了：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

export function writeMediaChannels(channels: MediaChannel[]): void {
  const path = mediaChannelsPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify({ channels }, null, 2)}\n`, 'utf8')
}

/** An account is usable unless somebody turned it off. */
export function isChannelEnabled(channel: MediaChannel): boolean {
  return channel.enabled !== false
}

/** Who the account is with: explicit, else the preset, else `custom`. */
export function providerTypeOf(
  channel: Pick<MediaChannel, 'providerType' | 'preset'>,
): MediaProviderType {
  return channel.providerType ?? channel.preset ?? 'custom'
}

/** Whether the vendor's catalogue is authoritative, or a relay may invent ids. */
export function modelIdSourceOf(
  channel: Pick<MediaChannel, 'modelIdSource' | 'preset'>,
): ModelIdSource {
  if (channel.modelIdSource) return channel.modelIdSource
  return channel.preset ? 'registered' : 'open'
}

/** The catalogue ID a channel declares for a vendor model, if it declares one. */
export function modelCatalogIdOf(
  channel: Pick<MediaChannel, 'modelCatalogId'>,
  model?: string | null,
): string | null {
  if (!model) return null
  return channel.modelCatalogId?.[model] ?? null
}

/**
 * The old `chat` preset was an image-shaped account that posted to `/chat/completions`. Reading a
 * picture is an AI-connection job now; the row may still be on disk, but it must never be handed
 * back as the account that draws.
 */
export function isLegacyChatChannel(channel: MediaChannel): boolean {
  return channel.preset === 'chat' || channel.id === 'chat'
}

/**
 * The accounts that can make `kind` and are turned on, best first.
 *
 * "Best" is what makes a run likely to succeed: an account that lists the model the caller named,
 * then one that has a key, then one that lists any model at all. Ties keep file order, so the
 * choice is predictable and the account a person put first stays the default. A disabled or legacy
 * account is never a candidate — those were turned off (or are not media accounts) on purpose.
 */
export function enabledChannelsFor(
  channels: MediaChannel[],
  kind?: MediaKind,
  model?: string,
): MediaChannel[] {
  const wanted = model?.trim()
  const ranked: Array<{ channel: MediaChannel; score: number }> = []
  for (const channel of channels) {
    if (isLegacyChatChannel(channel) || !isChannelEnabled(channel)) continue
    const applied = kind ? channelForKind(channel, kind) : applyDefaultKind(channel)
    if (!applied) continue
    const score =
      (wanted && applied.models.includes(wanted) ? 8 : 0) +
      (mediaChannelKey(applied) ? 4 : 0) +
      (applied.models.length > 0 ? 2 : 0)
    ranked.push({ channel: applied, score })
  }
  // Array#sort is stable, so equal scores keep the order the file declared.
  return ranked.sort((a, b) => b.score - a.score).map((entry) => entry.channel)
}

/**
 * The account a person's speech setting points at, as the capability that does `kind`.
 *
 * A named account must still be enabled and capable: the answer is null rather than a different
 * account, because the setting named one and a silent substitution would use an account the person
 * did not choose. An empty choice means "the first account that can", resolved when the work runs.
 */
export function channelForChoice(
  channels: MediaChannel[],
  kind: MediaKind,
  choice: { channelId?: string; model?: string },
): MediaChannel | null {
  const capable = enabledChannelsFor(channels, kind, choice.model)
  if (choice.channelId) return capable.find((channel) => channel.id === choice.channelId) ?? null
  return capable[0] ?? null
}

/**
 * The channel a card asked for, or the first one that can make what it asked for.
 *
 * A video card must not be handed the image channel: it would "succeed" and write a picture into a
 * node that promised a film. `kind` is the one fact a card knows about what it wants — and an
 * account may offer several, so the answer is always the account *as that capability*. `model`
 * breaks ties between accounts that all make the kind: the one that lists it is preferred.
 */
export function resolveMediaChannel(
  id?: string,
  kind?: MediaKind,
  model?: string,
): MediaChannel | null {
  const { channels } = readMediaChannels()
  if (id) {
    const named = channels.find((channel) => channel.id === id && !isLegacyChatChannel(channel))
    if (!named) return null
    return kind ? channelForKind(named, kind) : applyDefaultKind(named)
  }
  return enabledChannelsFor(channels, kind, model)[0] ?? null
}

/** A channel as its first capability, for a caller that did not say which one it wants. */
function applyDefaultKind(channel: MediaChannel): MediaChannel {
  return channelForKind(channel) ?? channel
}

/**
 * The key for a channel.
 *
 * An environment variable wins, so a key can live in a shell profile rather than in a JSON file that
 * ends up in somebody's backup.
 */
export function mediaChannelKey(channel: MediaChannel): string {
  if (channel.apiKeyEnv) {
    const fromEnv = process.env[channel.apiKeyEnv]
    if (fromEnv && fromEnv.trim()) return fromEnv.trim()
  }
  return channel.apiKey?.trim() ?? ''
}

/** The model to use: what the card asked for, else the channel's default, else its first. */
export function mediaChannelModel(channel: MediaChannel, requested?: string): string {
  return requested?.trim() || channel.defaultModel?.trim() || channel.models[0] || ''
}
