/**
 * This machine's generators, asked by a panel rather than by a conversation.
 *
 * The card's ✨ used to open a session and ask an agent to run a tool. That is a lot of machinery
 * between a click and a picture, and it only works while an agent is awake. Here the caller says
 * what to run and where to put it, and the answer is the file that came out.
 *
 * The bytes stay on this side on purpose: a 4K PNG over a websocket is a worse answer than a path,
 * and the canvas that asked for it lives on this same filesystem.
 */

import { writeFile, mkdir } from 'fs/promises'
import { existsSync, readFileSync } from 'fs'
import { basename, dirname, join, resolve } from 'path'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import {
  advanceMediaTask,
  channelForKind,
  createMediaTask,
  dataUrlOfFile,
  bytesOfDataUrl,
  mimeOfFile,
  objectStorageUploader,
  endpointsOf,
  generateMedia,
  isChannelEnabled,
  mediaChannelKey,
  mediaChannelModel,
  mediaChannelForModel,
  mediaChannelsPath,
  DEFAULT_TASK_TIMEOUT_MS,
  modelMode,
  modelInfoOf,
  paramSpecsOf,
  videoEditProblem,
  withoutFixedDuration,
  clearMediaChannelSecret,
  probeChannelAccount,
  readMediaChannels,
  readMediaChannelSecret,
  readMediaTask,
  readObjectStorageConfig,
  readObjectStorageSecret,
  writeObjectStorageConfig,
  writeObjectStorageSecret,
  clearObjectStorageSecret,
  normalizeObjectStorage,
  validateObjectStorage,
  testObjectStorage,
  withStoredKey,
  withStoredKeys,
  withPreset,
  writeMediaChannelSecret,
  writeMediaChannels,
  writeMediaTask,
  GENERATION_CHANNEL_PRESETS,
  resolveMediaChannel,
  fileNameForMime,
  isSoundKind,
  mediaKindOfDeclaration,
  mediaSettingsPath,
  normalizeMediaSettings,
  readMediaSettings,
  writeMediaSettings,
  type MediaBodyShape,
  type MediaChannel,
  type MediaEndpoint,
  type MediaKind,
  type MediaSettings,
  type ObjectStorageConfig,
  type ObjectStorageFailure,
} from '@craft-agent/shared/media'
import { validateFilePath, getWorkspaceAllowedDirs } from '@craft-agent/server-core/handlers'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { startMediaTaskDriver, type MediaTaskDriver } from '../../services/media-task-driver.ts'
import { MediaFailure, type MediaFailureCode } from '@craft-agent/shared/media'
import {
  findProjectDir,
  toProjectPath,
  writeGenerationRecord,
} from '@craft-agent/shared/provenance/storage'
import type { GenerationRecord } from '@craft-agent/shared/provenance'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.media.GENERATE,
  RPC_CHANNELS.media.TASK,
  RPC_CHANNELS.media.RETRY,
  RPC_CHANNELS.media.CHANNELS,
  RPC_CHANNELS.media.CHANNELS_SAVE,
  RPC_CHANNELS.media.PROBE,
  RPC_CHANNELS.media.OBJECT_STORAGE,
  RPC_CHANNELS.media.OBJECT_STORAGE_SAVE,
  RPC_CHANNELS.media.OBJECT_STORAGE_TEST,
  RPC_CHANNELS.media.SETTINGS,
  RPC_CHANNELS.media.SETTINGS_SAVE,
] as const

/** One clock per process, however many clients register handlers. */
let taskDriver: MediaTaskDriver | null = null

export interface MediaGenerateRequest {
  /** Which configured account to use. Omitted means the first one. */
  channelId?: string
  model?: string
  prompt: string
  size?: string
  outPath: string
  timeoutMs?: number
  /** What the caller is making — decides which channel fills in when none is named. */
  kind?: MediaKind
  /** Per-card parameters (duration, resolution, ratio) chosen in the panel below the node. */
  params?: Record<string, string | number>
  /** Reference images as data URLs. */
  images?: string[]
  /** Video/audio references as data URLs. Carried by `content`-shaped async channels. */
  videos?: string[]
  audios?: string[]
  /** The first and last frame, as project-relative paths. Roles, not numbered references. */
  firstFrame?: string
  lastFrame?: string
  /**
   * The same references, as project-relative paths. Only used for the note written beside the
   * result — the bytes travel in `images`, because a provider needs them decoded.
   */
  references?: string[]
  /**
   * Paths that belong in the note but are not inputs.
   *
   * A music card's lyrics node and a picture's context node are provenance, not images: sending
   * their path as a reference would have a task upload a `.md` as an image.
   */
  provenance?: string[]
}

/** What a ✨ run answers: the file that came out, or the reason nothing did. */
export interface MediaGenerateReply {
  ok: boolean
  /** Where the result landed, when it landed at once or a task already produced it. */
  path?: string
  /** The task the caller can ask about later, for a channel that answers asynchronously. */
  taskId?: string
  providerTaskId?: string
  status?: string
  mimeType?: string
  byteLength?: number
  message?: string
  /** A stable reason a UI can act on, when the failure carried one. */
  code?: MediaFailureCode
  /** The request field the failure is about (`model`, `prompt`, `references`…). */
  field?: string
  retryable?: boolean
  /** The provider may already be working; do not resubmit blindly. */
  uncertain?: boolean
}

/** A model list as the page sends it: strings, trimmed, no repeats. */
function modelsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [
    ...new Set(
      value
        .filter((model): model is string => typeof model === 'string')
        .map((model) => model.trim())
        .filter(Boolean),
    ),
  ]
}

export function registerMediaHandlers(server: RpcServer, deps: HandlerDeps): void {
  /**
   * Leave the note that says what this file came from.
   *
   * The bytes are already on disk when this runs, so a note that cannot be written is a lost line
   * of history rather than a failed run: the picture is the answer, the note is how it is found
   * later. A file outside every project folder gets no note — there is no project to read it back.
   */
  function noteResult(filePath: string, record: Omit<GenerationRecord, 'file' | 'at'>): void {
    try {
      const projectDir = findProjectDir(filePath)
      if (!projectDir) return
      writeGenerationRecord(filePath, {
        ...record,
        file: toProjectPath(projectDir, filePath),
        at: Date.now(),
      })
    } catch (error) {
      deps.platform.logger.warn(
        'media: provenance note not written:',
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  server.handle(RPC_CHANNELS.media.CHANNELS, async () => {
    const { channels, problem } = readMediaChannels()
    // Recognition is configured under Settings › Speech, not here: `readMediaChannels` already
    // drops any transcription endpoint, so what is left is only what an account can generate.
    const generation = channels
      .map((channel) => ({ channel, endpoints: endpointsOf(channel) }))
      .filter((entry) => entry.endpoints.length > 0)
    const stored = await Promise.all(
      generation.map((entry) => readMediaChannelSecret(entry.channel.id)),
    )
    return {
      // Everything a settings page has to show to be usable — and **not** the key itself: the
      // renderer never needs it, and a key that travels for display travels further than it should.
      channels: generation.map(({ channel, endpoints: kept }, index) => {
        // One account may offer several capabilities; each carries its own models and choices.
        const endpoints = kept.map((endpoint) => {
          const capability = channelForKind(channel, endpoint.kind) ?? channel
          return {
            kind: endpoint.kind,
            // `models` is the catalog the connection can reach; `enabledModels` is what the agent
            // may use, chosen in the capability section.
            models: endpoint.models ?? [],
            enabledModels: capability.models,
            defaultModel: capability.defaultModel,
            // What the pane needs to label a model without duplicating the catalogue: its canonical
            // id and the rules it declared.
            modelInfo: modelInfoOf(capability, capability.models),
            modelCatalogId: endpoint.modelCatalogId,
            // Which models edit rather than generate, so the composer can hide the duration and
            // say what the editor expects.
            modelModes: capability.modelModes,
            options: capability.options,
            // The typed list wins; a capability that only has `options` gets an equivalent set of
            // selects, so the panel has one shape to render.
            paramSpecs: paramSpecsOf(capability),
            referenceLabels: capability.referenceLabels,
            params: capability.params,
            // The wire, shown and edited in the advanced area: enough to tell two capabilities of
            // one account apart without opening the JSON file.
            baseUrl: endpoint.baseUrl,
            submitPath: capability.submitPath,
            editPath: capability.editPath,
            pollPath: capability.pollPath,
            cancelPath: capability.cancelPath,
            taskIdPath: capability.taskIdPath,
            statusPath: capability.statusPath,
            resultPath: capability.resultPath,
            pollMs: capability.pollMs,
            bodyShape: capability.bodyShape,
            textRole: capability.textRole,
            submitHeaders: capability.submitHeaders,
            modelProtocols: endpoint.modelProtocols,
            modelWires: endpoint.modelWires,
            responseShape: capability.responseShape,
          }
        })
        const first = endpoints[0]
        return {
          id: channel.id,
          name: channel.name,
          protocol: channel.protocol,
          // The first capability answers the old single-kind questions; `endpoints` is the truth.
          kind: first?.kind ?? channel.kind,
          models: first?.models ?? channel.models,
          defaultModel: first?.defaultModel ?? channel.defaultModel,
          modelInfo: modelInfoOf(channel, first?.models ?? channel.models),
          endpoints,
          baseUrl: channel.baseUrl,
          submitPath: channel.submitPath,
          editPath: channel.editPath,
          apiKeyEnv: channel.apiKeyEnv,
          enabled: isChannelEnabled(channel),
          hasKey:
            Boolean(channel.apiKey) ||
            Boolean(channel.apiKeyEnv && process.env[channel.apiKeyEnv]) ||
            Boolean(stored[index]),
          preset: channel.preset,
          providerType: channel.providerType,
          modelIdSource: channel.modelIdSource,
          params: channel.params,
          // Account-wide wire settings: which header carries the key, and where references are
          // uploaded first. Kept beside the endpoints because they do not vary by kind.
          auth: channel.auth,
          upload: channel.upload,
        }
      }),
      // What a person can add without inventing an endpoint: the catalogue, as data.
      presets: GENERATION_CHANNEL_PRESETS.map((preset) => {
        const presetChannel = { ...preset, models: preset.models ?? [] } as MediaChannel
        return {
          id: preset.id,
          name: preset.name,
          protocol: preset.protocol,
          kind: preset.kind ?? endpointsOf(presetChannel)[0]?.kind,
          providerType: preset.providerType,
          modelIdSource: preset.modelIdSource,
          baseUrl: preset.baseUrl,
          models: preset.models ?? [],
          defaultModel: preset.defaultModel,
          // A capability list, so adding a multi-kind account fills every tab at once.
          endpoints: endpointsOf(presetChannel).map((endpoint) => {
            const capability = channelForKind(presetChannel, endpoint.kind) ?? presetChannel
            return {
              kind: endpoint.kind,
              models: capability.models,
              defaultModel: capability.defaultModel,
              modelInfo: modelInfoOf(capability, capability.models),
              paramSpecs: paramSpecsOf(capability),
              // The wire travels with the preset too: a connection made from several presets has to
              // save each capability's paths, because only one preset id can be named.
              baseUrl: endpoint.baseUrl,
              submitPath: capability.submitPath,
              editPath: capability.editPath,
              pollPath: capability.pollPath,
              cancelPath: capability.cancelPath,
              taskIdPath: capability.taskIdPath,
              statusPath: capability.statusPath,
              resultPath: capability.resultPath,
              pollMs: capability.pollMs,
              bodyShape: capability.bodyShape,
              textRole: capability.textRole,
              submitHeaders: capability.submitHeaders,
              modelProtocols: endpoint.modelProtocols,
              modelWires: endpoint.modelWires,
              responseShape: capability.responseShape,
            }
          }),
          // A new channel starts with the provider's own choices rather than blank rows.
          paramSpecs: paramSpecsOf(preset),
          modelInfo: modelInfoOf(presetChannel, preset.models ?? []),
          docs: preset.docs,
        }
      }),
      problem,
    }
  })

  /**
   * Ask an account, without generating anything, whether it is set up right.
   *
   * A draft may not be saved yet, so the request carries the fields the person just typed. Anything
   * absent falls back to the saved channel and then to its preset — the same precedence a generation
   * would see. The key is never returned; this only says whether one works.
   */
  server.handle(
    RPC_CHANNELS.media.PROBE,
    async (
      _ctx,
      request: {
        channelId?: string
        preset?: string
        protocol?: string
        kind?: MediaKind
        baseUrl?: string
        apiKey?: string
        apiKeyEnv?: string
        model?: string
      },
    ) => {
      const saved = request.channelId
        ? readMediaChannels().channels.find((channel) => channel.id === request.channelId)
        : undefined
      // `undefined` means "no new key was typed" → fall back to the stored one. An explicit empty
      // string means the person cleared the field, so the old key must not be used to answer.
      const typedKey = request.apiKey === undefined ? undefined : request.apiKey.trim()
      const channel = withPreset({
        id: request.channelId ?? 'draft',
        name: saved?.name ?? '',
        protocol: 'openai-image',
        baseUrl: request.baseUrl ?? saved?.baseUrl ?? '',
        apiKey: typedKey !== undefined ? (typedKey || undefined) : saved?.apiKey,
        apiKeyEnv: request.apiKeyEnv || saved?.apiKeyEnv,
        models: saved?.models ?? [],
        defaultModel: saved?.defaultModel,
        preset: request.preset ?? saved?.preset,
        auth: saved?.auth,
        kind: request.kind ?? saved?.kind,
      })
      const apiKey =
        typedKey !== undefined
          ? typedKey
          : mediaChannelKey(channel) || (await readMediaChannelSecret(channel.id)) || ''
      if (!apiKey) return { ok: false, reason: 'key' as const, models: [] }
      return probeChannelAccount({
        baseUrl: channel.baseUrl,
        apiKey,
        auth: channel.auth,
        model: request.model,
      })
    },
  )

  /**
   * The bucket that hosts reference files for providers that need a public URL.
   *
   * The secret is never returned; the page only learns whether one is stored.
   */
  server.handle(RPC_CHANNELS.media.OBJECT_STORAGE, async () => {
    const { config, problem } = readObjectStorageConfig()
    return {
      config: normalizeObjectStorage(config),
      hasSecret: Boolean(await readObjectStorageSecret()),
      problem,
    }
  })

  /**
   * Write the bucket settings back.
   *
   * `secretAccessKey` absent means "keep the stored one"; `clearSecret` means "forget it". Turning
   * storage on with a missing field or secret is refused here, because a half-configured bucket is
   * exactly the setting that would make a generation fail later with a less useful message.
   */
  server.handle(
    RPC_CHANNELS.media.OBJECT_STORAGE_SAVE,
    async (
      _ctx,
      request: {
        config: ObjectStorageConfig
        secretAccessKey?: string
        clearSecret?: boolean
      },
    ) => {
      const config = normalizeObjectStorage(request.config)
      const typed = request.secretAccessKey?.trim()
      const secret = request.clearSecret
        ? null
        : typed
          ? typed
          : await readObjectStorageSecret()
      if (config.enabled) {
        const issue = validateObjectStorage(config, secret)
        if (issue) {
          return {
            ok: false,
            reason: issue as ObjectStorageFailure,
            message:
              issue === 'secret'
                ? '对象存储已启用，但还没有保存 Secret Access Key。'
                : '对象存储已启用，但端点、区域、存储桶或 Access Key ID 不完整。',
          }
        }
      }
      try {
        writeObjectStorageConfig(config)
        if (request.clearSecret) await clearObjectStorageSecret()
        else if (typed) await writeObjectStorageSecret(typed)
        return { ok: true }
      } catch (error) {
        return {
          ok: false,
          reason: 'config' as ObjectStorageFailure,
          message: error instanceof Error ? error.message : String(error),
        }
      }
    },
  )

  /**
   * Save-and-test: upload a small probe, read it through the URL a provider would see, then remove
   * it. The request carries the draft config, so a person can test before saving.
   */
  server.handle(
    RPC_CHANNELS.media.OBJECT_STORAGE_TEST,
    async (
      _ctx,
      request: { config: ObjectStorageConfig; secretAccessKey?: string },
    ) => {
      const config = normalizeObjectStorage(request.config)
      const typed = request.secretAccessKey?.trim()
      const secret = typed === undefined ? ((await readObjectStorageSecret()) ?? '') : typed
      return testObjectStorage({ config, secret })
    },
  )

  /**
   * Write the channel list back.
   *
   * The settings page holds what it read and sends it back; a channel that arrives **without**
   * `apiKey` keeps the one already stored, because the key never went out to be sent back. A key
   * that arrives is written to the credential store and never to the JSON file; an empty string
   * means "forget it". An id left out of the list was deleted on purpose.
   *
   * A channel with no model or no key is refused rather than stored: the canvas would accept it and
   * then fail at the first ✨, which is a worse place to learn.
   */
  server.handle(
    RPC_CHANNELS.media.CHANNELS_SAVE,
    async (
      _ctx,
      request: {
        channels: Array<Record<string, unknown> & { id: string }>
      },
    ) => {
      const existing = readMediaChannels().channels
      const byId = new Map(existing.map((channel) => [channel.id, channel]))
      const problems: string[] = []
      const prepared: Array<{ id: string; channel: MediaChannel; typedKey?: string }> = []

      for (const incoming of request.channels) {
        if (typeof incoming?.id !== 'string' || incoming.id.length === 0) continue
        const previous = byId.get(incoming.id)
        const merged = { ...(previous ?? {}), ...incoming } as Record<string, unknown>
        const typedKey = typeof incoming.apiKey === 'string' ? incoming.apiKey.trim() : undefined
        if (typedKey !== undefined) delete merged.apiKey

        const models = modelsOf(merged.models)
        // An account may declare several capabilities. Each endpoint carries its own models;
        // a kind listed twice is the same capability saved twice, so the last one wins.
        const rawEndpoints = Array.isArray(merged.endpoints) ? merged.endpoints : undefined
        // The page edits models and choices, not the wire. Whatever the previous endpoint knew
        // about its paths stays, so saving a form never silently rewrites a hand-tuned endpoint.
        const previousEndpoints = previous?.endpoints ?? []
        const byKind = new Map<MediaKind, MediaEndpoint>()
        for (const raw of rawEndpoints ?? []) {
          if (!raw || typeof raw !== 'object') continue
          const endpoint = raw as Record<string, unknown>
          // A page saved while speech and music were still `audio` is read as the capability its
          // wire describes, so an old form cannot write a kind nothing can select.
          const kind = mediaKindOfDeclaration(
            endpoint.kind,
            typeof endpoint.bodyShape === 'string'
              ? (endpoint.bodyShape as MediaBodyShape)
              : undefined,
          )
          if (!kind) continue
          byKind.set(kind, {
            ...(previousEndpoints.find((candidate) => candidate.kind === kind) ?? {}),
            ...(endpoint as unknown as MediaEndpoint),
            kind,
            models: modelsOf(endpoint.models),
          })
        }
        const endpoints = rawEndpoints ? [...byKind.values()] : undefined
        const resolved = withPreset({
          ...(merged as unknown as MediaChannel),
          models,
          ...(endpoints ? { endpoints } : {}),
          protocol: 'openai-image',
          baseUrl: typeof merged.baseUrl === 'string' ? merged.baseUrl : '',
        })
        const name = resolved.name || resolved.id
        // A disabled account is kept but not used, so an incomplete one must not block saving the
        // accounts that are in use.
        const disabled = merged.enabled === false

        // A capability has to name at least one model — the preset may supply it when the person
        // left the list blank, which is why this is asked of the resolved endpoints.
        if (!disabled && endpoints) {
          const effective = endpointsOf(resolved)
          if (effective.length === 0) problems.push(`「${name}」没有声明任何能力`)
          for (const endpoint of effective) {
            if (!endpoint.models?.length) problems.push(`「${name}」的 ${endpoint.kind} 能力还没有模型`)
          }
        } else if (!disabled && resolved.models.length === 0) {
          problems.push(`「${name}」还没有模型`)
        } else if (!disabled && (!resolved.defaultModel || !resolved.models.includes(resolved.defaultModel))) {
          resolved.defaultModel = resolved.models[0]
        }

        const storedEndpoints = endpoints?.map((endpoint) => {
          const capability = channelForKind(resolved, endpoint.kind)
          const models = capability?.models ?? endpoint.models ?? []
          const defaultModel =
            endpoint.defaultModel && models.includes(endpoint.defaultModel)
              ? endpoint.defaultModel
              : models[0]
          return { ...endpoint, models: endpoint.models?.length ? endpoint.models : models, defaultModel }
        })

        const keyPresent =
          typedKey !== undefined
            ? typedKey.length > 0
            : Boolean(
                (typeof merged.apiKey === 'string' && merged.apiKey.trim()) ||
                  // An environment-variable name is an explicit statement that the key lives
                  // outside this file. Whether it is set here is the test button's question.
                  (typeof merged.apiKeyEnv === 'string' && merged.apiKeyEnv.trim()) ||
                  (await readMediaChannelSecret(incoming.id)),
              )
        if (!disabled && !keyPresent) problems.push(`「${name}」还没有密钥`)

        // Store what the page said plus the fields this handler normalized — not the whole resolved
        // channel: a preset must keep filling the paths and options it owns, so a vendor change
        // reaches existing channels instead of being frozen into the file by one save.
        const stored = {
          ...(merged as unknown as MediaChannel),
          name,
          protocol: resolved.protocol,
          kind: storedEndpoints?.[0]?.kind ?? resolved.kind,
          models: storedEndpoints?.[0]?.models ?? resolved.models,
          defaultModel: storedEndpoints?.[0]?.defaultModel ?? resolved.defaultModel,
        } as MediaChannel
        // Only an explicit "off" is written: an absent flag means enabled, and keeping `true` out
        // of the file keeps channels written before this field existed identical to new ones.
        if (merged.enabled === false) stored.enabled = false
        else delete stored.enabled
        if (storedEndpoints?.length) stored.endpoints = storedEndpoints
        else delete stored.endpoints
        prepared.push({ id: incoming.id, typedKey, channel: stored })
      }

      if (problems.length > 0) {
        return { ok: false, message: problems.join('；') }
      }

      for (const item of prepared) {
        if (item.typedKey === undefined) continue
        if (item.typedKey) await writeMediaChannelSecret(item.id, item.typedKey)
        else await clearMediaChannelSecret(item.id)
      }
      // A channel deleted from the page is a channel deleted from the machine — its key included,
      // rather than left behind in the credential store with no account to belong to.
      const kept = new Set(prepared.map((item) => item.id))
      for (const channel of existing) {
        if (!kept.has(channel.id)) await clearMediaChannelSecret(channel.id)
      }
      writeMediaChannels(prepared.map((item) => item.channel))
      // `media_tool`'s brief names the kinds this machine can actually make. A save changes that
      // sentence, so the next tool list must be built from the new file rather than the cached one
      // (lazy import: the agent modules are not part of this handler's own dependencies).
      void import('@craft-agent/shared/agent')
        .then((agent) => agent.invalidateAllSessionToolsCaches())
        .catch(() => {})
      return { ok: true, count: prepared.length }
    },
  )

  /**
   * ✨ on a card: draw it through a channel and put the file where the canvas can see it.
   *
   * The caller never sees the bytes. It sees a path — because the canvas, the file and the picture
   * are on this machine, and a 4K PNG over a websocket is a worse answer than a filename.
   */
  server.handle(
    RPC_CHANNELS.media.GENERATE,
    async (ctx, request: MediaGenerateRequest): Promise<MediaGenerateReply> => {
      const workspaceId =
        ctx.workspaceId ?? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId!)
      const named = request.channelId
        ? readMediaChannels().channels.find((candidate) => candidate.id === request.channelId)
        : undefined
      // Naming a turned-off account is not a way around turning it off: say so instead of running.
      if (named && !isChannelEnabled(named)) {
        return {
          ok: false,
          message: `渠道「${named.name}」已停用：在设置里启用它，或换一个渠道。`,
        }
      }
      const resolved = resolveMediaChannel(request.channelId, request.kind, request.model)
      const channel = resolved ? await withStoredKey(resolved) : null
      if (!channel) {
        // A named account that exists but does not make this kind is a different answer from no
        // account at all — the person picks another kind instead of writing a new channel.
        return {
          ok: false,
          message: named
            ? `渠道「${named.name}」不提供${request.kind ?? '这种'}内容：换一个渠道，或在设置里给它加上这项能力。`
            : `没有可用的生成渠道。在 ${mediaChannelsPath()} 里写一个，例如：` +
              ' {"channels": [{"id": "relay", "name": "中转", "protocol": "openai-image", ' +
              '"baseUrl": "https://api.example.com/v1", "apiKeyEnv": "MY_IMAGE_KEY", ' +
              '"models": ["image-model"], "defaultModel": "image-model"}]}',
        }
      }
      // A video-edit model is given the clip it edits: exactly one video, and a length it keeps.
      // Refused before a task file is written or a provider is called.
      const effectiveModel = mediaChannelModel(channel, request.model)
      // The model decides whether this is a task: Wan queues one where Qwen-Image answers now,
      // inside the same capability. Asking the capability would wait for a job instead of handing
      // back its task id.
      const effective = mediaChannelForModel(channel, effectiveModel)
      const mode = modelMode(channel, effectiveModel)
      if (mode === 'video-edit') {
        const problem = videoEditProblem({
          videos: request.videos?.length ?? 0,
          images: request.images?.length ?? 0,
          audios: request.audios?.length ?? 0,
          frames: (request.firstFrame ? 1 : 0) + (request.lastFrame ? 1 : 0),
        })
        if (problem === 'needs-one-video') {
          return { ok: false, message: `「${channel.name}」的视频编辑模型需要且只需要一个视频输入。` }
        }
        if (problem === 'video-only') {
          return {
            ok: false,
            message: `「${channel.name}」的视频编辑模型只接收一个视频，不能再带图片、音频或首尾帧。`,
          }
        }
      }
      const params =
        request.params && mode === 'video-edit'
          ? withoutFixedDuration(request.params, mode)
          : request.params
      try {
        const safePath = await validateFilePath(
          request.outPath,
          getWorkspaceAllowedDirs(workspaceId, { sessionManager: deps.sessionManager }),
        )
        const projectDir = findProjectDir(safePath) ?? dirname(safePath)

        // A channel with a poll path answers with a task id. The caller gets that answer now and
        // the file later — a three-minute clip must not hold a request, or the panel that asked.
        if (effective.pollPath) {
          const task = createMediaTask({
            outPath: safePath,
            channelId: channel.id,
            kind: channel.kind ?? request.kind ?? 'image',
            prompt: request.prompt,
            // The caller names references the way the project does; a task stores where they are.
            references: (request.references ?? []).map((reference) => resolve(projectDir, reference)),
            // A text port is provenance, not an input: a task must not upload a `.md` as an image.
            provenance: (request.provenance ?? []).map((reference) => resolve(projectDir, reference)),
            ...(request.firstFrame ? { firstFrame: resolve(projectDir, request.firstFrame) } : {}),
            ...(request.lastFrame ? { lastFrame: resolve(projectDir, request.lastFrame) } : {}),
            model: request.model,
            size: request.size,
            params,
            // `timeoutMs` is how long this call may wait, not how long the job may live: a video
            // task keeps the runner's default deadline, or the panel's 3-minute HTTP timeout would
            // kill it mid-flight.
            channel,
          })
          writeMediaTask(task)
          const step = await advanceMediaTask(task, {
            channels: await withStoredKeys(readMediaChannels().channels),
          })
          if (
            step.task.status === 'failed' ||
            step.task.status === 'submission_unknown'
          ) {
            return {
              ok: false,
              taskId: step.task.id,
              message:
                step.task.error ??
                (step.task.status === 'submission_unknown'
                  ? '提交结果未知：供应商可能已经在处理，先查询原任务再决定是否重提。'
                  : '生成任务没有开始'),
            }
          }
          return {
            ok: true,
            // A one-step task may have already landed, possibly renamed to its real container.
            path: step.artifact?.path ?? safePath,
            taskId: step.task.id,
            status: step.task.status,
            ...(step.artifact
              ? { mimeType: step.artifact.mimeType, byteLength: step.artifact.byteLength }
              : {}),
            message: `${channel.protocol}:task`,
          }
        }

        // A provider that only reads `http(s)` needs the reference hosted; inline bytes stay the
        // fallback when no bucket is configured. The renderer sends local files as data URLs, so
        // both shapes arrive here and both are turned into what the channel can consume.
        const host = await objectStorageUploader()
        const deliver = async (reference: string): Promise<string> => {
          if (!host) return reference
          const inline = bytesOfDataUrl(reference)
          return inline ? host(inline) : reference
        }
        const deliverPath = async (filePath: string): Promise<string> => {
          if (!host) return dataUrlOfFile(filePath)
          return host({
            bytes: new Uint8Array(readFileSync(filePath)),
            mimeType: mimeOfFile(filePath),
            filename: basename(filePath),
          })
        }
        const result = await generateMedia({
          channel,
          prompt: request.prompt,
          ...(request.kind ? { kind: request.kind } : {}),
          model: request.model,
          size: request.size,
          params,
          ...(request.images?.length
            ? { images: await Promise.all(request.images.map(deliver)) }
            : {}),
          ...(request.videos?.length
            ? { videos: await Promise.all(request.videos.map(deliver)) }
            : {}),
          ...(request.audios?.length
            ? { audios: await Promise.all(request.audios.map(deliver)) }
            : {}),
          ...(request.firstFrame
            ? { firstFrame: await deliverPath(resolve(projectDir, request.firstFrame)) }
            : {}),
          ...(request.lastFrame
            ? { lastFrame: await deliverPath(resolve(projectDir, request.lastFrame)) }
            : {}),
          timeoutMs: request.timeoutMs,
        })
        // The bytes decide the container: a speech or music channel may answer with wav while the
        // card asked for mp3. The caller reads the path back from this answer, so naming it
        // correctly here is what makes the file openable.
        const outPath = isSoundKind(channel.kind)
          ? fileNameForMime(safePath, result.mimeType)
          : safePath
        await mkdir(dirname(outPath), { recursive: true })
        await writeFile(outPath, result.bytes)
        noteResult(outPath, {
          prompt: request.prompt,
          references: [...(request.references ?? []), ...(request.provenance ?? [])],
          ...(request.firstFrame ? { firstFrame: request.firstFrame } : {}),
          ...(request.lastFrame ? { lastFrame: request.lastFrame } : {}),
          channel: channel.name,
          model: mediaChannelModel(channel, request.model) || undefined,
          params,
        })
        return {
          ok: true,
          path: outPath,
          providerTaskId: result.providerTaskId,
          mimeType: result.mimeType,
          byteLength: result.bytes.byteLength,
          message: result.via,
        }
      } catch (error) {
        const failure = error instanceof MediaFailure ? error : null
        const message = failure
          ? failure.message
          : error instanceof Error
            ? error.message
            : String(error)
        deps.platform.logger.error('media:generate failed:', message)
        return {
          ok: false,
          message,
          ...(failure?.code ? { code: failure.code } : {}),
          ...(failure?.field ? { field: failure.field } : {}),
          ...(failure?.retryable ? { retryable: true } : {}),
          ...(failure?.uncertain ? { uncertain: true } : {}),
        }
      }
    },
  )

  /** What the task behind this file is doing — the question a reopened board asks. */
  server.handle(RPC_CHANNELS.media.TASK, async (ctx, outPath: string) => {
    const workspaceId =
      ctx.workspaceId ?? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId!)
    try {
      const safePath = await validateFilePath(
        outPath,
        getWorkspaceAllowedDirs(workspaceId, { sessionManager: deps.sessionManager }),
      )
      const task = readMediaTask(safePath)
      // A renamed artifact is not at the path that was asked for; the task knows where it went.
      return { task, artifact: existsSync(task?.finalPath ?? safePath) }
    } catch {
      return { task: null, artifact: false }
    }
  })

  /**
   * Start a failed or cancelled task again from the request its file holds.
   *
   * `submission_unknown` is refused: the provider may already be working, and resubmitting is how
   * a person pays twice. A task that is still running has nothing to restart.
   */
  server.handle(RPC_CHANNELS.media.RETRY, async (ctx, outPath: string) => {
    const workspaceId =
      ctx.workspaceId ?? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId!)
    try {
      const safePath = await validateFilePath(
        outPath,
        getWorkspaceAllowedDirs(workspaceId, { sessionManager: deps.sessionManager }),
      )
      const task = readMediaTask(safePath)
      if (!task) return { ok: false, message: '没有找到这条任务。' }
      if (task.status === 'submission_unknown') {
        return {
          ok: false,
          message: '提交结果未知：供应商可能已经在处理，先确认再重提。',
        }
      }
      if (task.status !== 'failed' && task.status !== 'cancelled') {
        return { ok: false, message: '这条任务还在跑，不需要重试。' }
      }
      const now = Date.now()
      const restarted = writeMediaTask(
        {
          ...task,
          status: 'queued',
          providerTaskId: undefined,
          // Nothing is with the provider yet, so stopping it is real again.
          cancellable: true,
          finalPath: undefined,
          detached: undefined,
          attempts: 0,
          error: undefined,
          nextPollAt: undefined,
          updatedAt: now,
          expiresAt: now + DEFAULT_TASK_TIMEOUT_MS,
        },
        now,
      )
      const step = await advanceMediaTask(restarted, {
        channels: await withStoredKeys(readMediaChannels().channels),
      })
      if (step.task.status === 'failed' || step.task.status === 'submission_unknown') {
        return {
          ok: false,
          taskId: step.task.id,
          message: step.task.error ?? '重试没有开始。',
        }
      }
      return {
        ok: true,
        taskId: step.task.id,
        status: step.task.status,
        path: step.artifact?.path ?? task.outPath,
      }
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  })

  /** The person's choices: what the agent may generate, and where speech runs. */
  server.handle(RPC_CHANNELS.media.SETTINGS, async () => {
    const { settings, problem } = readMediaSettings()
    return { settings, path: mediaSettingsPath(), problem }
  })

  /**
   * Write those choices back.
   *
   * A named synthesis account is checked against the accounts on disk before it is saved: naming an
   * account that cannot speak would store a setting that fails at the first sentence, and the
   * reason belongs here rather than in a failed run later.
   */
  server.handle(
    RPC_CHANNELS.media.SETTINGS_SAVE,
    async (_ctx, request: { settings: MediaSettings }) => {
      try {
        const settings = normalizeMediaSettings(request?.settings)
        const channels = readMediaChannels().channels
        // Only a *named* channel is checked. An empty one means "the first account that can",
        // resolved when the work runs — a person may save the choice before adding the account.
        const choice = settings.speech.tts
        if (choice.channelId) {
          const found = channels.find(
            (channel) =>
              channel.id === choice.channelId &&
              isChannelEnabled(channel) &&
              channelForKind(channel, 'tts'),
          )
          if (!found) {
            return {
              ok: false,
              message: `渠道「${choice.channelId}」没有可用的语音合成能力：换一个，或留空表示用第一个可用账号。`,
            }
          }
          const models = channelForKind(found, 'tts')?.models ?? []
          if (choice.model && models.length > 0 && !models.includes(choice.model)) {
            return {
              ok: false,
              message: `渠道「${found.name}」的语音合成模型里没有「${choice.model}」。可选：${models.join(' / ')}。`,
            }
          }
        }
        writeMediaSettings(settings)
        return { ok: true, settings }
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        }
      }
    },
  )

  // One clock per process, however many clients register handlers: a task that is waiting for a
  // provider has no request to belong to, so something has to keep asking on its behalf.
  if (!taskDriver) taskDriver = startMediaTaskDriver(server, deps.platform.logger)
}
