/**
 * What an S3-compatible bucket looks like as a setting — and nothing that needs a process.
 *
 * Kept apart from `object-storage.ts` so a settings page can import the shape, the vendor presets
 * and the validation without dragging `node:crypto` or the credential store into the renderer.
 */

export type ObjectStorageVendor =
  | 'aliyun'
  | 'tencent'
  | 'volcengine'
  | 'qiniu'
  | 'cloudflare'
  | 'aws'
  | 'custom'

export interface ObjectStorageConfig {
  /** Off by default: a bucket is a bill, so nothing is uploaded until someone says so. */
  enabled: boolean
  vendor: ObjectStorageVendor
  /** S3 endpoint, e.g. `https://s3.oss-cn-hangzhou.aliyuncs.com`. */
  endpoint: string
  /** Region, or `auto` for Cloudflare R2. */
  region: string
  bucket: string
  accessKeyId: string
  /** Object key prefix, without leading or trailing `/`. */
  keyPrefix: string
  /** `endpoint/bucket/key` instead of `bucket.endpoint/key`. */
  pathStyle: boolean
  /** Optional CDN or bucket domain; empty means the returned URL is presigned. */
  publicBaseUrl: string
}

/** Public shape returned to a settings page: the secret is only ever a boolean. */
export interface ObjectStorageSettings extends ObjectStorageConfig {
  hasSecret: boolean
}

export type ObjectStorageFailure =
  | 'config'
  | 'secret'
  | 'network'
  | 'auth'
  | 'bucket'
  | 'upload'
  | 'read'

export interface ObjectStorageTestResult {
  ok: boolean
  reason?: ObjectStorageFailure
  status?: number
  detail?: string
}

export const OBJECT_STORAGE_FILE = 'object-storage.json'
export const DEFAULT_KEY_PREFIX = 'craft-agent/references'

export const DEFAULT_OBJECT_STORAGE: ObjectStorageConfig = {
  enabled: false,
  vendor: 'volcengine',
  endpoint: '',
  region: '',
  bucket: '',
  accessKeyId: '',
  keyPrefix: DEFAULT_KEY_PREFIX,
  pathStyle: false,
  publicBaseUrl: '',
}

const VENDORS: readonly ObjectStorageVendor[] = [
  'volcengine',
  'aliyun',
  'tencent',
  'qiniu',
  'cloudflare',
  'aws',
  'custom',
]

/**
 * The endpoint a vendor derives from its one identifying field: a region for every S3-compatible
 * vendor here, an account id for Cloudflare. A custom vendor has no rule, so it answers `null`.
 *
 * All of them sign with AWS Signature V4; Volcengine TOS and Qiniu Kodo expose S3-compatible
 * endpoints for exactly that reason, so the same PUT and presigned GET work unchanged.
 */
export function vendorEndpoint(vendor: ObjectStorageVendor, identifier: string): string | null {
  const value = identifier.trim().toLowerCase()
  if (vendor === 'custom' || !/^[a-z0-9][a-z0-9-]*$/.test(value)) return null
  switch (vendor) {
    case 'aliyun':
      return `https://s3.oss-${value}.aliyuncs.com`
    case 'tencent':
      return `https://cos.${value}.myqcloud.com`
    case 'volcengine':
      return `https://tos-s3-${value}.volces.com`
    case 'qiniu':
      return `https://s3.${value}.qiniucs.com`
    case 'cloudflare':
      return `https://${value}.r2.cloudflarestorage.com`
    case 'aws':
      return `https://s3.${value}.amazonaws.com`
  }
}

/** An example region for the field, so the format is visible before anyone reads the docs. */
export function vendorRegionPlaceholder(vendor: ObjectStorageVendor): string {
  switch (vendor) {
    case 'aliyun':
      return 'cn-hangzhou'
    case 'tencent':
      return 'ap-guangzhou'
    case 'volcengine':
      return 'cn-beijing'
    case 'qiniu':
      return 'cn-east-1'
    case 'cloudflare':
      return 'auto'
    case 'aws':
      return 'us-east-1'
    default:
      return 'us-east-1'
  }
}

/** Vendors that require path-style addressing; the rest address by bucket host. */
export function vendorPathStyle(vendor: ObjectStorageVendor): boolean {
  return vendor === 'cloudflare'
}

/** The field a vendor uses as its identifier: an account id or a region. */
export function vendorIdentifierField(vendor: ObjectStorageVendor): 'accountId' | 'region' {
  return vendor === 'cloudflare' ? 'accountId' : 'region'
}

/** The identifier a saved config implies, for filling the form back in. */
export function identifierOf(config: ObjectStorageConfig): string {
  if (config.vendor === 'cloudflare') {
    return /^https:\/\/([a-z0-9-]+)\.r2\.cloudflarestorage\.com$/i.exec(config.endpoint)?.[1] ?? ''
  }
  if (config.vendor === 'custom') return ''
  return config.region
}

const textOf = (value: unknown, fallback: string): string =>
  typeof value === 'string' ? value : fallback

/** Whatever was read from a file or a form, as a config the rest of the code can trust. */
export function normalizeObjectStorage(input: unknown): ObjectStorageConfig {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const vendor = VENDORS.includes(raw.vendor as ObjectStorageVendor)
    ? (raw.vendor as ObjectStorageVendor)
    : DEFAULT_OBJECT_STORAGE.vendor
  return {
    enabled: raw.enabled === true,
    vendor,
    endpoint: textOf(raw.endpoint, '').trim().replace(/\/+$/, ''),
    region: textOf(raw.region, '').trim(),
    bucket: textOf(raw.bucket, '').trim(),
    accessKeyId: textOf(raw.accessKeyId, '').trim(),
    keyPrefix: textOf(raw.keyPrefix, DEFAULT_KEY_PREFIX)
      .trim()
      .replace(/\\/g, '/')
      .split('/')
      .filter(Boolean)
      .join('/'),
    pathStyle: raw.pathStyle === true,
    publicBaseUrl: textOf(raw.publicBaseUrl, '').trim().replace(/\/+$/, ''),
  }
}

const isHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value)
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    )
  } catch {
    return false
  }
}

/**
 * What is wrong with a config, if anything. `secret` is checked only when the caller has one to
 * check: saving a page without retyping the secret must not be refused.
 */
export function validateObjectStorage(
  config: ObjectStorageConfig,
  secret?: string | null,
): ObjectStorageFailure | null {
  if (!isHttpUrl(config.endpoint)) return 'config'
  if (!config.region) return 'config'
  if (!config.bucket) return 'config'
  if (!config.accessKeyId) return 'config'
  if (secret !== undefined && !secret) return 'secret'
  if (config.keyPrefix.split('/').some((segment) => segment === '.' || segment === '..')) {
    return 'config'
  }
  if (config.publicBaseUrl && !isHttpUrl(config.publicBaseUrl)) return 'config'
  return null
}
