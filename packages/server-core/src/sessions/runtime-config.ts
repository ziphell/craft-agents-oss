import type { AgentProvider, LlmAuthType } from '@craft-agent/shared/agent/backend'
import { isCompatProvider, modelSupportsImages, toCustomEndpointModels, type LlmConnection } from '@craft-agent/shared/config'
import type { FileAttachment } from '@craft-agent/shared/protocol'

export interface BackendRuntimeSignatureInput {
  connection: LlmConnection | null
  provider: AgentProvider
  authType?: LlmAuthType
  resolvedModel: string
}

export interface ModelAttachmentFilterResult {
  /** Attachments safe to pass to the model, or undefined when none remain. */
  attachments?: FileAttachment[]
  /** Image attachments intentionally omitted from the model payload. */
  omittedImages: FileAttachment[]
}

function definedObject<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined))
}

/**
 * Runtime-relevant shape of a connection's custom models, sorted for a stable
 * signature. Uses the shared projection so a newly supported per-model
 * parameter automatically drifts the signature (and therefore forces the
 * dispose + recreate path) instead of being silently ignored here.
 */
function normalizeCustomModels(connection: LlmConnection): unknown[] {
  return toCustomEndpointModels(connection.models)
    .map(entry => (typeof entry === 'string' ? { id: entry } : { ...entry }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * Build a stable signature over the fields that the `update_runtime_config`
 * IPC envelope cannot safely propagate to a live subprocess. When this
 * signature drifts, the in-place refresh path must be skipped in favour of
 * a clean dispose + recreate so the new auth/provider routing actually takes
 * effect.
 *
 * Concretely, `update_runtime_config` (see `pi-agent.ts:requestRuntimeConfigUpdate`
 * and the matching handler at `pi-agent-server/src/index.ts:handleUpdateRuntimeConfig`)
 * carries `model, providerType, authType, baseUrl, customEndpoint, customModels` —
 * but NOT `piAuthProvider`, and switching `slug`/`providerType`/`authType` mid-life
 * pulls in credential routing and provider-registry state the subprocess doesn't
 * fully reset on a runtime update.
 */
export function buildRestartRequiredSignature(input: BackendRuntimeSignatureInput): string {
  const { connection, provider, authType } = input
  return JSON.stringify(definedObject({
    provider,
    authType,
    slug: connection?.slug,
    providerType: connection?.providerType,
    piAuthProvider: connection?.piAuthProvider,
  }))
}

/**
 * Build a stable signature for config fields that affect an already-created
 * backend runtime. Metadata such as `lastUsedAt` is intentionally omitted.
 */
export function buildBackendRuntimeSignature(input: BackendRuntimeSignatureInput): string {
  const { connection, provider, authType, resolvedModel } = input

  const connectionShape = connection
    ? definedObject({
        slug: connection.slug,
        providerType: connection.providerType,
        authType: connection.authType,
        defaultModel: connection.defaultModel,
        fastModel: connection.fastModel,
        ...(isCompatProvider(connection.providerType)
          ? {
              baseUrl: connection.baseUrl,
              piAuthProvider: connection.piAuthProvider,
              customEndpoint: connection.customEndpoint
                ? definedObject({
                    api: connection.customEndpoint.api,
                    headers: connection.customEndpoint.headers,
                  })
                : undefined,
              models: normalizeCustomModels(connection),
            }
          : {}),
      })
    : null

  return JSON.stringify(definedObject({
    provider,
    authType,
    resolvedModel,
    connection: connectionShape,
  }))
}

export function isImageAttachment(attachment: Pick<FileAttachment, 'type' | 'mimeType'>): boolean {
  return attachment.type === 'image' || attachment.mimeType?.startsWith('image/') === true
}

/**
 * Enforce the saved image capability at send time. The session can still
 * persist/display image attachments, but they are not passed to a model whose
 * entry says `supportsImages: false` — even if an older subprocess still has
 * vision-capable registry state.
 *
 * The model entry is the only gate: it applies whatever the connection type,
 * and anything unset stays "supported" (see `modelSupportsImages`).
 */
export function filterAttachmentsForModelInput(
  attachments: FileAttachment[] | undefined,
  connection: LlmConnection | null,
  modelId: string,
): ModelAttachmentFilterResult {
  if (!attachments?.length) return { attachments, omittedImages: [] }
  if (!connection) return { attachments, omittedImages: [] }
  if (modelSupportsImages(connection, modelId)) return { attachments, omittedImages: [] }

  const modelAttachments: FileAttachment[] = []
  const omittedImages: FileAttachment[] = []

  for (const attachment of attachments) {
    if (isImageAttachment(attachment)) {
      omittedImages.push(attachment)
    } else {
      modelAttachments.push(attachment)
    }
  }

  return {
    attachments: modelAttachments.length > 0 ? modelAttachments : undefined,
    omittedImages,
  }
}
