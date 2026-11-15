/**
 * Handing a local file to a provider — the part every provider disagrees about.
 *
 * This is a desktop client: **it has no public URL**, so "here is my reference image" cannot be a
 * link we own. Three things are possible, and which one applies is the provider's business:
 *
 * 1. it accepts bytes → inline them as a `data:` URL;
 * 2. it accepts only `http(s)` → `POST` the bytes to its upload endpoint and use what it returns;
 * 3. it wants the asset reviewed first → upload, review, then use it.
 *
 * The canvas never learns which. It hands over a **file**, and whoever runs the job decides how to
 * carry it — which is why `data.inputs` on a node holds a path, not a URL.
 *
 * Failures are `MediaFailure` with a **layer**, because the four layers are four different problems:
 * re-uploading a rejected asset fixes nothing, and re-generating after a failed download throws away
 * work that already exists.
 */

export type MediaInputRole = 'reference' | 'first_frame' | 'last_frame'

export type MediaInput =
  | { kind: 'bytes'; bytes: Uint8Array; mimeType: string; filename?: string }
  /** Already a provider-acceptable URL — passed through, never re-uploaded. */
  | { kind: 'url'; url: string }

/** What a provider will accept in a request body. */
export type ProviderRef =
  | { kind: 'data-url'; value: string }
  | { kind: 'url'; value: string }
  | { kind: 'asset-id'; value: string }

export type FailureLayer = 'upload' | 'review' | 'generate' | 'transcribe' | 'download'

const LAYER_LABEL: Record<FailureLayer, string> = {
  upload: '上传失败',
  review: '审核不通过',
  generate: '生成失败',
  transcribe: '识别失败',
  download: '下载失败',
}

/**
 * A stable reason for failures that callers act on differently.
 *
 * The layer says *where* it failed; the code says *what* was wrong, so a UI can offer "fill in the
 * key" or "pick another model" instead of showing a provider sentence. Optional: an unclassified
 * failure is still a failure, and the detail remains the honest explanation.
 */
export type MediaFailureCode =
  | 'invalid_request'
  | 'missing_credentials'
  | 'missing_model'
  | 'unsupported'
  | 'provider_rejected'
  | 'rate_limited'
  | 'network'
  | 'timeout'
  | 'upload_failed'
  | 'review_failed'
  | 'download_failed'
  | 'cancelled'
  | 'unknown'

export interface MediaFailureOptions {
  code?: MediaFailureCode
  /** The request field this failure is about (`model`, `prompt`, `apiKey`, `inputs`…). */
  field?: string
  /** Whether asking again, unchanged, has a chance of succeeding. Defaults to false. */
  retryable?: boolean
  /** True when the provider may already be working — the request reached it, the answer did not. */
  uncertain?: boolean
  cause?: unknown
}

/**
 * A failed step, named by the layer it failed in.
 *
 * `data.error` on a canvas node starts with this label, so a person reads "下载失败：…" and knows
 * the picture exists somewhere — where a bare "generation failed" would have them pay for it twice.
 */
export class MediaFailure extends Error {
  readonly layer: FailureLayer
  readonly detail: string
  readonly code?: MediaFailureCode
  readonly field?: string
  readonly retryable: boolean
  readonly uncertain: boolean

  constructor(layer: FailureLayer, detail: string, options: MediaFailureOptions = {}) {
    super(`${LAYER_LABEL[layer]}：${detail}`)
    this.name = 'MediaFailure'
    this.layer = layer
    this.detail = detail
    this.code = options.code
    this.field = options.field
    this.retryable = options.retryable ?? false
    this.uncertain = options.uncertain ?? false
    if (options.cause !== undefined) this.cause = options.cause
  }
}

/** What one provider can do. Discovery is per provider, never per call. */
export interface MediaCapability {
  id: string
  provider: string
  modality: 'image' | 'video' | 'audio'
  /** Free-form parameter description the caller must satisfy; the provider owns it. */
  params?: Record<string, unknown>
  /** Rough price, when the provider can say one before spending. */
  estimate?: (params: Record<string, unknown>) => Promise<{ amount: number; unit: string }>
}
