/**
 * Where a person connects the accounts that draw pictures and films.
 *
 * The page has two layers. A connection is one account: a provider, a key, and the models that
 * account offers — the catalogue, laid out flat, not the choice. Under each capability the person
 * adds the models they want one at a time from a dropdown of that catalogue; the rows there are
 * the agent's options. A capability that needs another host is another account. The choice lists,
 * video modes, wire paths, authentication and reference upload are all preset-supplied and folded
 * under "高级", because most people never need them and everybody else can still reach them.
 *
 * The key is the one thing the renderer never receives. It types a key once, the server writes it to
 * the credential store, and later reads only learn *whether* a key exists. A channel left without a
 * key or a model is refused rather than saved: a canvas that fails at the first ✨ is a worse teacher.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, ChevronUp, Plus, RefreshCw, Save, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SettingsCard } from './SettingsCard'
import { SettingsSection } from './SettingsSection'
import { paramSpecsOf, type MediaParamSpec } from '@craft-agent/shared/media/params'
import type { MediaModelInfo } from '@craft-agent/shared/media/model-catalog'
import type { MediaKind, MediaModelWire } from '@craft-agent/shared/media/channels'
import { findMediaProtocol, protocolsForKind } from '@craft-agent/shared/media/protocols'
import type { MediaMode } from '@craft-agent/shared/media/modes'
import { ModelCapabilitySummary } from '@/components/media/ModelCapabilitySummary'

type Kind = 'image' | 'video' | 'music' | 'tts'

const selectClass =
  'h-9 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring'

/** The order capabilities are shown in: pictures, films, then sound out. */
const KIND_ORDER: Kind[] = ['image', 'video', 'music', 'tts']

const KIND_LABEL: Record<Kind, string> = {
  image: 'mediaChannels.kindImage',
  video: 'mediaChannels.kindVideo',
  music: 'mediaChannels.kindMusic',
  tts: 'mediaChannels.kindTts',
}

/** One colour per capability, so a row of them reads at a glance instead of as one grey word. */
const KIND_STYLE: Record<Kind, string> = {
  image: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300',
  video: 'border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300',
  music: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  tts: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
}

function KindBadge({
  kind,
  label,
  className,
}: {
  kind: Kind
  label: string
  className?: string
}) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-md border px-1.5 py-0 text-[10px] font-medium ${KIND_STYLE[kind]} ${className ?? ''}`}
    >
      {label}
    </span>
  )
}

/** Values typed into one row: commas (either width), enumeration commas and spaces all split. */
const splitValues = (text: string): string[] => [
  ...new Set(
    text
      .split(/[,，、\s]+/)
      .map((value) => value.trim())
      .filter(Boolean),
  ),
]

const PARAM_TYPES = ['select', 'number', 'text'] as const
type ParamType = (typeof PARAM_TYPES)[number]

/** One parameter as the page edits it: numbers stay as typed text until the save. */
interface ParamDraft {
  key: string
  label?: string
  type: ParamType
  optionsText: string
  defaultText: string
  minText: string
  maxText: string
  stepText: string
  modelsText: string
  /** The options are suggestions; a value outside them is still sent. */
  allowCustom?: boolean
}

const numberText = (value: number | undefined): string => (value === undefined ? '' : String(value))

const numberOf = (text: string): number | undefined => {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  const value = Number(trimmed)
  return Number.isFinite(value) ? value : undefined
}

const allNumeric = (values: string[]): boolean =>
  values.length > 0 && values.every((value) => value.trim() !== '' && Number.isFinite(Number(value)))

const paramDraftOf = (spec: MediaParamSpec): ParamDraft => ({
  key: spec.key,
  label: spec.label,
  type: spec.type,
  optionsText: spec.options?.map(String).join(', ') ?? '',
  defaultText: spec.default !== undefined ? String(spec.default) : '',
  minText: numberText(spec.min),
  maxText: numberText(spec.max),
  stepText: numberText(spec.step),
  modelsText: spec.models?.join(', ') ?? '',
  allowCustom: spec.allowCustom,
})

const blankParam = (): ParamDraft => ({
  key: '',
  type: 'select',
  optionsText: '',
  defaultText: '',
  minText: '',
  maxText: '',
  stepText: '',
  modelsText: '',
})

/** One parameter back as the panel reads it; a row without a key is not a parameter. */
const specOfDraft = (draft: ParamDraft): MediaParamSpec | null => {
  const key = draft.key.trim()
  if (!key) return null
  const spec: MediaParamSpec = { key, type: draft.type }
  if (draft.label?.trim()) spec.label = draft.label.trim()
  if (draft.type === 'select') {
    const raw = splitValues(draft.optionsText)
    if (raw.length > 0) spec.options = allNumeric(raw) ? raw.map(Number) : raw
  }
  const defaultText = draft.defaultText.trim()
  if (defaultText) {
    // A duration is a number even when its options were typed as text; a ratio never is.
    const numeric = draft.type === 'number' || allNumeric((spec.options ?? []).map(String))
    spec.default = numeric ? (numberOf(defaultText) ?? defaultText) : defaultText
  }
  if (draft.type === 'number') {
    const min = numberOf(draft.minText)
    const max = numberOf(draft.maxText)
    const step = numberOf(draft.stepText)
    if (min !== undefined) spec.min = min
    if (max !== undefined) spec.max = max
    if (step !== undefined) spec.step = step
  }
  const models = splitValues(draft.modelsText)
  if (models.length > 0) spec.models = models
  if (draft.allowCustom) spec.allowCustom = true
  return spec
}

const specsFromDraft = (endpoint: EndpointDraft): MediaParamSpec[] =>
  endpoint.params.flatMap((param) => {
    const spec = specOfDraft(param)
    return spec ? [spec] : []
  })

/** The wire, as the advanced area edits it. A blank path keeps the preset's value. */
interface WireDraft {
  submitPath: string
  editPath: string
  pollPath: string
  cancelPath: string
  taskIdPath: string
  statusPath: string
  resultPath: string
  pollMs: string
  bodyShape: string
  responseShape: string
}

interface WireInfo {
  /** A host this capability uses instead of the account's (Bailian's Qwen-Image door). */
  baseUrl?: string
  submitPath?: string
  editPath?: string
  pollPath?: string
  cancelPath?: string
  taskIdPath?: string
  statusPath?: string
  resultPath?: string
  pollMs?: number
  bodyShape?: string
  responseShape?: string
  /** Fixed submit headers a provider needs; carried through so a merged connection keeps them. */
  submitHeaders?: Record<string, string>
  /** Protocol ids for models that speak differently from the capability. */
  modelProtocols?: Record<string, string>
  /** Models whose protocol differs from the capability's default. */
  modelWires?: Record<string, MediaModelWire>
}

const wireDraftOf = (info?: WireInfo): WireDraft => ({
  submitPath: info?.submitPath ?? '',
  editPath: info?.editPath ?? '',
  pollPath: info?.pollPath ?? '',
  cancelPath: info?.cancelPath ?? '',
  taskIdPath: info?.taskIdPath ?? '',
  statusPath: info?.statusPath ?? '',
  resultPath: info?.resultPath ?? '',
  pollMs: numberText(info?.pollMs),
  bodyShape: info?.bodyShape ?? '',
  responseShape: info?.responseShape ?? '',
})

/** The paths as typed; a blank one is sent empty so a cleared path stops overriding the preset. */
const WIRE_PATH_KEYS = [
  'submitPath',
  'editPath',
  'pollPath',
  'cancelPath',
  'taskIdPath',
  'statusPath',
  'resultPath',
] as const

const wireFromDraft = (wire: WireDraft): Record<string, string | number> => {
  const next: Record<string, string | number> = {}
  for (const key of WIRE_PATH_KEYS) next[key] = wire[key].trim()
  const pollMs = numberOf(wire.pollMs)
  if (pollMs !== undefined && pollMs > 0) next.pollMs = Math.round(pollMs)
  // An empty shape is not a shape: leaving it out keeps whatever the preset supplied.
  if (wire.bodyShape) next.bodyShape = wire.bodyShape
  if (wire.responseShape) next.responseShape = wire.responseShape
  return next
}

const WIRE_TEXT_FIELDS: Array<{ key: (typeof WIRE_PATH_KEYS)[number]; label: string; placeholder: string }> = [
  { key: 'submitPath', label: 'mediaChannels.wireSubmitPath', placeholder: '/images/generations' },
  { key: 'editPath', label: 'mediaChannels.wireEditPath', placeholder: '/images/edits' },
  { key: 'pollPath', label: 'mediaChannels.wirePollPath', placeholder: '/tasks/{taskId}' },
  { key: 'cancelPath', label: 'mediaChannels.wireCancelPath', placeholder: '/tasks/{taskId}/cancel' },
  { key: 'taskIdPath', label: 'mediaChannels.wireTaskIdPath', placeholder: 'task_id' },
  { key: 'statusPath', label: 'mediaChannels.wireStatusPath', placeholder: 'status' },
  { key: 'resultPath', label: 'mediaChannels.wireResultPath', placeholder: 'data.0.url' },
]

/** One capability of an account, as the page edits it. */
interface EndpointDraft {
  kind: Kind
  /** This account offers it. Unticking removes the capability on save. */
  enabled: boolean
  /** The catalog this account can reach. */
  models: string[]
  /** The subset the agent may use, chosen in the capability sections. */
  enabledModels: string[]
  /** The model list as text, for the advanced editor (typing a comma must not eat itself). */
  modelsText: string
  /** Catalogue id and declared rules per model, for the read-only capability line. */
  modelInfo?: MediaModelInfo[]
  /** Every choice the panel offers, edited as typed text so a comma does not split mid-word. */
  params: ParamDraft[]
  /** Which models edit a clip rather than generate one. */
  modelModes: Record<string, MediaMode>
  /** Where this capability posts and how it reads the answer — editable in 高级. */
  wire: WireDraft
  /** A host this capability uses instead of the account's; blank means the account's. */
  baseUrl: string
  /** Fixed headers the provider requires; carried through so a save cannot drop them. */
  submitHeaders?: Record<string, string>
  /** Per-model protocols: a model whose wire differs from the capability's default. */
  modelWires: Record<string, MediaModelWire>
  /** Which protocol each model names, when it is not the capability's default. */
  modelProtocols: Record<string, string>
}

interface ChannelDraft {
  id: string
  name: string
  baseUrl: string
  apiKeyEnv: string
  /** Turned off without being deleted: kept, but never chosen automatically. */
  enabled: boolean
  /** A key exists on the server. The key itself never travels to this page. */
  hasKey: boolean
  /** Typed in this session only. */
  apiKey: string
  /** The person asked to forget the stored key; sent as an explicit empty string. */
  clearKey: boolean
  preset?: string
  /** Who the account is with, and who names its models. Carried through so a save cannot drop it. */
  providerType?: string
  modelIdSource?: 'registered' | 'open'
  /** The header that carries the key, for providers that do not use `Authorization`. */
  authHeader: string
  authPrefix: string
  /** Where a local reference is uploaded first, for providers that want an id rather than bytes. */
  uploadPath: string
  uploadPurpose: string
  uploadRefPrefix: string
  /** One row per use, always all four; only `enabled` ones are saved. */
  endpoints: EndpointDraft[]
}

interface PresetEndpoint extends WireInfo {
  kind: MediaKind
  models?: string[]
  modelInfo?: MediaModelInfo[]
  defaultModel?: string
  paramSpecs?: MediaParamSpec[]
}

interface PresetOption {
  id: string
  name: string
  protocol?: string
  kind?: MediaKind
  baseUrl?: string
  models?: string[]
  defaultModel?: string
  modelInfo?: MediaModelInfo[]
  /** The preset's own choices, so a new channel starts with the provider's lists filled in. */
  paramSpecs?: MediaParamSpec[]
  endpoints?: PresetEndpoint[]
  docs?: string
  providerType?: string
  modelIdSource?: 'registered' | 'open'
}

interface ProbeReply {
  ok: boolean
  reason?: 'key' | 'model' | 'unsupported' | 'network' | 'server'
  status?: number
  models: string[]
  detail?: string
}

const CUSTOM_PRESET = '__custom'

/** The presets folded into one connection: one account, one key, one entry. */
interface ProviderGroup {
  id: string
  name: string
  presets: PresetOption[]
  declared: PresetEndpoint[]
  kinds: Kind[]
  baseUrl?: string
}

/** The host a preset talks to. One host plus one key is one account. */
const hostOf = (url?: string): string => {
  if (!url) return ''
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** One declaration per capability; the first preset that declares one supplies its wire. */
const declaredEndpoints = (presets: PresetOption[]): PresetEndpoint[] => {
  const byKind = new Map<MediaKind, PresetEndpoint>()
  for (const preset of presets) {
    const declarations: PresetEndpoint[] = preset.endpoints?.length
      ? preset.endpoints
      : [
          {
            kind: preset.kind ?? 'image',
            models: preset.models,
            modelInfo: preset.modelInfo,
            defaultModel: preset.defaultModel,
            paramSpecs: preset.paramSpecs,
          },
        ]
    for (const declaration of declarations) {
      if (!byKind.has(declaration.kind)) byKind.set(declaration.kind, declaration)
    }
  }
  return [...byKind.values()]
}

/** The order vendors are offered in: the two Volcengine accounts first, then the better-known ones. */
const PROVIDER_ORDER = [
  'volcengine-ark',
  'volcengine',
  'bailian',
  'minimax',
  'openai',
  'xai',
  'google',
]

const providerRank = (group: ProviderGroup): number => {
  // A relay that borrows a vendor's name sorts after that vendor, not among its accounts.
  if (group.presets.some((preset) => preset.id === 'metaso')) return 90
  const type = group.presets[0]?.providerType ?? ''
  const at = PROVIDER_ORDER.indexOf(type)
  return at === -1 ? 50 : at
}

const splitModels = (text: string): string[] => [
  ...new Set(
    text
      .split(',')
      .map((model) => model.trim())
      .filter(Boolean),
  ),
]

/** One capability, from what the server said (or from a preset), or blank when it is not offered. */
const endpointDraft = (
  kind: Kind,
  info?: {
    models?: string[]
    enabledModels?: string[]
    modelInfo?: MediaModelInfo[]
    paramSpecs?: MediaParamSpec[]
    options?: Record<string, Array<string | number> | undefined>
    params?: Record<string, string | number>
    modelModes?: Record<string, MediaMode>
  } & WireInfo,
): EndpointDraft => {
  const models = info?.models ?? []
  const specs = info?.paramSpecs?.length
    ? info.paramSpecs
    : paramSpecsOf({ options: info?.options, params: info?.params })
  return {
    kind,
    enabled: info !== undefined,
    models,
    // A new connection starts with every catalog model enabled; a capability section can then
    // remove the ones it should not use.
    enabledModels: info?.enabledModels ?? models,
    modelsText: models.join(', '),
    modelInfo: info?.modelInfo,
    params: (specs ?? []).map(paramDraftOf),
    modelModes: info?.modelModes ?? {},
    wire: wireDraftOf(info),
    baseUrl: info?.baseUrl ?? '',
    submitHeaders: info?.submitHeaders,
    modelWires: info?.modelWires ?? {},
    modelProtocols: info?.modelProtocols ?? {},
  }
}

const toDraft = (
  channel: Awaited<ReturnType<typeof window.electronAPI.mediaChannels>>['channels'][number],
): ChannelDraft => {
  // Every channel arrives with at least one capability; older ones arrive as a one-item list.
  const declared = channel.endpoints?.length
    ? channel.endpoints
    : [
        {
          kind: (channel.kind ?? 'image') as Kind,
          models: channel.models,
          modelInfo: channel.modelInfo,
          paramSpecs: channel.paramSpecs,
          options: channel.options,
          modelModes: channel.modelModes,
          params: channel.params,
        },
      ]
  return {
    id: channel.id,
    name: channel.name,
    baseUrl: channel.baseUrl ?? '',
    apiKeyEnv: channel.apiKeyEnv ?? '',
    enabled: channel.enabled !== false,
    hasKey: Boolean(channel.hasKey),
    apiKey: '',
    clearKey: false,
    preset: channel.preset,
    providerType: channel.providerType,
    modelIdSource: channel.modelIdSource,
    authHeader: channel.auth?.header ?? '',
    authPrefix: channel.auth?.prefix ?? '',
    uploadPath: channel.upload?.path ?? '',
    uploadPurpose: channel.upload?.purpose ?? '',
    uploadRefPrefix: channel.upload?.refPrefix ?? '',
    endpoints: KIND_ORDER.map((kind) => endpointDraft(kind, declared.find((entry) => entry.kind === kind))),
  }
}

export function MediaChannelsSection() {
  const { t } = useTranslation()
  const [drafts, setDrafts] = React.useState<ChannelDraft[]>([])
  const [presets, setPresets] = React.useState<PresetOption[]>([])
  const [openId, setOpenId] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [busyId, setBusyId] = React.useState<string | null>(null)
  const [problem, setProblem] = React.useState<string | undefined>()
  /** Any edit is only in this page until Save; the button says whether there is one. */
  const [dirty, setDirty] = React.useState(false)
  /** The connection being created: a provider and its key come before any model is chosen. */
  const [addingConnection, setAddingConnection] = React.useState(false)

  const kindLabels = React.useMemo(
    () =>
      Object.fromEntries(KIND_ORDER.map((kind) => [kind, t(KIND_LABEL[kind])])) as Record<Kind, string>,
    [t],
  )

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const reply = await window.electronAPI.mediaChannels()
      setDrafts(reply.channels.map(toDraft))
      setPresets(reply.presets ?? [])
      setProblem(reply.problem)
      setDirty(false)
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  const patch = (id: string, next: Partial<ChannelDraft>) => {
    setDirty(true)
    setDrafts((current) => current.map((channel) => (channel.id === id ? { ...channel, ...next } : channel)))
  }

  const patchEndpoint = (id: string, kind: Kind, next: Partial<EndpointDraft>) => {
    setDirty(true)
    setDrafts((current) =>
      current.map((channel) =>
        channel.id === id
          ? {
              ...channel,
              endpoints: channel.endpoints.map((endpoint) =>
                endpoint.kind === kind ? { ...endpoint, ...next } : endpoint,
              ),
            }
          : channel,
      ),
    )
  }

  const patchParam = (
    id: string,
    kind: Kind,
    index: number,
    next: Partial<ParamDraft>,
  ) => {
    setDirty(true)
    setDrafts((current) =>
      current.map((channel) =>
        channel.id === id
          ? {
              ...channel,
              endpoints: channel.endpoints.map((endpoint) =>
                endpoint.kind === kind
                  ? {
                      ...endpoint,
                      params: endpoint.params.map((param, at) =>
                        at === index ? { ...param, ...next } : param,
                      ),
                    }
                  : endpoint,
              ),
            }
          : channel,
      ),
    )
  }

  /**
   * The providers a connection can be made for.
   *
   * A connection is one account: one host and one key. Everything a provider sells from that host
   * under that key is folded into one entry — Volcengine's image and video, MiniMax's four uses,
   * or Bailian's image, video and speech.
   */
  const providerGroups = React.useMemo((): ProviderGroup[] => {
    // One host plus one key is one account: every capability that talks to the same host with the
    // same key is one entry. A capability that needs another host is another account.
    const byAccount = new Map<string, PresetOption[]>()
    for (const preset of presets) {
      const provider = preset.providerType ?? preset.id
      byAccount.set(`${provider}|${hostOf(preset.baseUrl)}`, [
        ...(byAccount.get(`${provider}|${hostOf(preset.baseUrl)}`) ?? []),
        preset,
      ])
    }
    const entries = [...byAccount.entries()].map(([id, list]) => {
      // Every preset the server sends carries an endpoint list, so "has endpoints" cannot tell the
      // account preset apart from a per-capability one. The account declares more than one
      // capability, and its wires must win: MiniMax's image kind is H3-Image, not the older
      // image-01 preset that happens to sit earlier in the catalogue.
      const capabilitiesOf = (preset: PresetOption): number =>
        new Set((preset.endpoints ?? []).map((endpoint) => endpoint.kind)).size
      const ordered = [...list].sort((a, b) => capabilitiesOf(b) - capabilitiesOf(a))
      const declared = declaredEndpoints(ordered)
      // Badges read in the page's own order, whatever order the presets were written in.
      const kinds = KIND_ORDER.filter((kind) => declared.some((entry) => entry.kind === kind))
      // A connection made of presets named after different capabilities takes the vendor's name:
      // "阿里云百炼 Qwen-TTS" + "阿里云百炼 万相" is the account "阿里云百炼". An all-in-one
      // preset already names the account ("MiniMax 官方"), so that name wins.
      const stripped = ordered.map((preset) => (preset.name ?? id).replace(/\s*[（(][^）)]*[）)]\s*$/, ''))
      const heads = stripped.map((name) => name.split(/\s+/)[0])
      const account = ordered.find((preset) => capabilitiesOf(preset) > 1)
      const name = account
        ? (account.name ?? id).replace(/\s*[（(][^）)]*[）)]\s*$/, '')
        : ordered.length > 1 && heads.every((head) => head === heads[0])
          ? (heads[0] ?? id)
          : stripped[0]!
      return {
        id,
        name,
        presets: ordered,
        declared,
        kinds,
        // The account's own base is the fallback; a capability that names one overrides it.
        baseUrl: ordered.find((preset) => preset.baseUrl)?.baseUrl,
      }
    })
    return entries.sort(
      (a, b) => providerRank(a) - providerRank(b) || a.name.localeCompare(b.name),
    )
  }, [presets])

  /** The model ids a preset offers for one capability. */
  const modelsOfPreset = (preset: PresetOption | undefined, kind: Kind): string[] => {
    if (!preset) return []
    const endpoint = preset.endpoints?.find((entry) => entry.kind === kind)
    if (endpoint) return endpoint.models ?? []
    return (preset.kind ?? 'image') === kind ? (preset.models ?? []) : []
  }

  /** The connections that already offer one capability — the only ones a model can come from. */
  const connectionsForKind = (kind: Kind): ChannelDraft[] =>
    drafts.filter((draft) => draft.endpoints.some((entry) => entry.kind === kind && entry.enabled))

  /** What one connection can offer under a capability: its selected models plus its preset's. */
  const connectionModels = (draft: ChannelDraft | undefined, kind: Kind): string[] => {
    if (!draft) return []
    const endpoint = draft.endpoints.find((entry) => entry.kind === kind)
    const preset = presets.find((entry) => entry.id === draft.preset)
    return [...new Set([...(endpoint?.models ?? []), ...modelsOfPreset(preset, kind)])]
  }

  /** Enable or disable one model under one capability — the user-side selection, not the catalog. */
  const toggleModel = (
    draft: ChannelDraft,
    endpoint: EndpointDraft,
    model: string,
    next: boolean,
  ) => {
    if (next) {
      patchEndpoint(draft.id, endpoint.kind, {
        enabledModels: endpoint.enabledModels.includes(model)
          ? endpoint.enabledModels
          : [...endpoint.enabledModels, model],
      })
      return
    }
    patchEndpoint(draft.id, endpoint.kind, {
      enabledModels: endpoint.enabledModels.filter((entry) => entry !== model),
    })
  }

  /** Move a model within the person's order; that order is what a new run starts from. */
  const moveModel = (draft: ChannelDraft, endpoint: EndpointDraft, model: string, delta: number) => {
    const at = endpoint.enabledModels.indexOf(model)
    const to = at + delta
    if (at < 0 || to < 0 || to >= endpoint.enabledModels.length) return
    const enabledModels = [...endpoint.enabledModels]
    enabledModels.splice(at, 1)
    enabledModels.splice(to, 0, model)
    patchEndpoint(draft.id, endpoint.kind, { enabledModels })
  }

  /** A connection is added first: provider, then its key and models in the editor below. */
  const addConnection = (groupId: string) => {
    const group = providerGroups.find((entry) => entry.id === groupId)
    const preset = group?.presets[0]
    const declared = group?.declared ?? []
    // A stable id nobody can collide with: two of the same provider added in one breath used to
    // share a four-character timestamp suffix, and the save merges by id.
    const id = `${groupId === CUSTOM_PRESET ? 'custom' : (preset?.providerType ?? 'provider')}-${crypto.randomUUID().slice(0, 8)}`
    setDirty(true)
    setDrafts((current) => [
      ...current,
      {
        id,
        name: group?.name ?? '',
        baseUrl: group?.baseUrl ?? '',
        apiKeyEnv: '',
        enabled: true,
        hasKey: false,
        apiKey: '',
        clearKey: false,
        preset: preset?.id,
        providerType: preset?.providerType,
        modelIdSource: preset?.modelIdSource,
        authHeader: '',
        authPrefix: '',
        uploadPath: '',
        uploadPurpose: '',
        uploadRefPrefix: '',
        // One connection, every capability its presets declare. The first declaration of a kind
        // wins; a duplicate kind is the same wire written twice. The catalogue comes with the
        // preset, but nothing is enabled: which models the agent may use is chosen per capability.
        endpoints: KIND_ORDER.map((kind) => ({
          ...endpointDraft(kind, declared.find((entry) => entry.kind === kind)),
          enabledModels: [],
        })),
      },
    ])
    setOpenId(id)
    setAddingConnection(false)
  }

  const probe = (draft: ChannelDraft, kind: Kind, model?: string): Promise<ProbeReply> =>
    window.electronAPI.mediaChannelsProbe({
      channelId: draft.id,
      preset: draft.preset,
      kind,
      baseUrl: draft.baseUrl,
      // `undefined` means "use the stored key"; an explicit empty string means "there is none".
      apiKey: draft.apiKey || (draft.clearKey ? '' : undefined),
      apiKeyEnv: draft.apiKeyEnv || undefined,
      model,
    })

  const describeProbe = (reply: ProbeReply): { tone: 'ok' | 'warn' | 'error'; text: string } => {
    if (reply.ok) {
      return reply.reason === 'model'
        ? { tone: 'warn', text: t('mediaChannels.testModel') }
        : { tone: 'ok', text: t('mediaChannels.testOk') }
    }
    switch (reply.reason) {
      case 'key':
        return { tone: 'error', text: t('mediaChannels.testKey') }
      case 'unsupported':
        return { tone: 'warn', text: t('mediaChannels.testUnsupported') }
      case 'network':
        return { tone: 'error', text: t('mediaChannels.testNetwork') }
      default:
        return {
          tone: 'error',
          text: t('mediaChannels.testServer', { status: reply.status ?? '?' }),
        }
    }
  }

  const test = async (draft: ChannelDraft, kind?: Kind) => {
    // A kind tests that capability; omitted, the first enabled one. An account's picture and its
    // speech endpoint are different wires, so one passing does not mean the other does.
    const target = kind
      ? draft.endpoints.find((endpoint) => endpoint.kind === kind && endpoint.enabled)
      : draft.endpoints.find((endpoint) => endpoint.enabled)
    if (!target) return
    setBusyId(draft.id)
    try {
      const reply = await probe(draft, target.kind, target.enabledModels[0])
      const { tone, text } = describeProbe(reply)
      if (tone === 'ok') toast.success(text)
      else if (tone === 'warn') toast.warning(text)
      else toast.error(text)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusyId(null)
    }
  }

  const readModels = async (draft: ChannelDraft, endpoint: EndpointDraft) => {
    setBusyId(draft.id)
    try {
      const reply = await probe(draft, endpoint.kind)
      if (!reply.ok) {
        const { tone, text } = describeProbe(reply)
        if (tone === 'ok') toast.success(text)
        else if (tone === 'warn') toast.warning(text)
        else toast.error(text)
        return
      }
      if (reply.models.length === 0) {
        toast.warning(t('mediaChannels.testUnsupported'))
        return
      }
      // A model the account no longer offers cannot stay enabled; the person's order survives a refresh.
      const enabledModels = endpoint.enabledModels.filter((model) => reply.models.includes(model))
      patchEndpoint(draft.id, endpoint.kind, {
        models: reply.models,
        modelsText: reply.models.join(', '),
        enabledModels,
      })
      toast.success(t('mediaChannels.modelsLoaded', { count: reply.models.length }))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusyId(null)
    }
  }

  const save = async () => {
    for (const draft of drafts) {
      // A disabled account is not in use, so its missing key or model must not block saving the
      // accounts that are.
      if (!draft.enabled) continue
      const name = draft.name || draft.id
      const active = draft.endpoints.filter((endpoint) => endpoint.enabled)
      for (const endpoint of active) {
        if (endpoint.models.length === 0) {
          toast.error(
            t('mediaChannels.errorNoModel', { name: `${name} · ${kindLabels[endpoint.kind]}` }),
          )
          setOpenId(draft.id)
          return
        }
      }
      // Every remaining account is a paid provider: a key is what makes it usable at all.
      const hasKey = Boolean(draft.apiKey) || draft.hasKey || Boolean(draft.apiKeyEnv)
      if (!hasKey) {
        toast.error(t('mediaChannels.errorNoKey', { name }))
        setOpenId(draft.id)
        return
      }
    }

    setSaving(true)
    try {
      const channels = drafts.map((draft) => {
        const endpoints = draft.endpoints
          .filter((endpoint) => endpoint.enabled)
          .map((endpoint) => {
            const paramSpecs = specsFromDraft(endpoint)
            const modelModes =
              endpoint.kind === 'video'
                ? Object.fromEntries(
                    Object.entries(endpoint.modelModes).filter(([model]) =>
                      endpoint.models.includes(model),
                    ),
                  )
                : {}
            return {
              kind: endpoint.kind,
              models: endpoint.models,
              enabledModels: endpoint.enabledModels,
              // An empty list is a decision — every row was removed — so it is sent as `[]`.
              paramSpecs,
              modelModes: Object.keys(modelModes).length > 0 ? modelModes : undefined,
              ...(endpoint.baseUrl.trim() ? { baseUrl: endpoint.baseUrl.trim() } : {}),
              ...(endpoint.submitHeaders ? { submitHeaders: endpoint.submitHeaders } : {}),
              ...(Object.keys(endpoint.modelProtocols).length
                ? { modelProtocols: endpoint.modelProtocols }
                : {}),
              ...(Object.keys(endpoint.modelWires).length
                ? { modelWires: endpoint.modelWires }
                : {}),
              ...wireFromDraft(endpoint.wire),
            }
          })
        const first = endpoints[0]
        const authHeader = draft.authHeader.trim()
        const auth = authHeader ? { header: authHeader, prefix: draft.authPrefix } : undefined
        const uploadPath = draft.uploadPath.trim()
        const upload = uploadPath
          ? {
              path: uploadPath,
              purpose: draft.uploadPurpose.trim(),
              refPrefix: draft.uploadRefPrefix.trim(),
            }
          : undefined
        return {
          id: draft.id,
          name: draft.name || draft.id,
          protocol: 'openai-image',
          baseUrl: draft.baseUrl,
          apiKeyEnv: draft.apiKeyEnv || undefined,
          ...(draft.providerType ? { providerType: draft.providerType } : {}),
          ...(draft.modelIdSource ? { modelIdSource: draft.modelIdSource } : {}),
          ...(draft.enabled ? {} : { enabled: false }),
          ...(auth ? { auth } : {}),
          ...(upload ? { upload } : {}),
          endpoints,
          // Older readers ask the channel for one kind and one model list; the first capability
          // answers, which is what the file used to hold.
          ...(first ? { kind: first.kind, models: first.models } : {}),
          ...(draft.apiKey ? { apiKey: draft.apiKey } : draft.clearKey ? { apiKey: '' } : {}),
        }
      })
      const reply = await window.electronAPI.mediaChannelsSave({ channels })
      if (!reply.ok) throw new Error(reply.message ?? t('mediaChannels.saveFailed'))
      toast.success(t('mediaChannels.saved'))
      await load()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  /** One capability's everyday editor: which model it uses, and whether it answers. */
  const renderEndpointBasic = (draft: ChannelDraft, endpoint: EndpointDraft) => {
    const busy = busyId === draft.id
    // A run without a named model takes the first one the person kept, in their order.
    const effectiveModel = endpoint.enabledModels[0]
    return (
      <div key={endpoint.kind} className="space-y-2 border-t border-border/50 pt-3 first:border-t-0 first:pt-0">
        <KindBadge kind={endpoint.kind} label={kindLabels[endpoint.kind]} className="text-[11px]" />

        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Label className="text-xs">{t('mediaChannels.model')}</Label>
            <div className="ml-auto flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                className="shrink-0"
                disabled={busy}
                onClick={() => void readModels(draft, endpoint)}
              >
                <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} />
                {busy ? t('mediaChannels.reading') : t('mediaChannels.readModels')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="shrink-0"
                disabled={busy}
                onClick={() => void test(draft, endpoint.kind)}
              >
                {busy ? t('mediaChannels.testing') : t('mediaChannels.test')}
              </Button>
            </div>
          </div>
          {endpoint.models.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {endpoint.models.map((model) => (
                <span
                  key={model}
                  className="rounded border border-border/60 bg-muted/30 px-1.5 py-0.5 text-[11px] text-muted-foreground"
                >
                  {model}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-[11px] text-amber-600 dark:text-amber-400">
              {t('mediaChannels.modelHint')}
            </p>
          )}
        </div>

        <ModelCapabilitySummary
          info={
            effectiveModel
              ? endpoint.modelInfo?.find((entry) => entry.id === effectiveModel)
              : undefined
          }
          showCatalogId
        />

      </div>
    )
  }

  /**
   * One capability's fine print: the choice list, what a video model does, and the wire.
   * The preset fills all of this in, so it stays folded away until someone needs it.
   */
  const renderEndpointAdvanced = (draft: ChannelDraft, endpoint: EndpointDraft) => (
    <div
      key={endpoint.kind}
      className="space-y-3 rounded-md border border-border/60 px-3 py-3 sm:col-span-2"
    >
      <KindBadge kind={endpoint.kind} label={kindLabels[endpoint.kind]} className="text-[11px]" />

      <div className="space-y-1">
        <Label className="text-xs">{t('mediaChannels.modelsManual')}</Label>
        <Input
          value={endpoint.modelsText}
          placeholder="model-a, model-b"
          onChange={(event) => {
            const modelsText = event.target.value
            const models = splitModels(modelsText)
            // A model removed from the catalog cannot stay selected.
            const enabledModels = endpoint.enabledModels.filter((model) => models.includes(model))
            patchEndpoint(draft.id, endpoint.kind, {
              modelsText,
              models,
              enabledModels,
            })
          }}
        />
      </div>

      {endpoint.models.length > 0 ? (
        <div className="space-y-2">
          <div>
            <Label className="text-xs">{t('mediaChannels.modelProtocols')}</Label>
            <p className="text-[11px] text-muted-foreground">{t('mediaChannels.modelProtocolsHint')}</p>
          </div>
          <div className="space-y-1">
            {endpoint.models.map((model) => (
              <div key={model} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-xs">{model}</span>
                <select
                  className={`${selectClass} max-w-[180px]`}
                  value={endpoint.modelProtocols[model] ?? ''}
                  onChange={(event) => {
                    const protocol = findMediaProtocol(event.target.value)
                    const modelProtocols = { ...endpoint.modelProtocols }
                    if (protocol) modelProtocols[model] = protocol.id
                    else delete modelProtocols[model]
                    patchEndpoint(draft.id, endpoint.kind, { modelProtocols })
                  }}
                >
                  <option value="">{t('mediaChannels.protocolFollow')}</option>
                  {protocolsForKind(endpoint.kind).map((protocol) => (
                    <option key={protocol.id} value={protocol.id}>
                      {protocol.name}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="space-y-2">
          <div className="flex items-start justify-between gap-2">
            <div>
              <Label className="text-xs">{t('mediaChannels.params')}</Label>
              <p className="text-[11px] text-muted-foreground">{t('mediaChannels.paramsHint')}</p>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="shrink-0"
              onClick={() =>
                patchEndpoint(draft.id, endpoint.kind, {
                  params: [...endpoint.params, blankParam()],
                })
              }
            >
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              {t('mediaChannels.paramAdd', { defaultValue: 'Add parameter' })}
            </Button>
          </div>
          {endpoint.params.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">
              {t('mediaChannels.paramsEmpty', {
                defaultValue: 'No parameters — the model uses its own defaults.',
              })}
            </p>
          ) : null}
          {endpoint.params.map((param, index) => (
            <div key={index} className="space-y-2 rounded-md border border-border/50 px-2.5 py-2">
              <div className="flex items-center gap-2">
                <Input
                  className="h-8 text-xs"
                  value={param.key}
                  placeholder="ratio"
                  onChange={(event) =>
                    patchParam(draft.id, endpoint.kind, index, { key: event.target.value })
                  }
                />
                <select
                  className={`${selectClass} h-8 max-w-[110px]`}
                  value={param.type}
                  onChange={(event) =>
                    patchParam(draft.id, endpoint.kind, index, {
                      type: event.target.value as ParamType,
                    })
                  }
                >
                  <option value="select">
                    {t('mediaChannels.paramTypeSelect', { defaultValue: 'Select' })}
                  </option>
                  <option value="number">
                    {t('mediaChannels.paramTypeNumber', { defaultValue: 'Number' })}
                  </option>
                  <option value="text">
                    {t('mediaChannels.paramTypeText', { defaultValue: 'Text' })}
                  </option>
                </select>
                <Button
                  size="sm"
                  variant="ghost"
                  className="shrink-0 text-destructive hover:text-destructive"
                  onClick={() =>
                    patchEndpoint(draft.id, endpoint.kind, {
                      params: endpoint.params.filter((_, at) => at !== index),
                    })
                  }
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>

              {param.type === 'select' ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  <Input
                    className="h-8 text-xs"
                    value={param.optionsText}
                    placeholder={t('mediaChannels.paramsPlaceholder')}
                    onChange={(event) =>
                      patchParam(draft.id, endpoint.kind, index, {
                        optionsText: event.target.value,
                      })
                    }
                  />
                  <Input
                    className="h-8 text-xs"
                    value={param.defaultText}
                    placeholder={t('mediaChannels.paramDefault', { defaultValue: 'Default' })}
                    onChange={(event) =>
                      patchParam(draft.id, endpoint.kind, index, {
                        defaultText: event.target.value,
                      })
                    }
                  />
                </div>
              ) : param.type === 'number' ? (
                <div className="space-y-2">
                  <div className="grid gap-2 sm:grid-cols-3">
                    <Input
                      className="h-8 text-xs"
                      value={param.minText}
                      placeholder={t('mediaChannels.paramMin', { defaultValue: 'Min' })}
                      onChange={(event) =>
                        patchParam(draft.id, endpoint.kind, index, { minText: event.target.value })
                      }
                    />
                    <Input
                      className="h-8 text-xs"
                      value={param.maxText}
                      placeholder={t('mediaChannels.paramMax', { defaultValue: 'Max' })}
                      onChange={(event) =>
                        patchParam(draft.id, endpoint.kind, index, { maxText: event.target.value })
                      }
                    />
                    <Input
                      className="h-8 text-xs"
                      value={param.stepText}
                      placeholder={t('mediaChannels.paramStep', { defaultValue: 'Step' })}
                      onChange={(event) =>
                        patchParam(draft.id, endpoint.kind, index, { stepText: event.target.value })
                      }
                    />
                  </div>
                  <Input
                    className="h-8 text-xs"
                    value={param.defaultText}
                    placeholder={t('mediaChannels.paramDefault', { defaultValue: 'Default' })}
                    onChange={(event) =>
                      patchParam(draft.id, endpoint.kind, index, {
                        defaultText: event.target.value,
                      })
                    }
                  />
                </div>
              ) : (
                <Input
                  className="h-8 text-xs"
                  value={param.defaultText}
                  placeholder={t('mediaChannels.paramDefault', { defaultValue: 'Default' })}
                  onChange={(event) =>
                    patchParam(draft.id, endpoint.kind, index, {
                      defaultText: event.target.value,
                    })
                  }
                />
              )}

              <Input
                className="h-8 text-xs"
                value={param.modelsText}
                placeholder={t('mediaChannels.paramModels', {
                  defaultValue: 'Only these models (blank = all)',
                })}
                onChange={(event) =>
                  patchParam(draft.id, endpoint.kind, index, {
                    modelsText: event.target.value,
                  })
                }
              />
            </div>
          ))}
        </div>

        {endpoint.kind === 'video' && endpoint.models.length > 0 ? (
          <div className="space-y-2">
            <div>
              <Label className="text-xs">{t('mediaChannels.modelModes')}</Label>
              <p className="text-[11px] text-muted-foreground">{t('mediaChannels.modelModesHint')}</p>
            </div>
            <div className="space-y-1">
              {endpoint.models.map((model) => (
                <div key={model} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-xs">{model}</span>
                  <select
                    className={`${selectClass} max-w-[180px]`}
                    value={endpoint.modelModes[model] ?? 'generate'}
                    onChange={(event) =>
                      patchEndpoint(draft.id, endpoint.kind, {
                        modelModes: {
                          ...endpoint.modelModes,
                          [model]: event.target.value as MediaMode,
                        },
                      })
                    }
                  >
                    <option value="generate">{t('mediaChannels.modeGenerate')}</option>
                    <option value="video-edit">{t('mediaChannels.modeVideoEdit')}</option>
                  </select>
                </div>
              ))}
            </div>
          </div>
        ) : null}

      <div className="space-y-1">
        <Label className="text-xs">{t('mediaChannels.baseUrl')}</Label>
        <Input
          className="h-8 text-xs"
          value={endpoint.baseUrl}
          placeholder={draft.baseUrl || 'https://host/v1'}
          onChange={(event) =>
            patchEndpoint(draft.id, endpoint.kind, { baseUrl: event.target.value })
          }
        />
        <p className="text-[11px] text-muted-foreground">
          {t('mediaChannels.baseUrlHint')}
        </p>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        {WIRE_TEXT_FIELDS.map((field) => (
          <div key={field.key} className="space-y-1">
            <Label className="text-xs">{t(field.label)}</Label>
            <Input
              className="h-8 text-xs"
              value={endpoint.wire[field.key]}
              placeholder={field.placeholder}
              onChange={(event) =>
                patchEndpoint(draft.id, endpoint.kind, {
                  wire: { ...endpoint.wire, [field.key]: event.target.value },
                })
              }
            />
          </div>
        ))}
        <div className="space-y-1">
          <Label className="text-xs">{t('mediaChannels.wirePollMs')}</Label>
          <Input
            className="h-8 text-xs"
            value={endpoint.wire.pollMs}
            placeholder="5000"
            onChange={(event) =>
              patchEndpoint(draft.id, endpoint.kind, {
                wire: { ...endpoint.wire, pollMs: event.target.value },
              })
            }
          />
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground">
        {t('mediaChannels.wireHint', {
          defaultValue:
            'Leave a path blank to keep the preset’s value. A path may name the task id where the provider expects it.',
        })}
      </p>
    </div>
  )

  /** One connection's full editor: name, key, its models per capability, and the wire. */
  const renderConnectionEditor = (draft: ChannelDraft) => {
    const active = draft.endpoints.filter((endpoint) => endpoint.enabled)
    return (
                    <div className="mt-3 space-y-4">
                      <div className="space-y-1">
                        <Label className="text-xs">{t('mediaChannels.name')}</Label>
                        <Input
                          value={draft.name}
                          placeholder={t('mediaChannels.namePlaceholder')}
                          onChange={(event) => patch(draft.id, { name: event.target.value })}
                        />
                      </div>

                      {/* A known provider's capabilities are the preset's, not a choice. Only a
                          custom relay has to be told which kinds it serves. */}
                      {draft.preset ? null : (
                        <div className="space-y-1">
                          <Label className="text-xs">{t('mediaChannels.kind')}</Label>
                          <div className="flex flex-wrap gap-4">
                            {draft.endpoints.map((endpoint) => (
                              <label
                                key={endpoint.kind}
                                className="flex items-center gap-1.5 text-xs text-foreground"
                              >
                                <input
                                  type="checkbox"
                                  className="h-3.5 w-3.5 accent-foreground"
                                  checked={endpoint.enabled}
                                  disabled={endpoint.enabled && active.length === 1}
                                  onChange={(event) =>
                                    patchEndpoint(draft.id, endpoint.kind, {
                                      enabled: event.target.checked,
                                    })
                                  }
                                />
                                {kindLabels[endpoint.kind]}
                              </label>
                            ))}
                          </div>
                        </div>
                      )}

                      <div className="flex items-center gap-2">
                        <input
                          id={`enabled-${draft.id}`}
                          type="checkbox"
                          className="h-3.5 w-3.5 accent-foreground"
                          checked={draft.enabled}
                          onChange={(event) => patch(draft.id, { enabled: event.target.checked })}
                        />
                        <Label htmlFor={`enabled-${draft.id}`} className="text-xs">
                          {t('mediaChannels.enabled', { defaultValue: 'Enabled' })}
                        </Label>
                        {!draft.enabled ? (
                          <span className="text-[11px] text-muted-foreground">
                            {t('mediaChannels.disabledHint', {
                              defaultValue: 'Kept, but not chosen automatically.',
                            })}
                          </span>
                        ) : null}
                      </div>

                      <div className="space-y-1">
                        <Label className="text-xs">{t('mediaChannels.key')}</Label>
                        <Input
                          type="password"
                          autoComplete="off"
                          value={draft.apiKey}
                          placeholder={
                            draft.hasKey
                              ? t('mediaChannels.keyPlaceholderKeep')
                              : t('mediaChannels.keyPlaceholderNew')
                          }
                          onChange={(event) =>
                            patch(draft.id, { apiKey: event.target.value, clearKey: false })
                          }
                        />
                        {draft.hasKey ? (
                          <p className="text-[11px] text-muted-foreground">
                            <button
                              type="button"
                              className="underline underline-offset-2 hover:text-foreground"
                              onClick={() => patch(draft.id, { apiKey: '', hasKey: false, clearKey: true })}
                            >
                              {t('mediaChannels.clearKey')}
                            </button>
                          </p>
                        ) : null}
                      </div>

                      {active.map((endpoint) => renderEndpointBasic(draft, endpoint))}

                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive hover:text-destructive"
                          onClick={() => {
                            setDirty(true)
                            setDrafts((current) => current.filter((channel) => channel.id !== draft.id))
                            setOpenId(null)
                          }}
                        >
                          <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                          {t('mediaChannels.delete')}
                        </Button>
                      </div>

                      <details className="rounded-md border border-border/60 px-3 py-2">
                        <summary className="cursor-pointer text-xs text-muted-foreground">
                          {t('mediaChannels.advanced')}
                        </summary>
                        <div className="mt-3 grid gap-3 sm:grid-cols-2">
                          <div className="space-y-1 sm:col-span-2">
                            <Label className="text-xs">{t('mediaChannels.baseUrl')}</Label>
                            <Input
                              value={draft.baseUrl}
                              placeholder="https://host/v1"
                              onChange={(event) => patch(draft.id, { baseUrl: event.target.value })}
                            />
                            <p className="text-[11px] text-muted-foreground">
                              {t('mediaChannels.baseUrlHint')}
                            </p>
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs">{t('mediaChannels.apiKeyEnv')}</Label>
                            <Input
                              value={draft.apiKeyEnv}
                              placeholder="MY_API_KEY"
                              onChange={(event) => patch(draft.id, { apiKeyEnv: event.target.value })}
                            />
                          </div>

                          <div className="space-y-2 sm:col-span-2">
                            <Label className="text-xs">
                              {t('mediaChannels.auth', { defaultValue: 'Authentication' })}
                            </Label>
                            <div className="grid gap-2 sm:grid-cols-2">
                              <Input
                                className="h-8 text-xs"
                                value={draft.authHeader}
                                placeholder="Authorization"
                                onChange={(event) => patch(draft.id, { authHeader: event.target.value })}
                              />
                              <Input
                                className="h-8 text-xs"
                                value={draft.authPrefix}
                                placeholder="Bearer "
                                onChange={(event) => patch(draft.id, { authPrefix: event.target.value })}
                              />
                            </div>
                            <p className="text-[11px] text-muted-foreground">
                              {t('mediaChannels.authHint', {
                                defaultValue:
                                  'Most providers use Authorization with the Bearer prefix; Gemini uses x-goog-api-key with none. Blank keeps the preset.',
                              })}
                            </p>
                          </div>

                          <div className="space-y-2 sm:col-span-2">
                            <Label className="text-xs">
                              {t('mediaChannels.upload', { defaultValue: 'Reference upload' })}
                            </Label>
                            <div className="grid gap-2 sm:grid-cols-3">
                              <Input
                                className="h-8 text-xs"
                                value={draft.uploadPath}
                                placeholder="/v1/files/upload"
                                onChange={(event) => patch(draft.id, { uploadPath: event.target.value })}
                              />
                              <Input
                                className="h-8 text-xs"
                                value={draft.uploadPurpose}
                                placeholder="video_generation_input"
                                onChange={(event) =>
                                  patch(draft.id, { uploadPurpose: event.target.value })
                                }
                              />
                              <Input
                                className="h-8 text-xs"
                                value={draft.uploadRefPrefix}
                                placeholder="mm_file://"
                                onChange={(event) =>
                                  patch(draft.id, { uploadRefPrefix: event.target.value })
                                }
                              />
                            </div>
                            <p className="text-[11px] text-muted-foreground">
                              {t('mediaChannels.uploadHint', {
                                defaultValue:
                                  'Path, purpose and reference prefix for providers that want an uploaded id instead of inline bytes. Blank takes references inline.',
                              })}
                            </p>
                          </div>

                          {active.map((endpoint) => renderEndpointAdvanced(draft, endpoint))}
                        </div>
                      </details>
                    </div>
    )
  }

  return (
    <SettingsSection
      title={t('mediaChannels.title')}
      description={t('mediaChannels.description')}
      action={
        <div className="flex items-center gap-2">
          {dirty ? (
            <span className="text-[11px] text-muted-foreground">{t('mediaChannels.unsaved')}</span>
          ) : null}
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void save()}
            disabled={saving || loading || !dirty}
          >
            <Save className="mr-1.5 h-3.5 w-3.5" />
            {saving ? t('mediaChannels.saving') : t('mediaChannels.save')}
          </Button>
        </div>
      }
    >
      <SettingsCard>
        {problem ? (
          <div className="px-4 py-3 text-sm text-amber-600 dark:text-amber-400">{problem}</div>
        ) : null}

        {loading ? (
          <div className="px-4 py-3 text-sm text-muted-foreground">{t('mediaChannels.loading')}</div>
        ) : (
          <div>
            {/* Step one: a connection (provider, key, and the models it can reach). */}
            <div>
              <div className="flex items-center justify-between px-4 py-2.5">
                <span className="text-xs font-medium">{t('mediaChannels.connections')}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setAddingConnection(!addingConnection)}
                >
                  {addingConnection ? (
                    t('common.cancel')
                  ) : (
                    <>
                      <Plus className="mr-1 h-3.5 w-3.5" />
                      {t('mediaChannels.addConnection')}
                    </>
                  )}
                </Button>
              </div>

              {addingConnection ? (
                <div className="mx-4 mb-3 space-y-2 rounded-md border border-border/60 bg-muted/20 p-3">
                  <Label className="text-xs">{t('mediaChannels.provider')}</Label>
                  <div className="flex flex-wrap gap-1.5">
                    {providerGroups.map((group) => (
                      <button
                        key={group.id}
                        type="button"
                        className="flex items-center gap-2 rounded-md border border-border/60 bg-background px-2 py-1 text-xs hover:border-foreground/30 hover:bg-muted/40"
                        onClick={() => addConnection(group.id)}
                      >
                        <span className="max-w-[180px] truncate">{group.name}</span>
                        <span className="flex shrink-0 gap-1">
                          {group.kinds.map((kind) => (
                            <KindBadge key={kind} kind={kind} label={kindLabels[kind]} />
                          ))}
                        </span>
                      </button>
                    ))}
                    <button
                      type="button"
                      className="rounded-md border border-dashed border-border/70 px-2 py-1 text-xs text-muted-foreground hover:border-foreground/30 hover:text-foreground"
                      onClick={() => addConnection(CUSTOM_PRESET)}
                    >
                      {t('mediaChannels.custom')}
                    </button>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    {t('mediaChannels.addConnectionHint')}
                  </p>
                </div>
              ) : null}

              {drafts.length === 0 ? (
                <p className="px-4 py-3 text-xs text-muted-foreground">
                  {t('mediaChannels.noConnections')}
                </p>
              ) : (
                drafts.map((draft) => {
                  const open = openId === draft.id
                  const active = draft.endpoints.filter((entry) => entry.enabled)
                  const keyLabel =
                    draft.apiKey || draft.hasKey
                      ? t('mediaChannels.keyStored')
                      : draft.apiKeyEnv
                        ? t('mediaChannels.keyFromEnv', { name: draft.apiKeyEnv })
                        : t('mediaChannels.keyMissing')
                  return (
                    <div key={draft.id} className="border-t border-border/50 px-4 py-3">
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 text-left"
                        onClick={() => setOpenId(open ? null : draft.id)}
                      >
                        {open ? (
                          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        )}
                        <span className="min-w-0 truncate text-sm font-medium">
                          {draft.name || draft.id}
                        </span>
                        <span className="hidden shrink-0 items-center gap-1 sm:flex">
                          {active.map((entry) => (
                            <KindBadge key={entry.kind} kind={entry.kind} label={kindLabels[entry.kind]} />
                          ))}
                        </span>
                        {!draft.enabled ? (
                          <span className="shrink-0 rounded-full bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            {t('mediaChannels.disabled', { defaultValue: 'Disabled' })}
                          </span>
                        ) : null}
                        <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                          {keyLabel}
                        </span>
                      </button>
                      {open ? renderConnectionEditor(draft) : null}
                    </div>
                  )
                })
              )}
            </div>

            {/* The user's side: models added one at a time, each picked from a dropdown. */}
            {drafts.length === 0 ? null : KIND_ORDER.map((kind) => {
              const endpointsOf = drafts.flatMap((draft) => {
                const endpoint = draft.endpoints.find((entry) => entry.kind === kind && entry.enabled)
                return endpoint ? [{ draft, endpoint }] : []
              })
              const entries = endpointsOf.flatMap(({ draft, endpoint }) =>
                endpoint.enabledModels.map((model) => ({ draft, endpoint, model })),
              )
              const addable = endpointsOf.flatMap(({ draft, endpoint }) =>
                connectionModels(draft, kind)
                  .filter((model) => !endpoint.enabledModels.includes(model))
                  .map((model) => ({ draft, endpoint, model })),
              )
              // Rows stay clean with one account; the name appears only when a model must be told apart.
              const showConnection = connectionsForKind(kind).length > 1
              return (
                <div key={kind} className="border-t border-border/50">
                  <div className="flex items-center px-4 py-2.5">
                    <KindBadge kind={kind} label={kindLabels[kind]} className="px-2 py-0.5 text-[11px]" />
                  </div>

                  {entries.length === 0 && addable.length === 0 ? (
                    <p className="px-4 pb-3 text-xs text-muted-foreground">
                      {t('mediaChannels.noConnectionForKind')}
                    </p>
                  ) : null}

                  {entries.map(({ draft, endpoint, model }) => (
                    <div
                      key={`${draft.id}:${kind}:${model}`}
                      className="flex items-center gap-2 px-4 py-2"
                    >
                      <span className="min-w-0 flex-1 truncate text-sm">{model}</span>
                      {endpoint.modelProtocols[model] ? (
                        <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          {findMediaProtocol(endpoint.modelProtocols[model])?.name ??
                            endpoint.modelProtocols[model]}
                        </span>
                      ) : null}
                      {showConnection ? (
                        <span className="min-w-0 max-w-[45%] shrink truncate text-[11px] text-muted-foreground">
                          {draft.name || draft.preset || draft.id}
                        </span>
                      ) : null}
                      {!draft.enabled ? (
                        <span className="shrink-0 rounded-full bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          {t('mediaChannels.disabled', { defaultValue: 'Disabled' })}
                        </span>
                      ) : null}
                      <button
                        type="button"
                        className="shrink-0 text-muted-foreground hover:text-foreground disabled:opacity-30"
                        title={t('mediaChannels.moveUp')}
                        disabled={endpoint.enabledModels.indexOf(model) <= 0}
                        onClick={() => moveModel(draft, endpoint, model, -1)}
                      >
                        <ChevronUp className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        className="shrink-0 text-muted-foreground hover:text-foreground disabled:opacity-30"
                        title={t('mediaChannels.moveDown')}
                        disabled={
                          endpoint.enabledModels.indexOf(model) === endpoint.enabledModels.length - 1
                        }
                        onClick={() => moveModel(draft, endpoint, model, 1)}
                      >
                        <ChevronDown className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        className="shrink-0 text-muted-foreground hover:text-destructive"
                        title={t('mediaChannels.removeModel')}
                        onClick={() => toggleModel(draft, endpoint, model, false)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}

                  {addable.length > 0 ? (
                    <div className="px-4 pb-3">
                      <select
                        className={`${selectClass} h-8`}
                        value=""
                        onChange={(event) => {
                          const option = addable[Number(event.target.value)]
                          if (option) toggleModel(option.draft, option.endpoint, option.model, true)
                        }}
                      >
                        <option value="">{t('mediaChannels.chooseModels')}</option>
                        {addable.map(({ draft, model }, index) => (
                          <option key={`${draft.id}:${kind}:${model}`} value={String(index)}>
                            {showConnection ? `${draft.name || draft.id} · ${model}` : model}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        )}
      </SettingsCard>
    </SettingsSection>
  )
}
