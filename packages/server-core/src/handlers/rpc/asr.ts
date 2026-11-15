/**
 * Speech recognition, asked by a panel rather than by a conversation.
 *
 * The command is the agent's own (`asr_tool transcribe`), run through the same code: local or
 * cloud is the person's setting, so a panel gets the same answer a conversation would, and a
 * missing key or model names itself instead of the panel quietly choosing the other side. Decoding
 * still happens in a child process, never here.
 */

import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import {
  MODEL_MIRRORS,
  DOWNLOADABLE_MODELS,
  asrCloudProvider,
  asrConfigPath,
  asrModelChoice,
  asrModelRoot,
  asrVadAvailable,
  clearAsrCloudSecret,
  findDownloadableModel,
  localSherpaModels,
  modelInstalled,
  normalizeAsrConfig,
  readAsrCloudSecret,
  readAsrConfig,
  srtOf,
  writeAsrCloudSecret,
  writeAsrConfig,
  type AsrConfig,
  type ModelMirror,
} from '@craft-agent/shared/media'
import { validateFilePath, getWorkspaceAllowedDirs } from '@craft-agent/server-core/handlers'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import {
  cancelModelDownload,
  idleDownloadStatus,
  modelDownloadStatus,
  startModelDownload,
} from '../../services/model-download-job.ts'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.asr.CONFIG,
  RPC_CHANNELS.asr.CONFIG_SAVE,
  RPC_CHANNELS.asr.MODELS,
  RPC_CHANNELS.asr.DOWNLOAD,
  RPC_CHANNELS.asr.DOWNLOAD_STATUS,
  RPC_CHANNELS.asr.DOWNLOAD_CANCEL,
  RPC_CHANNELS.asr.TRANSCRIBE,
] as const

/**
 * Rebuild every session's tool list after recognition's setup changed.
 *
 * `asr_tool` is only offered once transcription can run — a local model is installed, or cloud
 * recognition is chosen — so saving the settings or finishing a model download changes which
 * tools the next list contains (lazy import: the agent modules are not part of this handler's own
 * dependencies).
 */
function refreshSessionTools(): void {
  void import('@craft-agent/shared/agent')
    .then((agent) => agent.invalidateAllSessionToolsCaches())
    .catch(() => {})
}

/**
 * One download per kind, kept after it stops so the page can read the outcome (see
 * `services/model-download-job.ts`). A hub downloads to the machine that will run `asr-tool`.
 */
export function registerAsrHandlers(server: RpcServer, deps: HandlerDeps): void {
  /**
   * The settings, what is wrong with them, and whether the cloud provider already has a key.
   *
   * The key itself never leaves the credential store; the wire it belongs to is fixed, so there is
   * no provider or model list to send.
   */
  server.handle(RPC_CHANNELS.asr.CONFIG, async () => {
    const { config, problem } = readAsrConfig()
    const provider = asrCloudProvider(config.cloud.provider)
    return {
      config,
      path: asrConfigPath(),
      problem,
      hasKey: provider ? Boolean(await readAsrCloudSecret(provider.id)) : false,
    }
  })

  /**
   * Write the settings back, and the cloud key when one was typed.
   *
   * A missing local model is accepted: the person may be pointing at a folder they are about to
   * fill, and `asr:models` is where "nothing is there yet" is reported. A cloud mode without a
   * provider is refused, because there is no wire to call.
   */
  server.handle(
    RPC_CHANNELS.asr.CONFIG_SAVE,
    async (
      _ctx,
      request: { config: AsrConfig; apiKey?: string; clearKey?: boolean },
    ) => {
      try {
        const config = normalizeAsrConfig(request?.config)
        const provider = asrCloudProvider(config.cloud.provider)
        if (config.mode === 'cloud' && !provider) {
          return { ok: false, message: '云端识别还没有选择服务商。' }
        }
        if (provider) {
          if (request?.clearKey === true) await clearAsrCloudSecret(provider.id)
          const typed = typeof request?.apiKey === 'string' ? request.apiKey.trim() : ''
          if (typed) await writeAsrCloudSecret(provider.id, typed)
        }
        const saved = writeAsrConfig(config)
        refreshSessionTools()
        return {
          ok: true,
          config: saved,
          hasKey: provider ? Boolean(await readAsrCloudSecret(provider.id)) : false,
        }
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        }
      }
    },
  )

  /** What this machine would transcribe with: the models it found, and which one answers. */
  server.handle(RPC_CHANNELS.asr.MODELS, async () => {
    const { config } = readAsrConfig()
    const root = asrModelRoot(config)
    const choice = asrModelChoice(config)
    return {
      root,
      models: localSherpaModels(root).map((model) => ({
        id: model.id,
        dir: model.dir,
      })),
      /** The model a transcription would use — the settings page shows it instead of offering a choice. */
      chosen: choice ? { id: choice.id } : null,
      vad: asrVadAvailable(config),
      /** What this app can fetch by itself, and whether it is already installed here. */
      downloads: DOWNLOADABLE_MODELS.filter((model) => model.kind === 'asr').map((model) => ({
        id: model.id,
        title: model.title,
        bytes: model.bytes,
        installed: modelInstalled(model, root),
      })),
      /** The hosts a download can come from — the page shows their names, not the URLs. */
      mirrors: MODEL_MIRRORS.map((mirror) => ({ id: mirror.id, label: mirror.label })),
    }
  })

  /**
   * Fetch a model into the directory `asr-tool` reads.
   *
   * Returns immediately with the job's first status: a 239 MB download outlives an RPC, so the
   * page polls `asr:download:status` rather than holding a request open for minutes.
   */
  server.handle(
    RPC_CHANNELS.asr.DOWNLOAD,
    async (_ctx, request: { modelId?: string; mirror?: ModelMirror }) => {
      const model = findDownloadableModel(request?.modelId)
      if (!model) {
        return {
          status: {
            ...idleDownloadStatus(),
            phase: 'failed' as const,
            message: `没有这个模型：${request?.modelId ?? ''}`,
          },
        }
      }

      const { config } = readAsrConfig()
      return {
        status: startModelDownload({
          model,
          root: asrModelRoot(config),
          ...(request?.mirror ? { mirror: request.mirror } : {}),
          // A finished model is what makes `asr_tool` offerable at all.
          onSettled: refreshSessionTools,
        }),
      }
    },
  )

  /** What the download is doing now. `idle` when this server has not downloaded since it started. */
  server.handle(RPC_CHANNELS.asr.DOWNLOAD_STATUS, async () => ({
    status: modelDownloadStatus('asr'),
  }))

  /** Stop it where it is; the partial file is removed and the next start begins again. */
  server.handle(RPC_CHANNELS.asr.DOWNLOAD_CANCEL, async () => ({
    status: cancelModelDownload('asr'),
  }))

  /**
   * A recording on this machine, read back as text and as subtitles.
   *
   * The answer is words, not a file, so the command prints JSON and this returns both shapes the
   * panel can save: the plain text, and an SRT body built from the same sentence timings. Where
   * the words end up is the caller's decision — the library writes them into `assets/`.
   *
   * This is the agent's command, not a second implementation of it: the person's local/cloud choice
   * applies here too. Choosing cloud is a decision to upload, so it is honoured; a missing key is
   * named rather than silently falling back to the machine.
   */
  server.handle(
    RPC_CHANNELS.asr.TRANSCRIBE,
    async (ctx, request: { audioPath: string; language?: string }) => {
      const workspaceId =
        ctx.workspaceId ?? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId!)
      const workspace = workspaceId ? getWorkspaceByNameOrId(workspaceId) : null
      const safePath = await validateFilePath(
        request.audioPath,
        getWorkspaceAllowedDirs(workspaceId, { sessionManager: deps.sessionManager }),
      )
      if (!safePath) return { ok: false, message: '找不到这个音频文件' }

      // Lazy: the agent modules are not part of this handler's own dependency graph.
      const { executeAsrToolCommand } = await import('@craft-agent/shared/agent/asr-commands')
      const run = await executeAsrToolCommand({
        command: [
          'transcribe',
          safePath,
          '--format',
          'json',
          ...(request.language ? ['--language', request.language] : []),
        ],
        ...(workspace?.rootPath ? { workspaceRootPath: workspace.rootPath } : {}),
      })
      const output = run.output.trim()
      if (output.startsWith('Error:')) {
        return { ok: false, message: output.replace(/^Error:\s*/, '') }
      }
      // The command answers with one envelope on both routes (`text`, `utterances`, `durationMs`),
      // so the panel reads local and cloud transcripts the same way. A sentence instead of the
      // envelope is an answer about the file ("no speech…"), not a failure to read it.
      if (!output.startsWith('{')) return { ok: true, text: '', srt: '' }

      try {
        const answer = JSON.parse(output) as {
          text?: string
          utterances?: Array<{ startMs: number; endMs: number; text: string }>
          durationMs?: number
          model?: string
        }
        const text = answer.text ?? ''
        return {
          ok: true,
          text,
          srt: srtOf({
            text,
            utterances: Array.isArray(answer.utterances) ? answer.utterances : [],
            ...(typeof answer.durationMs === 'number' ? { durationMs: answer.durationMs } : {}),
          }),
          ...(typeof answer.model === 'string' ? { model: answer.model } : {}),
        }
      } catch {
        return { ok: false, message: '转写没有返回可读的结果。' }
      }
    },
  )
}
